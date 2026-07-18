// Reusable daemon core: wires up the command hotkeys, the sleep/wake watcher, and the boot-time
// reconcile, and exposes the TV actions plus a stop() teardown. This is the daemon logic
// minus the tray/window plumbing — driven by the Electron app (src/electron/main.ts).
//
// Hotkeys come exclusively from the user-defined command list (Settings → Commands) and are
// registered with Electron's globalShortcut (RegisterHotKey on Windows, a Carbon hotkey on
// macOS): the OS matches the combo system-wide and invokes our callback directly, so there's no
// raw key stream to parse and no event tap to keep alive across sleep.
//
// macOS note: a global shortcut that includes a non-system combo still works without Accessibility
// permission (unlike the old low-level tap), but the combo must not collide with a system shortcut.

import { globalShortcut } from "electron";
import { createApp } from "./app.js";
import {
  hotkeyLabel,
  isWithinBootWindow,
  TriggerGate,
  withRetry,
  type ActionResult,
  type HotkeyTarget,
  type Platform,
} from "./domain/daemon.js";
import { commandIsKeySeq, commandLabel, normalizeCommands, type CommandConfig } from "./domain/config.js";
import { onWake } from "./os/wake-watch.js";
import { sleepPc, uptimeSeconds } from "./os/pc-sleep.js";
import { isMockMode } from "./dev/mock-cloud.js";
import { loadConfig } from "./config.js";
import { log, logError, useTimestamps } from "./log.js";

const isMac = process.platform === "darwin";
const PLATFORM: Platform = isMac ? "mac" : "other";

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
  // interactive callers (the renderer's power buttons); tray/watcher callers ignore it. An
  // optional target scopes the action (the Main-screen TV selector); none = the Settings selection.
  triggerOn(target?: HotkeyTarget): Promise<ActionResult>;
  // Turn the TV off (only if on PC input), then put this PC to sleep. Resolves with the TV-off
  // result before the PC actually sleeps — sleepPc() runs detached (see runOff).
  triggerOffAndSleep(target?: HotkeyTarget): Promise<ActionResult>;
  // Turn the TV off (only if on PC input) and leave this PC running.
  triggerOff(target?: HotkeyTarget): Promise<ActionResult>;
  // Run one user-defined command (Settings → Commands): its action against its own TV, or every
  // selected TV when the command targets "All TVs".
  triggerCommand(cmd: CommandConfig): Promise<ActionResult>;
  // Send an explicit remote-key sequence to one LAN TV (Settings → the per-TV "Run key sequence"
  // button). LAN-only — a cloud id is rejected before any transport work.
  sendKeys(deviceId: string, keys: string[]): Promise<ActionResult>;
  // Re-read the command list and re-register its hotkeys. Called after Settings saves so a
  // changed combo takes effect without restarting the daemon.
  reloadHotkeys(): Promise<void>;
  // Tear down the wake watcher and unregister the global hotkeys.
  stop(): void;
}

// Build and start the daemon. Returns the live actions + a stop() teardown.
export async function startDaemon(): Promise<Daemon> {
  useTimestamps();
  const app = createApp();
  const gate = new TriggerGate(COOLDOWN_MS);

  // The user-defined command list (Settings → Commands) — the only source of hotkeys. Reloaded
  // by reloadHotkeys() so an edited command (or combo) takes effect without a restart.
  let commands: CommandConfig[] = [];

  // The device ids a trigger should pass to app.switch()/app.off(). undefined = the Settings
  // selection, resolved inside app.ts — used by the tray/IPC/wake-watch callers that pass no
  // target and by "All TVs" commands. A target mixing includeSelected with explicit ids unions
  // the fresh Settings selection with them.
  async function resolveTargetIds(target?: HotkeyTarget): Promise<string[] | undefined> {
    if (!target || (target.includeSelected && target.deviceIds.length === 0)) return undefined;
    if (!target.includeSelected) return target.deviceIds;
    const config = await loadConfig();
    return [...new Set([...(config.selectedDeviceIds ?? []), ...target.deviceIds])];
  }

  const scopeTag = (ids: string[] | undefined): string => (ids ? ` [${ids.join(", ")}]` : "");

  // Wake the TV and switch it to the PC input (buttons/tray, on PC wake, and at boot). Retries
  // the whole operation up to WAKE_ATTEMPTS times, WAKE_RETRY_MS apart, on a thrown error — so a
  // network stack that's still reconnecting right after the PC resumes gets several chances.
  // `target` scopes a per-TV command trigger; the public zero-arg calls act on the Settings
  // selection as before. `auto` marks the daemon's own triggers (wake-on-resume, boot
  // reconcile) — app.switch then leaves a LAN TV whose input can't be read alone instead of
  // sending blind input keys (see SwitchOptions in src/app.ts); every user-initiated caller
  // (command hotkey, tray, renderer button) stays manual. Note: a command whose TV is stale
  // (removed from the account) makes app.switch() throw and churn this retry loop — ~30s of log
  // noise, harmless.
  async function triggerOn(
    target?: HotkeyTarget,
    auto = false,
    inputOverride?: string,
    labelOverride?: string,
  ): Promise<ActionResult> {
    const label = labelOverride ?? "Wake TV → PC";
    if (!gate.tryAcquire(Date.now())) {
      log(`${label} ignored — a command is still running.`);
      return { ok: false, error: "A command is already running.", busy: true };
    }
    const ids = await resolveTargetIds(target);
    log(`\n${label} → waking TV and switching input...${scopeTag(ids)}`);
    try {
      const acted = await withRetry(
        () => app.switch(inputOverride, ids, { auto }),
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

  // Turn the TV off; when `sleepAfter`, immediately put this PC to sleep as well. Shared by both
  // off actions — triggerOffAndSleep and triggerOff — and by the off commands. Like triggerOn,
  // an optional target scopes a per-TV command to its own TV.
  async function runOff(sleepAfter: boolean, label: string, target?: HotkeyTarget): Promise<ActionResult> {
    if (!gate.tryAcquire(Date.now())) {
      log(`${label} ignored — a command is still running.`);
      return { ok: false, error: "A command is already running.", busy: true };
    }
    const ids = await resolveTargetIds(target);
    log(`\n${label} → turning TV off${sleepAfter ? ", then sleeping this PC" : " (this PC stays on)"}...${scopeTag(ids)}`);
    let result: ActionResult;
    try {
      const acted = await app.off(ids);
      result = acted ? { ok: true } : { ok: false, error: "No TVs selected — choose one in Settings." };
    } catch (e) {
      logError(`TV off failed: ${e instanceof Error ? e.message : String(e)}${sleepAfter ? " — sleeping this PC anyway." : ""}`);
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      // Release before suspending: sleepPc()'s child process may not exit (and so not resolve)
      // until the machine resumes, and the resume-time triggerOn must not find the gate busy.
      gate.release(Date.now());
    }
    if (!sleepAfter) return result;
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

  function triggerOffAndSleep(target?: HotkeyTarget): Promise<ActionResult> {
    return runOff(true, "TV off + sleep", target);
  }

  // TV off without the PC sleep — fired from the tray menu / renderer button.
  function triggerOff(target?: HotkeyTarget): Promise<ActionResult> {
    return runOff(false, "TV off", target);
  }

  // Gate-wrapped runner for the simple one-shot commands (power on / input only) — same busy
  // rejection and no-TVs-selected result as the built-in triggers, no retry loop (these are
  // always explicit user actions, not post-resume reconciles).
  async function runSimple(label: string, op: () => Promise<boolean>): Promise<ActionResult> {
    if (!gate.tryAcquire(Date.now())) {
      log(`${label} ignored — a command is still running.`);
      return { ok: false, error: "A command is already running.", busy: true };
    }
    log(`\n${label} → running...`);
    try {
      const acted = await op();
      return acted ? { ok: true } : { ok: false, error: "No TVs selected — choose one in Settings." };
    } catch (e) {
      logError(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      gate.release(Date.now());
    }
  }

  // Run one user-defined command against its checked TVs, or every selected TV when none are
  // checked ("all enabled TVs"). Routed to the same underlying operations as the built-in
  // triggers so gating/logging/results stay uniform.
  async function triggerCommand(cmd: CommandConfig): Promise<ActionResult> {
    const label = `Command "${commandLabel(cmd)}"`;
    // A LAN-targeted command runs its raw key sequence instead of a cloud action (its single target
    // is a `local:` TV). Split the stored sequence into tokens; triggerSendKeys normalizes them to
    // KEY_* and gate-guards the send.
    if (commandIsKeySeq(cmd)) {
      const deviceId = cmd.deviceIds![0];
      const tokens = (cmd.keySeq ?? "").split(",").map((k) => k.trim()).filter(Boolean);
      return triggerSendKeys(deviceId, tokens);
    }
    // undefined = the Settings selection; a targeted command carries its explicit ids.
    const ids = cmd.deviceIds?.length ? cmd.deviceIds : undefined;
    const target: HotkeyTarget | undefined = ids
      ? { includeSelected: false, deviceIds: ids }
      : undefined;
    switch (cmd.action) {
      case "tvOn":
        return runSimple(label, () => app.powerOn(ids));
      case "tvOff":
        return runOff(false, label, target);
      case "tvOffSleepPc":
        return runOff(true, label, target);
      case "tvOnHdmi":
        return triggerOn(target, false, cmd.hdmi, label);
      case "switchHdmi":
        return runSimple(label, () => app.switchInputOnly(cmd.hdmi ?? "HDMI1", ids));
    }
  }

  // Send an explicit remote-key sequence to one TV (Settings → "Run key sequence", or a pinned
  // key-sequence command). Guards to LAN devices — a `local:<mac>` id (see the id convention in
  // src/app.ts); a cloud id has no raw-key channel, so reject it here before app.sendKeys would hit
  // the cloud transport's throw. Deliberately does NOT take the busy gate: raw key sends go over a
  // pooled, kept-alive socket and must fire as fast as the user presses — gating them would drop
  // rapid presses as "already running". (The gate still protects the power/switch actions, where a
  // held combo could otherwise spawn concurrent wake handlers.)
  async function triggerSendKeys(deviceId: string, keys: string[]): Promise<ActionResult> {
    if (!deviceId.startsWith("local:")) {
      return { ok: false, error: "Only LAN TVs can run a raw key sequence." };
    }
    if (keys.length === 0) {
      return { ok: false, error: "Enter a key sequence first." };
    }
    const label = `Send keys [${keys.join(", ")}]`;
    log(`\n${label} → running...`);
    try {
      await app.sendKeys(deviceId, keys);
      return { ok: true };
    } catch (e) {
      logError(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Re-read the command list. Hotkey values are taken as-is (the capture UI only ever produces
  // valid Electron accelerators — a bad one is caught when globalShortcut.register rejects it).
  async function loadCommands(): Promise<void> {
    const config = await loadConfig();
    commands = normalizeCommands(config.commands);
  }

  // (Re)register the command hotkeys with the OS. unregisterAll() first so a reload doesn't
  // leave a stale binding behind. register() returns false (and may throw) when the accelerator is
  // malformed or already claimed by the system / another app; treat that as a non-fatal "hotkey
  // unavailable" — the daemon still auto-wakes on resume, reconciles at boot, and the tray/window
  // buttons still work. On macOS a global shortcut works without Accessibility permission, so unlike
  // the old low-level tap there's no permission prompt to satisfy.
  function registerHotkeys(): void {
    globalShortcut.unregisterAll();
    const arm = (accel: string, label: string, handler: () => void): void => {
      try {
        if (!globalShortcut.register(accel, handler)) {
          logError(`Could not register ${label} hotkey "${hotkeyLabel(accel, PLATFORM)}" — it may be reserved or already in use.`);
        }
      } catch (e) {
        logError(`Could not register ${label} hotkey "${hotkeyLabel(accel, PLATFORM)}": ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    // Each accelerator registers with the OS exactly once. When two commands share a combo the
    // first in list order wins and the duplicate is skipped with a warning — one keypress must
    // not fire two commands at once.
    const used = new Set<string>();
    for (const cmd of commands) {
      const accel = cmd.hotkey?.trim();
      if (!accel) continue;
      if (used.has(accel)) {
        logError(
          `Hotkey "${hotkeyLabel(accel, PLATFORM)}" is already bound — skipping it for command "${commandLabel(cmd)}".`,
        );
        continue;
      }
      used.add(accel);
      arm(accel, `command "${commandLabel(cmd)}"`, () => void triggerCommand(cmd));
    }
  }

  await loadCommands();
  registerHotkeys();

  // If the daemon started right after the machine powered on (e.g. launched as a boot/login
  // item), the PC's wake happened before any tick existed, so the wake watcher can't detect
  // it. Reconcile once: ensure the TV is on and on PC input. uptimeSeconds() is seconds since
  // system boot (not process start), cross-platform.
  if (isWithinBootWindow(uptimeSeconds())) {
    log("\nDaemon started near boot → waking TV if it was off...");
    void triggerOn(undefined, true);
  }

  // globalShortcut registrations survive sleep/wake on their own (the OS owns them), so unlike the
  // old low-level tap there's nothing to re-arm here — just wake the TV.
  const stopWake = onWake((sleptMs) => {
    const mins = Math.round(sleptMs / 60_000);
    log(`\nPC woke from sleep (~${mins} min) → waking TV if it was off...`);
    void triggerOn(undefined, true);
  });

  // Log each command hotkey so the active bindings are visible at startup and after a reload.
  function logHotkeys(): void {
    for (const cmd of commands) {
      if (cmd.hotkey?.trim()) {
        log(`  ${hotkeyLabel(cmd.hotkey, PLATFORM)}  → ${commandLabel(cmd)}`);
      }
    }
  }
  log("TV daemon running.");
  log("  Auto-wakes the TV when this PC resumes from sleep.");
  logHotkeys();

  // Re-read the command list and re-register so a changed combo takes effect without restarting.
  async function reloadHotkeys(): Promise<void> {
    await loadCommands();
    registerHotkeys();
    const commandKeys = commands.filter((c) => c.hotkey?.trim()).length;
    log(`Hotkeys updated → ${commandKeys} command binding${commandKeys === 1 ? "" : "s"}.`);
    logHotkeys();
  }

  function stop(): void {
    stopWake();
    globalShortcut.unregisterAll();
  }

  return {
    triggerOn,
    triggerOffAndSleep,
    triggerOff,
    triggerCommand,
    sendKeys: triggerSendKeys,
    reloadHotkeys,
    stop,
  };
}
