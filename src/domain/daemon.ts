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
}

// True when the configured modifiers are held and `key` is the key going down.
export function matchHotkey(e: KeyEvent, mods: ModifierState, key: string, platform: Platform): boolean {
  if (e.state !== "DOWN" || e.name !== key) return false;
  return platform === "mac" ? mods.meta && mods.ctrl : mods.ctrl && mods.alt;
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
