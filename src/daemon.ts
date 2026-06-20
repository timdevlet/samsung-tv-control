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

import "./os/node-compat.js"; // must load before node-global-key-listener (see file)
import { run, turnOff } from "./index.js";
import { matchHotkey, isWithinBootWindow, TriggerGate, type Platform } from "./domain/daemon.js";
import { startKeyListener } from "./os/key-listener.js";
import { onWake } from "./os/wake-watch.js";
import { sleepPc, uptimeSeconds } from "./os/pc-sleep.js";
import { log, logError, useTimestamps } from "./log.js";

const isMac = process.platform === "darwin";
const PLATFORM: Platform = isMac ? "mac" : "other";
const ON_COMBO_LABEL = isMac ? "Cmd+Ctrl+E" : "Ctrl+Alt+E";
const OFF_COMBO_LABEL = isMac ? "Cmd+Ctrl+Q" : "Ctrl+Alt+Q";

/** Delay between turning the TV off and putting the PC to sleep. */
const OFF_TO_SLEEP_MS = 2000;

/**
 * Cooldown after a trigger finishes. A new trigger is ignored while a handler is running or
 * within this window afterwards — so commands fire at most once per ~2s and key auto-repeat /
 * a held combo can't double-fire. Each handler still makes all of its own API calls without
 * delay; only re-triggering is rate-limited.
 */
const COOLDOWN_MS = 2000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  useTimestamps();
  const gate = new TriggerGate(COOLDOWN_MS);

  /** Wake the TV and switch it to the PC input (Cmd/Ctrl + E). */
  async function triggerOn(): Promise<void> {
    if (!gate.tryAcquire(Date.now())) {
      log(`${ON_COMBO_LABEL} ignored — a command is still running (max 1 per ${COOLDOWN_MS}ms).`);
      return;
    }
    log(`\n${ON_COMBO_LABEL} → waking TV and switching to PC...`);
    try {
      await run();
    } catch (e) {
      logError(`failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      gate.release(Date.now());
    }
  }

  /** Turn the TV off, wait 2s, then put this PC to sleep (Cmd/Ctrl + Q). */
  async function triggerOffAndSleep(): Promise<void> {
    if (!gate.tryAcquire(Date.now())) {
      log(`${OFF_COMBO_LABEL} ignored — a command is still running (max 1 per ${COOLDOWN_MS}ms).`);
      return;
    }
    log(`\n${OFF_COMBO_LABEL} → turning TV off, then sleeping this PC...`);
    try {
      await turnOff();
      await sleep(OFF_TO_SLEEP_MS);
      log("Putting this PC to sleep...");
      await sleepPc();
    } catch (e) {
      logError(`failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      gate.release(Date.now());
    }
  }

  const stopKeys = await startKeyListener((e, mods) => {
    if (matchHotkey(e, mods, "E", PLATFORM)) void triggerOn();
    else if (matchHotkey(e, mods, "Q", PLATFORM)) void triggerOffAndSleep();
  });

  // If the daemon started right after the machine powered on (e.g. launched as a boot/login
  // item), the PC's wake happened before any tick existed, so the wake watcher can't detect
  // it. Reconcile once: ensure the TV is on and on PC input. uptimeSeconds() is seconds since
  // system boot (not process start), cross-platform.
  if (isWithinBootWindow(uptimeSeconds())) {
    log("\nDaemon started near boot → waking TV if it was off...");
    void triggerOn(); // powers on only if off, then switches to PC input
  }

  const stopWake = onWake((sleptMs) => {
    const mins = Math.round(sleptMs / 60_000);
    log(`\nPC woke from sleep (~${mins} min) → waking TV if it was off...`);
    void triggerOn(); // run() powers on only if off, then switches to PC input
  });

  log("TV daemon running.");
  log(`  ${ON_COMBO_LABEL}  → wake the TV and switch to PC`);
  log(`  ${OFF_COMBO_LABEL}  → turn the TV off, then sleep this PC`);
  log("  Auto-wakes the TV when this PC resumes from sleep.");
  log("Press Ctrl+C to quit.");

  const shutdown = () => {
    stopWake();
    stopKeys();
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
