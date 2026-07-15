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
import {
  defaultHotkeys,
  groupHotkeyBindings,
  hotkeyLabel,
  isWithinBootWindow,
  TriggerGate,
  withRetry,
  type ActionResult,
  type HotkeyTarget,
  type Platform,
} from "./domain/daemon.js";
import { normalizeDeviceConfigs, type DeviceConfig } from "./domain/config.js";
import { onWake } from "./os/wake-watch.js";
import { sleepPc, uptimeSeconds } from "./os/pc-sleep.js";
import { isMockMode } from "./dev/mock-cloud.js";
import { loadConfig } from "./config.js";
import { log, logError, useTimestamps } from "./log.js";

const isMac = process.platform === "darwin";
const PLATFORM: Platform = isMac ? "mac" : "other";
// Default combos, used only when a hotkey was never configured (config field unset). An empty
// string in config means the user cleared the binding — the command then has NO hotkey; it does
// not fall back to these. Settings shows the same defaults (src/electron/settings.ts).
const HOTKEY_DEFAULTS = defaultHotkeys(PLATFORM);
// The tray menu labels its two action items with the live hotkey combo. Expose the platform and
// the label renderer so main.ts can format the *current* accelerators (from getSettings) rather
// than a compile-time constant — the earlier ON/OFF_COMBO_LABEL constants were fixed to the
// defaults and never reflected a customized (or re-customized) combo.
export const TRAY_PLATFORM = PLATFORM;
export { hotkeyLabel };

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
  // Wake the TV and switch it to the PC input (with the post-wake retry loop). The result is for
  // interactive callers (the renderer's power buttons); hotkey/tray/watcher callers ignore it.
  triggerOn(): Promise<ActionResult>;
  // Turn the TV off (only if on PC input), then put this PC to sleep. Resolves with the TV-off
  // result before the PC actually sleeps — sleepPc() runs detached (see triggerOffAndSleep).
  triggerOffAndSleep(): Promise<ActionResult>;
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
  // trigger handlers below can label their logs with the live combo. deviceConfigs holds each TV's
  // own settings (no hotkey defaults — unset means that TV has no hotkey actions).
  let wakeAccel = HOTKEY_DEFAULTS.wake;
  let offAccel = HOTKEY_DEFAULTS.off;
  let deviceConfigs: Record<string, DeviceConfig> = {};

  // The device ids a trigger should pass to app.switch()/app.off(). undefined = legacy path (the
  // Settings selection, resolved inside app.ts) — used by the tray/IPC/wake-watch callers that pass
  // no target, and by the global binding when no per-device binding shares its combo. A target
  // mixing the global binding with explicit ids unions the fresh Settings selection with them.
  async function resolveTargetIds(target?: HotkeyTarget): Promise<string[] | undefined> {
    if (!target || (target.includeSelected && target.deviceIds.length === 0)) return undefined;
    if (!target.includeSelected) return target.deviceIds;
    const config = await loadConfig();
    return [...new Set([...(config.selectedDeviceIds ?? []), ...target.deviceIds])];
  }

  const scopeTag = (ids: string[] | undefined): string => (ids ? ` [${ids.join(", ")}]` : "");

  // Wake the TV and switch it to the PC input (Cmd/Ctrl + E, on PC wake, and at boot). Retries the
  // whole operation up to WAKE_ATTEMPTS times, WAKE_RETRY_MS apart, on a thrown error — so a
  // network stack that's still reconnecting right after the PC resumes gets several chances.
  // `target`/`accelForLog` scope a per-device hotkey trigger; the public zero-arg calls act on the
  // Settings selection as before. Note: a binding whose every id is stale (TV removed from the
  // account) makes app.switch() throw and churn this retry loop — ~30s of log noise, harmless.
  async function triggerOn(target?: HotkeyTarget, accelForLog?: string): Promise<ActionResult> {
    const label = hotkeyLabel(accelForLog ?? wakeAccel, PLATFORM);
    if (!gate.tryAcquire(Date.now())) {
      log(`${label} ignored — a command is still running.`);
      return { ok: false, error: "A command is already running.", busy: true };
    }
    const ids = await resolveTargetIds(target);
    log(`\n${label} → waking TV and switching to PC...${scopeTag(ids)}`);
    try {
      const acted = await withRetry(
        () => app.switch(undefined, ids),
        WAKE_ATTEMPTS,
        WAKE_RETRY_MS,
        sleep,
        (attempt, err) =>
          log(`attempt ${attempt}/${WAKE_ATTEMPTS} failed (${err instanceof Error ? err.message : String(err)}) — retrying in ${WAKE_RETRY_MS / 1000}s...`),
      );
      return acted ? { ok: true } : { ok: false, error: "No TVs selected — choose one in Settings." };
    } catch (e) {
      logError(`failed after ${WAKE_ATTEMPTS} attempts: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      gate.release(Date.now());
    }
  }

  // Turn the TV off, then immediately put this PC to sleep (Cmd/Ctrl + Q). Like triggerOn, an
  // optional target scopes a per-device hotkey to its own TVs; the PC sleeps either way.
  async function triggerOffAndSleep(target?: HotkeyTarget, accelForLog?: string): Promise<ActionResult> {
    const label = hotkeyLabel(accelForLog ?? offAccel, PLATFORM);
    if (!gate.tryAcquire(Date.now())) {
      log(`${label} ignored — a command is still running.`);
      return { ok: false, error: "A command is already running.", busy: true };
    }
    const ids = await resolveTargetIds(target);
    log(`\n${label} → turning TV off, then sleeping this PC...${scopeTag(ids)}`);
    let result: ActionResult;
    try {
      const acted = await app.off(ids);
      result = acted ? { ok: true } : { ok: false, error: "No TVs selected — choose one in Settings." };
    } catch (e) {
      logError(`TV off failed: ${e instanceof Error ? e.message : String(e)} — sleeping this PC anyway.`);
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      // Release before suspending: sleepPc()'s child process may not exit (and so not resolve)
      // until the machine resumes, and the resume-time triggerOn must not find the gate busy.
      gate.release(Date.now());
    }
    // In mock mode only the TV is fake — sleepPc() would suspend the actual dev machine.
    if (isMockMode()) {
      log("Mock mode — skipping PC sleep.");
      return result;
    }
    log("Putting this PC to sleep...");
    // Detached for the same reason the gate releases early: awaiting sleepPc() would keep the
    // renderer's invoke pending through the whole sleep cycle.
    void sleepPc().catch((e: unknown) => {
      logError(`sleep failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    return result;
  }

  // Read the configured combos and update wakeAccel/offAccel/deviceConfigs. A hotkey that was
  // never configured (field unset) gets the platform default; an empty string means the user
  // cleared it — the command is disabled, NOT defaulted (per-device hotkeys have no defaults
  // either way). A non-empty value is taken as-is (the capture UI only ever produces valid
  // Electron accelerators — a bad one is caught when globalShortcut.register rejects it).
  async function loadHotkeys(): Promise<void> {
    const config = await loadConfig();
    wakeAccel = config.wakeHotkey === undefined ? HOTKEY_DEFAULTS.wake : config.wakeHotkey.trim();
    offAccel = config.offHotkey === undefined ? HOTKEY_DEFAULTS.off : config.offHotkey.trim();
    deviceConfigs = normalizeDeviceConfigs(config.deviceConfigs);
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
    // Each accelerator registers with the OS exactly once; everything bound to it (the global
    // action and/or specific TVs) fires together in one trigger. A combo bound to both wake and
    // off keeps only wake — one keypress must not wake a TV and sleep the PC at once.
    for (const [accel, bindings] of groupHotkeyBindings(wakeAccel, offAccel, deviceConfigs)) {
      if (bindings.wake && bindings.off) {
        logError(`Hotkey "${hotkeyLabel(accel, PLATFORM)}" is bound to both wake and off — keeping only wake.`);
      }
      const wake = bindings.wake;
      const off = bindings.off;
      if (wake) arm(accel, "wake", () => void triggerOn(wake, accel));
      else if (off) arm(accel, "off", () => void triggerOffAndSleep(off, accel));
    }
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

  // Log the *active* combos (which may be user-configured); a cleared binding logs as disabled.
  const comboLabel = (accel: string): string =>
    accel ? hotkeyLabel(accel, PLATFORM) : "disabled (no hotkey)";
  function logHotkeys(): void {
    log("TV daemon running.");
    log(`  ${comboLabel(wakeAccel)}  → wake the TV and switch to PC`);
    log(`  ${comboLabel(offAccel)}  → turn the TV off, then sleep this PC`);
    log("  Auto-wakes the TV when this PC resumes from sleep.");
  }
  logHotkeys();

  // Re-read config and re-register so a changed combo takes effect without restarting.
  async function reloadHotkeys(): Promise<void> {
    await loadHotkeys();
    registerHotkeys();
    const perDevice = Object.values(deviceConfigs).reduce(
      (n, cfg) => n + (cfg.wakeHotkey ? 1 : 0) + (cfg.offHotkey ? 1 : 0),
      0,
    );
    log(
      `Hotkeys updated → wake: ${comboLabel(wakeAccel)}, off: ${comboLabel(offAccel)}` +
        (perDevice ? `, plus ${perDevice} per-TV binding${perDevice === 1 ? "" : "s"}` : ""),
    );
  }

  function stop(): void {
    stopWake();
    globalShortcut.unregisterAll();
  }

  return { triggerOn, triggerOffAndSleep, reloadHotkeys, stop };
}
