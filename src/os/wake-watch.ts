// Heartbeat-based PC wake detection, cross-platform (no PowerShell/WMI).
//
// A timer records the wall-clock time every few seconds. While the PC is asleep the event
// loop is frozen, so the timer can't fire — when the machine resumes, the next tick lands far
// later than expected. A gap that's much larger than the tick interval means the PC was asleep
// and just woke up. The gap size also approximates how long it slept.
//
// The gap/pause math lives in domain.WakeDetector (pure, testable); this file drives it on a
// real interval.

import { WakeDetector } from "../domain/daemon.js";

const TICK_MS = 3000;
// A tick this far (or more) past the previous one means the loop was frozen → the PC slept.
const WAKE_GAP_MS = 10_000;
// After firing onResume, ignore further wake detections for this long.
const PAUSE_MS = 5 * 60_000;

// Call `onResume(sleptMs)` whenever the PC resumes from sleep. Returns a stop function.
export function onWake(onResume: (sleptMs: number) => void): () => void {
  const detector = new WakeDetector(WAKE_GAP_MS, PAUSE_MS, Date.now());
  const handle = setInterval(() => {
    const slept = detector.tick(Date.now());
    if (slept != null) onResume(slept);
  }, TICK_MS);
  handle.unref?.(); // don't keep the process alive on this timer alone
  return () => clearInterval(handle);
}
