// Pure daemon decision logic — hotkey label rendering, boot-window check, and the timer-free
// state machines for trigger cooldown and sleep/wake detection. No I/O; daemon-core.ts and the
// os/ adapters drive these with real timers and a real clock.
//
// Hotkeys themselves are registered with Electron's globalShortcut, which consumes the raw
// accelerator strings ("Command+Control+E") the capture UI produces and does the system-wide
// matching itself — so this module no longer parses or matches keys, only renders a label.

// Hotkey labels

export type Platform = "mac" | "other";

// Default combos as Electron accelerator strings, used when a hotkey was never configured
// (config field unset). An empty string in config is NOT a fallback to these — it means the
// user cleared the binding and the command has no hotkey. Cmd→meta on mac; Ctrl+Alt elsewhere.
export function defaultHotkeys(platform: Platform): { wake: string; off: string } {
  return platform === "mac"
    ? { wake: "Command+Control+E", off: "Command+Control+Q" }
    : { wake: "Control+Alt+E", off: "Control+Alt+Q" };
}

// Render an Electron accelerator string ("Command+Control+E") as a short human label for
// logs/menus, using the platform's modifier names (mac shows Cmd/Ctrl/Opt; elsewhere Ctrl/Alt/Win).
// An empty/unset accelerator renders as "unset". Tokens are normalized case-insensitively;
// CmdOrCtrl resolves to the platform's primary modifier. Order matches the common convention.
export function hotkeyLabel(accelerator: string | undefined, platform: Platform): string {
  const accel = accelerator?.trim();
  if (!accel) return "unset";
  const isMac = platform === "mac";
  const mods: string[] = [];
  let key = "";
  for (const raw of accel.split("+").map((p) => p.trim()).filter(Boolean)) {
    switch (raw.toLowerCase()) {
      case "command":
      case "cmd":
      case "super":
      case "meta":
        mods.push(isMac ? "Cmd" : "Win");
        break;
      case "control":
      case "ctrl":
        mods.push("Ctrl");
        break;
      case "cmdorctrl":
      case "commandorcontrol":
        mods.push(isMac ? "Cmd" : "Ctrl");
        break;
      case "alt":
      case "option":
        mods.push(isMac ? "Opt" : "Alt");
        break;
      case "shift":
        mods.push("Shift");
        break;
      default:
        key = raw;
    }
  }
  if (!key) return "unset";
  // Conventional order: Ctrl, Alt/Opt, Shift, Cmd/Win — then the key. Dedupe + sort by that rank.
  const rank: Record<string, number> = { Ctrl: 0, Alt: 1, Opt: 1, Shift: 2, Cmd: 3, Win: 3 };
  const ordered = [...new Set(mods)].sort((a, b) => (rank[a] ?? 9) - (rank[b] ?? 9));
  return [...ordered, key].join("+");
}

// Hotkey binding groups

import type { DeviceConfig } from "./config.js";

// Who a registered accelerator acts on. The global pair acts on the TVs selected in Settings
// (includeSelected, resolved from config at trigger time); per-device bindings carry their
// explicit deviceIds. Both can be true for one accelerator when the user binds the same combo
// globally and on specific TVs — the trigger unions the two sets.
export interface HotkeyTarget {
  includeSelected: boolean;
  deviceIds: string[];
}

export interface AccelBindings {
  wake?: HotkeyTarget;
  off?: HotkeyTarget;
}

// Group every non-empty binding (the global wake/off pair plus each TV's own pair) by
// accelerator, so daemon-core registers each combo with the OS exactly once and a single
// keypress fires everything bound to it — several TVs on one combo act together in one trigger.
// An accelerator may come back with BOTH wake and off set (pathological: one keypress would
// wake a TV and sleep the PC); the caller must arm only the wake side and warn — kept in the
// result so the conflict stays observable.
export function groupHotkeyBindings(
  globalWake: string,
  globalOff: string,
  deviceConfigs: Record<string, DeviceConfig>,
): Map<string, AccelBindings> {
  const result = new Map<string, AccelBindings>();
  const target = (accel: string, kind: "wake" | "off"): HotkeyTarget | null => {
    if (!accel.trim()) return null;
    const bindings = result.get(accel.trim()) ?? {};
    const t = (bindings[kind] ??= { includeSelected: false, deviceIds: [] });
    result.set(accel.trim(), bindings);
    return t;
  };

  const globalWakeTarget = target(globalWake, "wake");
  if (globalWakeTarget) globalWakeTarget.includeSelected = true;
  const globalOffTarget = target(globalOff, "off");
  if (globalOffTarget) globalOffTarget.includeSelected = true;

  for (const [deviceId, cfg] of Object.entries(deviceConfigs)) {
    for (const kind of ["wake", "off"] as const) {
      const t = target(cfg[`${kind}Hotkey`] ?? "", kind);
      if (t && !t.deviceIds.includes(deviceId)) t.deviceIds.push(deviceId);
    }
  }

  return result;
}

// Boot window

// True if the system booted within `windowSeconds` (i.e. the daemon started near boot).
export function isWithinBootWindow(uptimeSeconds: number, windowSeconds = 120): boolean {
  return uptimeSeconds < windowSeconds;
}

// Retry helper

// Run `op` until it resolves without throwing, up to `attempts` times, awaiting `delayMs` (via the
// injected `sleep`) between tries. Returns once an attempt succeeds; rethrows the last error if
// every attempt fails. `onRetry` is called before each wait with the failed attempt number and its
// error. Sleep is injected so the logic is timer-free and unit-testable.
//
// Used for the wake/boot TV trigger: right after the PC resumes, the network stack may not have
// finished reconnecting, so the first app.switch() calls (token refresh, device lookup, device
// commands) can fail until it's back — the delay between tries is what lets the retry window
// outlast the reconnect.
export async function withRetry(
  op: () => Promise<void>,
  attempts: number,
  delayMs: number,
  sleep: (ms: number) => Promise<void>,
  onRetry?: (attempt: number, err: unknown) => void,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await op();
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      onRetry?.(attempt, err);
      await sleep(delayMs);
    }
  }
}

// Trigger cooldown gate (timer-free state machine)

// Serializes triggers: a new trigger is rejected while one is running (busy) or within
// `cooldownMs` after the last one settled. Equivalent to the old `busy` flag + setTimeout,
// but holds no timer — callers pass the current time in.
export class TriggerGate {
  private busy = false;
  private cooldownUntil = 0;

  constructor(private readonly cooldownMs: number) {}

  // Returns true and marks busy if a trigger may start at `now`; false otherwise.
  tryAcquire(now: number): boolean {
    if (this.busy || now < this.cooldownUntil) return false;
    this.busy = true;
    return true;
  }

  // Call when a handler settles; opens a cooldown window of `cooldownMs` from `now`.
  release(now: number): void {
    this.busy = false;
    this.cooldownUntil = now + this.cooldownMs;
  }
}

// Wake detection (timer-free state machine)

// Detects a sleep/wake gap from heartbeat ticks. Feed each tick's timestamp; a gap of at
// least `gapMs` since the previous tick (outside the pause window) means the PC slept and
// woke. After firing, detection is paused for `pauseMs`.
export class WakeDetector {
  private last: number;
  private pausedUntil = 0;

  constructor(
    private readonly gapMs: number,
    private readonly pauseMs: number,
    startNow: number,
  ) {
    this.last = startNow;
  }

  // Returns the approximate sleep duration (ms) if a wake is detected at `now`, else null.
  tick(now: number): number | null {
    const gap = now - this.last;
    this.last = now;
    if (gap >= this.gapMs && now >= this.pausedUntil) {
      this.pausedUntil = now + this.pauseMs;
      return gap;
    }
    return null;
  }
}
