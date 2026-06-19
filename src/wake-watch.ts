// Heartbeat-based PC wake detection, cross-platform (no PowerShell/WMI).
//
// A timer records the wall-clock time every few seconds. While the PC is asleep the event
// loop is frozen, so the timer can't fire — when the machine resumes, the next tick lands far
// later than expected. A gap that's much larger than the tick interval means the PC was asleep
// and just woke up. The gap size also approximates how long it slept.
//
// The gap/pause math lives in domain.WakeDetector (pure, testable); this file is the adapter
// that drives it on a real interval via the injected Clock.

import { WakeDetector } from "./domain.js";
import type { Clock, WakeNotifier } from "./interfaces.js";

const TICK_MS = 3000;
/** A tick this far (or more) past the previous one means the loop was frozen → the PC slept. */
const WAKE_GAP_MS = 10_000;
/** After firing onResume, ignore further wake detections for this long. */
const PAUSE_MS = 5 * 60_000;

/** A WakeNotifier driven by a heartbeat on the given Clock. */
export function heartbeatWakeNotifier(clock: Clock): WakeNotifier {
  let handle: ReturnType<Clock["setInterval"]> | undefined;
  return {
    start(onResume) {
      const detector = new WakeDetector(WAKE_GAP_MS, PAUSE_MS, clock.now());
      handle = clock.setInterval(() => {
        const slept = detector.tick(clock.now());
        if (slept != null) onResume(slept);
      }, TICK_MS);
    },
    stop() {
      if (handle != null) clock.clearInterval(handle);
      handle = undefined;
    },
  };
}
