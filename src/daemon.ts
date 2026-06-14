// Long-running daemon: listens for a global hotkey and, on press, wakes the TV
// and switches it to the PC input. Run with: npm run daemon
//
// Hotkey:
//   macOS    -> Cmd + Ctrl + E
//   Win/Linux-> Ctrl + Alt + E
//
// macOS note: global key capture needs Accessibility permission. The first run
// will prompt (or grant it under System Settings → Privacy & Security →
// Accessibility for your terminal app), otherwise no key events arrive.

import "./node-compat.js"; // must load before node-global-key-listener (see file)
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  GlobalKeyboardListener,
  type IGlobalKeyEvent,
  type IGlobalKeyDownMap,
} from "node-global-key-listener";
import { run, turnOff } from "./index.js";
import { watchPower } from "./sleep-watch.js";

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
const COMBO_LABEL = isMac ? "Cmd+Ctrl+E" : "Ctrl+Alt+E";

/** Cooldown after a trigger so key auto-repeat / a held combo can't double-fire. */
const COOLDOWN_MS = 1500;
let busy = false;

const stamp = () => new Date().toLocaleTimeString();

async function trigger(): Promise<void> {
  if (busy) return;
  busy = true;
  console.log(`\n[${stamp()}] ${COMBO_LABEL} → waking TV and switching to PC...`);
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

/** On PC sleep: turn the TV off (only if it's on the PC input). Shares the busy guard. */
async function onSuspend(): Promise<void> {
  if (busy) return;
  busy = true;
  console.log(`\n[${stamp()}] PC entering sleep → checking TV...`);
  try {
    await turnOff();
  } catch (err) {
    console.error(`[${stamp()}] failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    setTimeout(() => {
      busy = false;
    }, COOLDOWN_MS);
  }
}

/** On PC resume from sleep: wake the TV and switch it to PC (no-op if already on). */
async function onResume(): Promise<void> {
  if (busy) return;
  busy = true;
  console.log(`\n[${stamp()}] PC resumed from sleep → waking TV and switching to PC...`);
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

/** True when the configured combo is fully held and "E" is the key going down. */
function isHotkey(e: IGlobalKeyEvent, down: IGlobalKeyDownMap): boolean {
  if (e.state !== "DOWN" || e.name !== "E") return false;
  const ctrl = Boolean(down["LEFT CTRL"] || down["RIGHT CTRL"]);
  const alt = Boolean(down["LEFT ALT"] || down["RIGHT ALT"]);
  const meta = Boolean(down["LEFT META"] || down["RIGHT META"]);
  return isMac ? meta && ctrl : ctrl && alt;
}

async function main(): Promise<void> {
  ensureKeyServerExecutable();
  const keyboard = new GlobalKeyboardListener();

  await keyboard.addListener((e, down) => {
    if (isHotkey(e, down)) void trigger();
  });

  console.log(`TV daemon running. Press ${COMBO_LABEL} to wake the TV and switch to PC.`);

  // Opt-in: react to the PC sleeping (--tv_off) and/or resuming (--tv_on). Both ride the same
  // Windows power-event subscription, so one watcher covers either or both flags.
  const args = process.argv.slice(2);
  const tvOff = args.includes("--tv_off");
  const tvOn = args.includes("--tv_on");
  
  let stopPowerWatch: () => void = () => {};
  if (tvOff || tvOn) {
    stopPowerWatch = watchPower({
      onSuspend: tvOff ? () => void onSuspend() : undefined,
      onResume: tvOn ? () => void onResume() : undefined,
    });
    if (tvOff) console.log("Watching for PC sleep — will turn the TV off when it's on the PC input.");
    if (tvOn) console.log("Watching for PC resume — will wake the TV and switch to PC on wake.");
  }

  console.log("Press Ctrl+C to quit.");

  const shutdown = () => {
    stopPowerWatch();
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
