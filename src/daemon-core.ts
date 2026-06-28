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
import { matchHotkey, parseHotkey, hotkeyLabel, isWithinBootWindow, TriggerGate, withRetry, type Hotkey, type KeyEvent, type ModifierState, type Platform } from "./domain/daemon.js";
import { startKeyListener } from "./os/key-listener.js";
import { onWake } from "./os/wake-watch.js";
import { sleepPc, uptimeSeconds } from "./os/pc-sleep.js";
import { loadConfig } from "./config.js";
import { log, logError, useTimestamps } from "./log.js";

const isMac = process.platform === "darwin";
const PLATFORM: Platform = isMac ? "mac" : "other";
// Default combos when the user hasn't configured one. These are also the labels shown in the tray
// menu and startup log. A configured hotkey (config.wakeHotkey / config.offHotkey) overrides these.
export const ON_COMBO_LABEL = isMac ? "Cmd+Ctrl+E" : "Ctrl+Alt+E";
export const OFF_COMBO_LABEL = isMac ? "Cmd+Ctrl+Q" : "Ctrl+Alt+Q";
// As Electron accelerator strings, so parseHotkey can turn the defaults into the same Hotkey shape
// a configured value parses to. Cmd→meta on mac; Ctrl+Alt elsewhere.
const DEFAULT_WAKE_ACCEL = isMac ? "Command+Control+E" : "Control+Alt+E";
const DEFAULT_OFF_ACCEL = isMac ? "Command+Control+Q" : "Control+Alt+Q";

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

// Periodic re-arm: macOS can silently disable the low-level keyboard tap while the machine is
// awake (e.g. kCGEventTapDisabledByTimeout if a callback was slow), and uiohook-napi exposes no
// event when that happens — the hotkeys just go dead with no signal. We can't detect it, so we
// pre-emptively tear the listener down and recreate the tap on a fixed interval. The re-arm is a
// sub-millisecond stop()/start(); the only cost is that a keystroke landing in that exact window
// could be missed, which is harmless for a deliberately-pressed hotkey (just press again).
const REARM_INTERVAL_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Daemon {
  // Wake the TV and switch it to the PC input (with the post-wake retry loop).
  triggerOn(): Promise<void>;
  // Turn the TV off (only if on PC input), then put this PC to sleep.
  triggerOffAndSleep(): Promise<void>;
  // Re-read the configured hotkey combos and apply them to the live key matcher. Called after
  // Settings saves so a changed combo takes effect without restarting the daemon.
  reloadHotkeys(): Promise<void>;
  // Tear down the wake watcher and key listener.
  stop(): void;
}

// Build and start the daemon. Returns the live actions + a stop() teardown.
export async function startDaemon(): Promise<Daemon> {
  useTimestamps();
  const app = createApp();
  const gate = new TriggerGate(COOLDOWN_MS);

  // Active hotkey specs, parsed from config (falling back to the platform defaults). Mutable so
  // reloadHotkeys() can swap them in place while the key listener keeps running. A null spec means
  // that action has no bound hotkey (the user cleared it) — handleKey simply won't match it.
  // Declared up here so the trigger handlers below can label their logs with the live combo.
  let wakeKey: Hotkey | null = parseHotkey(DEFAULT_WAKE_ACCEL);
  let offKey: Hotkey | null = parseHotkey(DEFAULT_OFF_ACCEL);

  // Wake the TV and switch it to the PC input (Cmd/Ctrl + E, on PC wake, and at boot). Retries the
  // whole operation up to WAKE_ATTEMPTS times, WAKE_RETRY_MS apart, on a thrown error — so a network
  // stack that's still reconnecting right after the PC resumes gets several chances rather than one.
  async function triggerOn(): Promise<void> {
    if (!gate.tryAcquire(Date.now())) {
      log(`${hotkeyLabel(wakeKey, PLATFORM)} ignored — a command is still running.`);
      return;
    }
    log(`\n${hotkeyLabel(wakeKey, PLATFORM)} → waking TV and switching to PC...`);
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
      log(`${hotkeyLabel(offKey, PLATFORM)} ignored — a command is still running.`);
      return;
    }
    log(`\n${hotkeyLabel(offKey, PLATFORM)} → turning TV off, then sleeping this PC...`);
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

  // Read the configured combos and update wakeKey/offKey. An empty config value falls back to the
  // platform default; a non-empty value that fails to parse leaves the previous spec untouched and
  // logs, so a typo in a hand-edited config can't silently unbind the action.
  async function loadHotkeys(): Promise<void> {
    const config = await loadConfig();
    const apply = (configured: string | undefined, fallback: string, label: string, set: (hk: Hotkey | null) => void): void => {
      const accel = configured?.trim();
      if (!accel) {
        set(parseHotkey(fallback)); // unset → default
        return;
      }
      const parsed = parseHotkey(accel);
      if (!parsed) {
        logError(`Ignoring invalid ${label} hotkey "${accel}" — keeping the previous binding.`);
        return; // leave the current spec untouched
      }
      set(parsed);
    };
    apply(config.wakeHotkey, DEFAULT_WAKE_ACCEL, "wake", (hk) => (wakeKey = hk));
    apply(config.offHotkey, DEFAULT_OFF_ACCEL, "off", (hk) => (offKey = hk));
  }

  await loadHotkeys();

  const handleKey = (e: KeyEvent, mods: ModifierState) => {
    if (wakeKey && matchHotkey(e, mods, wakeKey)) void triggerOn();
    else if (offKey && matchHotkey(e, mods, offKey)) void triggerOffAndSleep();
  };

  // Starting the global keyboard hook can fail — most commonly on macOS when Accessibility
  // permission hasn't been granted (uiohook-napi throws "Failed to enable access for assistive
  // devices"). Treat that as non-fatal: the daemon still auto-wakes the TV on resume, still
  // reconciles at boot, and the Electron tray/window buttons still work — only the global hotkeys
  // are unavailable. Previously the throw escaped startDaemon() entirely, so nothing started and no
  // logs were ever emitted (the Electron log window stayed empty). Log a clear remediation hint and
  // carry on instead.
  const noop = (): void => {};
  async function startKeysSafely(): Promise<() => void> {
    try {
      return await startKeyListener(handleKey);
    } catch (e) {
      logError(`Global hotkeys unavailable: ${e instanceof Error ? e.message : String(e)}`);
      if (isMac) {
        log("  Grant Accessibility permission under System Settings → Privacy & Security → Accessibility, then restart.");
      }
      return noop;
    }
  }

  // macOS disables the low-level keyboard tap when the machine sleeps and never re-arms it on
  // wake, so the hotkeys go silent after a sleep/wake cycle. Tear the listener down and start a
  // fresh one to re-create the tap. Kept as a mutable ref so the shutdown handler always stops
  // the live listener.
  let stopKeys = await startKeysSafely();
  async function rearmKeys(): Promise<void> {
    try {
      stopKeys();
    } catch (e) {
      logError(`failed to stop key listener before re-arm: ${e instanceof Error ? e.message : String(e)}`);
    }
    stopKeys = await startKeysSafely();
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

  // Watchdog: re-arm the keyboard tap on a fixed interval so a tap that died silently while the
  // machine stayed awake recovers on its own, without needing a sleep/wake cycle to kick it.
  const rearmTimer = setInterval(() => void rearmKeys(), REARM_INTERVAL_MS);
  rearmTimer.unref?.(); // don't keep the process alive just for the watchdog

  // Log the *active* combos (which may be user-configured), not just the defaults.
  function logHotkeys(): void {
    log("TV daemon running.");
    log(`  ${hotkeyLabel(wakeKey, PLATFORM)}  → wake the TV and switch to PC`);
    log(`  ${hotkeyLabel(offKey, PLATFORM)}  → turn the TV off, then sleep this PC`);
    log("  Auto-wakes the TV when this PC resumes from sleep.");
  }
  logHotkeys();

  // Re-read config and apply the new combos. The key listener keeps running and matches against
  // the updated specs on the next keystroke — no listener teardown needed.
  async function reloadHotkeys(): Promise<void> {
    await loadHotkeys();
    log(`Hotkeys updated → wake: ${hotkeyLabel(wakeKey, PLATFORM)}, off: ${hotkeyLabel(offKey, PLATFORM)}`);
  }

  function stop(): void {
    clearInterval(rearmTimer);
    stopWake();
    stopKeys();
  }

  return { triggerOn, triggerOffAndSleep, reloadHotkeys, stop };
}
