// Pure daemon decision logic — hotkey matching, boot-window check, and the timer-free
// state machines for trigger cooldown and sleep/wake detection. No I/O; the daemon (src/
// daemon.ts) and os/ adapters drive these with real timers and a real clock.

// Hotkey matching

export type Platform = "mac" | "other";

export interface KeyEvent {
  state: string; // "DOWN" | "UP"
  name?: string;
}
export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  shift: boolean;
}

// A parsed hotkey combo: the required key plus the exact modifier set. Parsed once from a
// user-configured accelerator string, then matched against live key events.
export interface Hotkey {
  key: string; // uiohook key name, e.g. "E", "Q", "F8"
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  shift: boolean;
}

// Map an accelerator token (Electron-style, as produced by the renderer's capture UI) to the
// uiohook key name that startKeyListener emits. Modifiers are handled separately; this is only
// for the non-modifier key. Letters/digits pass through uppercased; the rest are explicit so a
// captured "ArrowUp" or "Escape" matches what uiohook reports.
const KEY_ALIASES: Record<string, string> = {
  ESC: "Escape",
  ESCAPE: "Escape",
  SPACE: "Space",
  PLUS: "Equal",
  RETURN: "Enter",
  ENTER: "Enter",
  TAB: "Tab",
  BACKSPACE: "Backspace",
  DELETE: "Delete",
  UP: "ArrowUp",
  DOWN: "ArrowDown",
  LEFT: "ArrowLeft",
  RIGHT: "ArrowRight",
};

// Parse an Electron accelerator string ("Command+Control+E", "Ctrl+Alt+F8") into a Hotkey, or
// return null if it's empty/has no non-modifier key. Modifier names follow Electron's accelerator
// vocabulary (Command/Cmd, Control/Ctrl, Alt/Option, Shift, and the CmdOrCtrl alias). Matching is
// case-insensitive on the token names.
export function parseHotkey(accelerator: string): Hotkey | null {
  if (!accelerator) return null;
  const parts = accelerator.split("+").map((p) => p.trim()).filter(Boolean);
  const hk: Hotkey = { key: "", ctrl: false, alt: false, meta: false, shift: false };
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "command":
      case "cmd":
      case "super":
      case "meta":
        hk.meta = true;
        break;
      case "control":
      case "ctrl":
        hk.ctrl = true;
        break;
      case "cmdorctrl":
      case "commandorcontrol":
        // Resolved per-platform at capture time; treat as meta on mac, ctrl elsewhere isn't known
        // here, so set both and let matching require whichever the event carries.
        hk.meta = true;
        hk.ctrl = true;
        break;
      case "alt":
      case "option":
        hk.alt = true;
        break;
      case "shift":
        hk.shift = true;
        break;
      default: {
        const upper = part.toUpperCase();
        hk.key = KEY_ALIASES[upper] ?? upper;
      }
    }
  }
  return hk.key ? hk : null;
}

// Render a Hotkey as a short human label for logs/menus, using the platform's modifier names
// (mac shows Cmd/Ctrl/Opt; elsewhere Ctrl/Alt). Order matches the common convention.
export function hotkeyLabel(hotkey: Hotkey | null, platform: Platform): string {
  if (!hotkey) return "unset";
  const parts: string[] = [];
  if (hotkey.ctrl) parts.push("Ctrl");
  if (hotkey.alt) parts.push(platform === "mac" ? "Opt" : "Alt");
  if (hotkey.shift) parts.push("Shift");
  if (hotkey.meta) parts.push(platform === "mac" ? "Cmd" : "Win");
  parts.push(hotkey.key);
  return parts.join("+");
}

// True when the event is `hotkey`'s key going down with exactly its modifier set held. The match is
// exact on every modifier so Cmd+Ctrl+E doesn't also fire on Cmd+Ctrl+Shift+E.
export function matchHotkey(e: KeyEvent, mods: ModifierState, hotkey: Hotkey): boolean {
  if (e.state !== "DOWN" || e.name !== hotkey.key) return false;
  return (
    mods.ctrl === hotkey.ctrl &&
    mods.alt === hotkey.alt &&
    mods.meta === hotkey.meta &&
    mods.shift === hotkey.shift
  );
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
// finished reconnecting, so the first app.switch() calls (token refresh, device lookup) can fail
// until it's back.
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
