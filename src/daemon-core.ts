// Reusable daemon core: wires up the global hotkey listener, the sleep/wake watcher, and the
// boot-time reconcile, and exposes the two TV actions plus a stop() teardown. This is the whole
// daemon minus the process plumbing (SIGINT, stdin.resume) — so it can be driven by either a
// plain Node process (src/daemon.ts) or the Electron app (src/electron/main.ts).
//
// Hotkeys:
//   Wake TV + switch to PC      macOS -> Cmd+Ctrl+E    Win/Linux -> Ctrl+Alt+E
//   Turn TV off + sleep this PC macOS -> Cmd+Ctrl+Q    Win/Linux -> Ctrl+Alt+Q
//
// macOS note: global key capture needs Accessibility permission. The first run will prompt (or
// grant it under System Settings → Privacy & Security → Accessibility), otherwise no key events
// arrive.

import { createApp } from "./app.js";
import { matchHotkey, isWithinBootWindow, TriggerGate, withRetry, type Platform, type KeyEvent, type ModifierState } from "./domain/daemon.js";
import { startKeyListener } from "./os/key-listener.js";
import { onWake } from "./os/wake-watch.js";
import { sleepPc, uptimeSeconds } from "./os/pc-sleep.js";
import { log, logError, useTimestamps } from "./log.js";

const isMac = process.platform === "darwin";
const PLATFORM: Platform = isMac ? "mac" : "other";
export const ON_COMBO_LABEL = isMac ? "Cmd+Ctrl+E" : "Ctrl+Alt+E";
export const OFF_COMBO_LABEL = isMac ? "Cmd+Ctrl+Q" : "Ctrl+Alt+Q";

// No cooldown window: a new trigger may fire the instant the previous handler finishes. The gate
// still rejects triggers *while* a handler is running, so key auto-repeat / a held combo can't
// spawn concurrent handlers — but there's no rate-limiting delay afterwards.
const COOLDOWN_MS = 0;

// Wake retry: re-run the whole wake operation up to WAKE_ATTEMPTS times, WAKE_RETRY_MS apart, when
// it throws. Covers the network stack not having reconnected yet right after the PC resumes — the
// token refresh / device lookup inside app.switch() can fail until it's back. A dead TV doesn't
// throw (app.switch returns after its own power-on retries), so this never stacks a second loop.
const WAKE_ATTEMPTS = 10;
const WAKE_RETRY_MS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Daemon {
  // Wake the TV and switch it to the PC input (with the post-wake retry loop).
  triggerOn(): Promise<void>;
  // Turn the TV off (only if on PC input), then put this PC to sleep.
  triggerOffAndSleep(): Promise<void>;
  // Tear down the wake watcher and key listener.
  stop(): void;
}

// Build and start the daemon. Returns the live actions + a stop() teardown.
export async function startDaemon(): Promise<Daemon> {
  useTimestamps();
  const app = createApp();
  const gate = new TriggerGate(COOLDOWN_MS);

  // Wake the TV and switch it to the PC input (Cmd/Ctrl + E, on PC wake, and at boot). Retries the
  // whole operation up to WAKE_ATTEMPTS times, WAKE_RETRY_MS apart, on a thrown error — so a network
  // stack that's still reconnecting right after the PC resumes gets several chances rather than one.
  async function triggerOn(): Promise<void> {
    if (!gate.tryAcquire(Date.now())) {
      log(`${ON_COMBO_LABEL} ignored — a command is still running.`);
      return;
    }
    log(`\n${ON_COMBO_LABEL} → waking TV and switching to PC...`);
    try {
      await withRetry(
        () => app.switch(),
        WAKE_ATTEMPTS,
        WAKE_RETRY_MS,
        sleep,
        (attempt, err) =>
          log(`attempt ${attempt}/${WAKE_ATTEMPTS} failed (${err instanceof Error ? err.message : String(err)}) — retrying in ${WAKE_RETRY_MS / 1000}s...`),
      );
    } catch (e) {
      logError(`failed after ${WAKE_ATTEMPTS} attempts: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      gate.release(Date.now());
    }
  }

  // Turn the TV off, then immediately put this PC to sleep (Cmd/Ctrl + Q).
  async function triggerOffAndSleep(): Promise<void> {
    if (!gate.tryAcquire(Date.now())) {
      log(`${OFF_COMBO_LABEL} ignored — a command is still running.`);
      return;
    }
    log(`\n${OFF_COMBO_LABEL} → turning TV off, then sleeping this PC...`);
    try {
      await app.off();
      log("Putting this PC to sleep...");
      await sleepPc();
    } catch (e) {
      logError(`failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      gate.release(Date.now());
    }
  }

  const handleKey = (e: KeyEvent, mods: ModifierState) => {
    if (matchHotkey(e, mods, "E", PLATFORM)) void triggerOn();
    else if (matchHotkey(e, mods, "Q", PLATFORM)) void triggerOffAndSleep();
  };

  // macOS disables the low-level keyboard tap when the machine sleeps and never re-arms it on
  // wake, so the hotkeys go silent after a sleep/wake cycle. Tear the listener down and start a
  // fresh one to re-create the tap. Kept as a mutable ref so the shutdown handler always stops
  // the live listener.
  let stopKeys = await startKeyListener(handleKey);
  async function rearmKeys(): Promise<void> {
    try {
      stopKeys();
    } catch (e) {
      logError(`failed to stop key listener before re-arm: ${e instanceof Error ? e.message : String(e)}`);
    }
    stopKeys = await startKeyListener(handleKey);
  }

  // If the daemon started right after the machine powered on (e.g. launched as a boot/login
  // item), the PC's wake happened before any tick existed, so the wake watcher can't detect
  // it. Reconcile once: ensure the TV is on and on PC input. uptimeSeconds() is seconds since
  // system boot (not process start), cross-platform.
  if (isWithinBootWindow(uptimeSeconds())) {
    log("\nDaemon started near boot → waking TV if it was off...");
    void triggerOn();
  }

  const stopWake = onWake((sleptMs) => {
    const mins = Math.round(sleptMs / 60_000);
    log(`\nPC woke from sleep (~${mins} min) → re-arming hotkeys and waking TV if it was off...`);
    void rearmKeys(); // the keyboard tap is disabled across sleep on macOS — re-create it
    void triggerOn();
  });

  log("TV daemon running.");
  log(`  ${ON_COMBO_LABEL}  → wake the TV and switch to PC`);
  log(`  ${OFF_COMBO_LABEL}  → turn the TV off, then sleep this PC`);
  log("  Auto-wakes the TV when this PC resumes from sleep.");

  function stop(): void {
    stopWake();
    stopKeys();
  }

  return { triggerOn, triggerOffAndSleep, stop };
}
