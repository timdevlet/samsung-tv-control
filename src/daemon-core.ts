// Reusable daemon core: wires up the global hotkeys, the sleep/wake watcher, and the boot-time
// reconcile, and exposes the two TV actions plus a stop() teardown. This is the daemon logic
// minus the tray/window plumbing — driven by the Electron app (src/electron/main.ts).
//
// Hotkeys are registered with Electron's globalShortcut (RegisterHotKey on Windows, a Carbon
// hotkey on macOS): the OS matches the combo system-wide and invokes our callback directly, so
// there's no raw key stream to parse and no event tap to keep alive across sleep.
//
//   Wake TV + switch to PC      macOS -> Cmd+Ctrl+E    Win/Linux -> Ctrl+Alt+E
//   Turn TV off + sleep this PC macOS -> Cmd+Ctrl+Q    Win/Linux -> Ctrl+Alt+Q
//
// macOS note: a global shortcut that includes a non-system combo still works without Accessibility
// permission (unlike the old low-level tap), but the combo must not collide with a system shortcut.

import { globalShortcut } from "electron";
import { createApp } from "./app.js";
import { hotkeyLabel, isWithinBootWindow, TriggerGate, withRetry, type Platform } from "./domain/daemon.js";
import { onWake } from "./os/wake-watch.js";
import { sleepPc, uptimeSeconds } from "./os/pc-sleep.js";
import { loadConfig } from "./config.js";
import { log, logError, useTimestamps } from "./log.js";

const isMac = process.platform === "darwin";
const PLATFORM: Platform = isMac ? "mac" : "other";
// Default combos as Electron accelerator strings, used when the user hasn't configured one.
// A configured hotkey (config.wakeHotkey / config.offHotkey) overrides these. Cmd→meta on mac;
// Ctrl+Alt elsewhere.
const DEFAULT_WAKE_ACCEL = isMac ? "Command+Control+E" : "Control+Alt+E";
const DEFAULT_OFF_ACCEL = isMac ? "Command+Control+Q" : "Control+Alt+Q";
// Human labels for the tray menu / startup log (the defaults; reflect the user's configured combo
// where applicable via hotkeyLabel). Exported for the tray menu in src/electron/main.ts.
export const ON_COMBO_LABEL = hotkeyLabel(DEFAULT_WAKE_ACCEL, PLATFORM);
export const OFF_COMBO_LABEL = hotkeyLabel(DEFAULT_OFF_ACCEL, PLATFORM);

// No cooldown window: a new trigger may fire the instant the previous handler finishes. The gate
// still rejects triggers *while* a handler is running, so key auto-repeat / a held combo can't
// spawn concurrent handlers — but there's no rate-limiting delay afterwards.
const COOLDOWN_MS = 0;

// Wake retry: re-run the whole wake operation up to WAKE_ATTEMPTS times, WAKE_RETRY_MS apart, when
// it throws. Covers the network stack not having reconnected yet right after the PC resumes — the
// token refresh / device lookup / device commands inside app.switch() can fail until it's back
// (app.switch throws when every selected TV failed), and the delay is what lets the ~30s retry
// window outlast the reconnect. A dead TV that just won't power on doesn't throw (app.switch
// returns after its own power-on retries), so this never stacks a second loop.
const WAKE_ATTEMPTS = 10;
const WAKE_RETRY_MS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Daemon {
  // Wake the TV and switch it to the PC input (with the post-wake retry loop).
  triggerOn(): Promise<void>;
  // Turn the TV off (only if on PC input), then put this PC to sleep.
  triggerOffAndSleep(): Promise<void>;
  // Re-read the configured hotkey combos and apply them to the live key matcher. Called after
  // Settings saves so a changed combo takes effect without restarting the daemon.
  reloadHotkeys(): Promise<void>;
  // Tear down the wake watcher and unregister the global hotkeys.
  stop(): void;
}

// Build and start the daemon. Returns the live actions + a stop() teardown.
export async function startDaemon(): Promise<Daemon> {
  useTimestamps();
  const app = createApp();
  const gate = new TriggerGate(COOLDOWN_MS);

  // Active hotkey accelerators (Electron strings), from config or the platform defaults. Mutable so
  // reloadHotkeys() can swap them while the daemon runs. An empty string means the action has no
  // bound hotkey (the user cleared it) — registerHotkeys simply skips it. Declared up here so the
  // trigger handlers below can label their logs with the live combo.
  let wakeAccel = DEFAULT_WAKE_ACCEL;
  let offAccel = DEFAULT_OFF_ACCEL;

  // Wake the TV and switch it to the PC input (Cmd/Ctrl + E, on PC wake, and at boot). Retries the
  // whole operation up to WAKE_ATTEMPTS times, WAKE_RETRY_MS apart, on a thrown error — so a
  // network stack that's still reconnecting right after the PC resumes gets several chances.
  async function triggerOn(): Promise<void> {
    if (!gate.tryAcquire(Date.now())) {
      log(`${hotkeyLabel(wakeAccel, PLATFORM)} ignored — a command is still running.`);
      return;
    }
    log(`\n${hotkeyLabel(wakeAccel, PLATFORM)} → waking TV and switching to PC...`);
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
      log(`${hotkeyLabel(offAccel, PLATFORM)} ignored — a command is still running.`);
      return;
    }
    log(`\n${hotkeyLabel(offAccel, PLATFORM)} → turning TV off, then sleeping this PC...`);
    try {
      await app.off();
    } catch (e) {
      logError(`TV off failed: ${e instanceof Error ? e.message : String(e)} — sleeping this PC anyway.`);
    } finally {
      // Release before suspending: sleepPc()'s child process may not exit (and so not resolve)
      // until the machine resumes, and the resume-time triggerOn must not find the gate busy.
      gate.release(Date.now());
    }
    log("Putting this PC to sleep...");
    try {
      await sleepPc();
    } catch (e) {
      logError(`sleep failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Read the configured combos and update wakeAccel/offAccel. An empty config value falls back to
  // the platform default; a non-empty value is taken as-is (the capture UI only ever produces valid
  // Electron accelerators — a bad one is caught when globalShortcut.register rejects it).
  async function loadHotkeys(): Promise<void> {
    const config = await loadConfig();
    wakeAccel = config.wakeHotkey?.trim() || DEFAULT_WAKE_ACCEL;
    offAccel = config.offHotkey?.trim() || DEFAULT_OFF_ACCEL;
  }

  // (Re)register the active accelerators with the OS. unregisterAll() first so a reload doesn't
  // leave a stale binding behind. register() returns false (and may throw) when the accelerator is
  // malformed or already claimed by the system / another app; treat that as a non-fatal "hotkey
  // unavailable" — the daemon still auto-wakes on resume, reconciles at boot, and the tray/window
  // buttons still work. On macOS a global shortcut works without Accessibility permission, so unlike
  // the old low-level tap there's no permission prompt to satisfy.
  function registerHotkeys(): void {
    globalShortcut.unregisterAll();
    const arm = (accel: string, label: string, handler: () => void): void => {
      if (!accel) return; // user cleared this binding
      try {
        if (!globalShortcut.register(accel, handler)) {
          logError(`Could not register ${label} hotkey "${hotkeyLabel(accel, PLATFORM)}" — it may be reserved or already in use.`);
        }
      } catch (e) {
        logError(`Could not register ${label} hotkey "${hotkeyLabel(accel, PLATFORM)}": ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    arm(wakeAccel, "wake", () => void triggerOn());
    arm(offAccel, "off", () => void triggerOffAndSleep());
  }

  await loadHotkeys();
  registerHotkeys();

  // If the daemon started right after the machine powered on (e.g. launched as a boot/login
  // item), the PC's wake happened before any tick existed, so the wake watcher can't detect
  // it. Reconcile once: ensure the TV is on and on PC input. uptimeSeconds() is seconds since
  // system boot (not process start), cross-platform.
  if (isWithinBootWindow(uptimeSeconds())) {
    log("\nDaemon started near boot → waking TV if it was off...");
    void triggerOn();
  }

  // globalShortcut registrations survive sleep/wake on their own (the OS owns them), so unlike the
  // old low-level tap there's nothing to re-arm here — just wake the TV.
  const stopWake = onWake((sleptMs) => {
    const mins = Math.round(sleptMs / 60_000);
    log(`\nPC woke from sleep (~${mins} min) → waking TV if it was off...`);
    void triggerOn();
  });

  // Log the *active* combos (which may be user-configured), not just the defaults.
  function logHotkeys(): void {
    log("TV daemon running.");
    log(`  ${hotkeyLabel(wakeAccel, PLATFORM)}  → wake the TV and switch to PC`);
    log(`  ${hotkeyLabel(offAccel, PLATFORM)}  → turn the TV off, then sleep this PC`);
    log("  Auto-wakes the TV when this PC resumes from sleep.");
  }
  logHotkeys();

  // Re-read config and re-register so a changed combo takes effect without restarting.
  async function reloadHotkeys(): Promise<void> {
    await loadHotkeys();
    registerHotkeys();
    log(`Hotkeys updated → wake: ${hotkeyLabel(wakeAccel, PLATFORM)}, off: ${hotkeyLabel(offAccel, PLATFORM)}`);
  }

  function stop(): void {
    stopWake();
    globalShortcut.unregisterAll();
  }

  return { triggerOn, triggerOffAndSleep, reloadHotkeys, stop };
}
