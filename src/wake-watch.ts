// Heartbeat-based PC wake detection, cross-platform (no PowerShell/WMI).
//
// A timer records the wall-clock time every few seconds. While the PC is asleep the event
// loop is frozen, so the timer can't fire — when the machine resumes, the next tick lands far
// later than expected. A gap that's much larger than the tick interval means the PC was asleep
// and just woke up. The gap size also approximates how long it slept.

const TICK_MS = 3000;
/** A tick this far (or more) past the previous one means the loop was frozen → the PC slept. */
const WAKE_GAP_MS = 10_000;
/** After firing onResume, ignore further wake detections for this long. */
const PAUSE_MS = 5 * 60_000;

export interface WakeWatchHandlers {
  /** Called when a sleep/wake gap is detected. sleptMs ≈ how long the PC was out. */
  onResume?: (sleptMs: number) => void;
}

/**
 * Start watching for PC sleep/wake via a heartbeat. Calls handlers.onResume when a large gap
 * between ticks is detected, then pauses detection for 5 minutes. Returns a stop function.
 */
export function watchWake(handlers: WakeWatchHandlers): () => void {
  let last = Date.now();
  let pausedUntil = 0; // suppress detection until this timestamp
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (gap >= WAKE_GAP_MS && now >= pausedUntil) {
      pausedUntil = now + PAUSE_MS; // pause detection for 5 minutes
      handlers.onResume?.(gap);
    }
  }, TICK_MS);
  timer.unref?.(); // don't keep the process alive on this alone
  return () => clearInterval(timer);
}
