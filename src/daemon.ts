// Long-running daemon: listens for global hotkeys and acts on the TV. Run with: npm run daemon
//
// Hotkeys:
//   Wake TV + switch to PC      macOS -> Cmd+Ctrl+E    Win/Linux -> Ctrl+Alt+E
//   Turn TV off + sleep this PC macOS -> Cmd+Ctrl+Q    Win/Linux -> Ctrl+Alt+Q
//
// The off+sleep hotkey turns the TV off, waits 2s, then puts this PC to sleep.
//
// macOS note: global key capture needs Accessibility permission. The first run
// will prompt (or grant it under System Settings → Privacy & Security →
// Accessibility for your terminal app), otherwise no key events arrive.

import "./node-compat.js"; // must load before node-global-key-listener (see file)
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import os from "node:os";
import {
  GlobalKeyboardListener,
  type IGlobalKeyEvent,
  type IGlobalKeyDownMap,
} from "node-global-key-listener";
import { run, turnOff } from "./index.js";
import { sleepPc } from "./pc-sleep.js";
import { watchWake } from "./wake-watch.js";

/**
 * The listener ships an unexecutable helper binary; npm drops the +x bit. If the
 * initial spawn fails, the library falls back to chmod-via-`sudo-prompt`, which pops
 * an admin dialog. We own the file, so just set +x ourselves (no sudo) up front.
 * Best-effort: on failure the library's own fallback still applies.
 */
function ensureKeyServerExecutable(): void {
  if (process.platform === "win32") return; // .exe needs no chmod
  const binary = process.platform === "darwin" ? "MacKeyServer" : "X11KeyServer";
  try {
    const require = createRequire(import.meta.url);
    let root: string;
    try {
      root = dirname(require.resolve("node-global-key-listener/package.json"));
    } catch {
      // entry resolves to <root>/build/index.js → package root is two levels up.
      root = dirname(dirname(require.resolve("node-global-key-listener")));
    }
    const binPath = join(root, "bin", binary);
    if (existsSync(binPath)) chmodSync(binPath, 0o755);
  } catch {
    /* best-effort */
  }
}

const isMac = process.platform === "darwin";
const ON_COMBO_LABEL = isMac ? "Cmd+Ctrl+E" : "Ctrl+Alt+E";
const OFF_COMBO_LABEL = isMac ? "Cmd+Ctrl+Q" : "Ctrl+Alt+Q";

/** Delay between turning the TV off and putting the PC to sleep. */
const OFF_TO_SLEEP_MS = 2000;

/**
 * Cooldown after a trigger finishes. A new trigger is ignored while a handler is
 * running or within this window afterwards — so commands fire at most once per ~2s
 * and key auto-repeat / a held combo can't double-fire. Each handler still makes
 * all of its own API calls without delay; only re-triggering is rate-limited.
 */
const COOLDOWN_MS = 2000;
let busy = false;

const stamp = () => new Date().toLocaleTimeString();

/** Wake the TV and switch it to the PC input (Cmd/Ctrl + E). */
async function triggerOn(): Promise<void> {
  if (busy) {
    console.log(`[${stamp()}] ${ON_COMBO_LABEL} ignored — a command is still running (max 1 per ${COOLDOWN_MS}ms).`);
    return;
  }
  busy = true;
  console.log(`\n[${stamp()}] ${ON_COMBO_LABEL} → waking TV and switching to PC...`);
  try {
    await run();
  } catch (err) {
    console.error(`[${stamp()}] failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    setTimeout(() => {
      busy = false;
    }, COOLDOWN_MS);
  }
}

/** Turn the TV off, wait 2s, then put this PC to sleep (Cmd/Ctrl + Q). */
async function triggerOffAndSleep(): Promise<void> {
  if (busy) {
    console.log(`[${stamp()}] ${OFF_COMBO_LABEL} ignored — a command is still running (max 1 per ${COOLDOWN_MS}ms).`);
    return;
  }
  busy = true;
  console.log(`\n[${stamp()}] ${OFF_COMBO_LABEL} → turning TV off, then sleeping this PC...`);
  try {
    await turnOff();
    await new Promise<void>((r) => setTimeout(r, OFF_TO_SLEEP_MS));
    console.log(`[${stamp()}] Putting this PC to sleep...`);
    await sleepPc();
  } catch (err) {
    console.error(`[${stamp()}] failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    setTimeout(() => {
      busy = false;
    }, COOLDOWN_MS);
  }
}

/** True when the configured modifiers are held and `key` is the key going down. */
function isHotkey(e: IGlobalKeyEvent, down: IGlobalKeyDownMap, key: string): boolean {
  if (e.state !== "DOWN" || e.name !== key) return false;
  const ctrl = Boolean(down["LEFT CTRL"] || down["RIGHT CTRL"]);
  const alt = Boolean(down["LEFT ALT"] || down["RIGHT ALT"]);
  const meta = Boolean(down["LEFT META"] || down["RIGHT META"]);
  return isMac ? meta && ctrl : ctrl && alt;
}

async function main(): Promise<void> {
  ensureKeyServerExecutable();
  const keyboard = new GlobalKeyboardListener();

  await keyboard.addListener((e, down) => {
    if (isHotkey(e, down, "E")) void triggerOn();
    else if (isHotkey(e, down, "Q")) void triggerOffAndSleep();
  });

  // If the daemon started right after the machine powered on (e.g. launched as a
  // boot/login item), the PC's wake happened before any tick existed, so watchWake
  // can't detect it. Reconcile once: ensure the TV is on and on PC input.
  // os.uptime() is seconds since system boot (not process start), cross-platform.
  const BOOT_WINDOW_S = 120;
  if (os.uptime() < BOOT_WINDOW_S) {
    console.log(`\n[${stamp()}] Daemon started near boot → waking TV if it was off...`);
    void triggerOn(); // powers on only if off, then switches to PC input
  }

  const stopWake = watchWake({
    onResume: (sleptMs) => {
      const mins = Math.round(sleptMs / 60_000);
      console.log(`\n[${stamp()}] PC woke from sleep (~${mins} min) → waking TV if it was off...`);
      void triggerOn(); // run() powers on only if off, then switches to PC input
    },
  });

  console.log("TV daemon running.");
  console.log(`  ${ON_COMBO_LABEL}  → wake the TV and switch to PC`);
  console.log(`  ${OFF_COMBO_LABEL}  → turn the TV off, then sleep this PC`);
  console.log("  Auto-wakes the TV when this PC resumes from sleep.");
  console.log("Press Ctrl+C to quit.");

  const shutdown = () => {
    stopWake();
    keyboard.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive indefinitely.
  process.stdin.resume();
}

main().catch((err: unknown) => {
  console.error(`\nDaemon error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
