import { useEffect, useRef, useState } from "react";
import { captureFromEvent, modifiersFromEvent } from "../lib/accelerator";

// Global keydown listener that lives only while capturing. Capture phase (like the vanilla UI)
// so the settings form never sees the keystrokes; the effect cleanup means the listener can't
// outlive the overlay — no explicit stop() needed on close.
export function useHotkeyCapture(opts: {
  onCapture: (accelerator: string) => void;
  onInvalid: (message: string) => void;
}): { capturing: boolean; heldMods: string[]; start: () => void; cancel: () => void } {
  const [capturing, setCapturing] = useState(false);
  // Modifiers currently held during capture (accelerator tokens), for live chip feedback.
  const [heldMods, setHeldMods] = useState<string[]>([]);
  // Latest-ref so the effect doesn't re-run on every render's new callback closures.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const result = captureFromEvent(e);
      // Modifier-only press — show what's held and wait for the real key.
      if (result.kind === "pending") return setHeldMods(modifiersFromEvent(e));
      if (result.kind === "cancel") return setCapturing(false); // Escape keeps the previous value
      if (result.kind === "invalid") return optsRef.current.onInvalid(result.reason);
      optsRef.current.onCapture(result.accelerator);
      setCapturing(false);
    };
    // Releasing a modifier drops its chip; the flags on the keyup event already exclude the
    // released key.
    const onKeyUp = (e: KeyboardEvent) => setHeldMods(modifiersFromEvent(e));
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      setHeldMods([]); // capture ended however it ended — never leave stale chips behind
    };
  }, [capturing]);

  return {
    capturing,
    heldMods,
    start: () => setCapturing(true),
    cancel: () => setCapturing(false),
  };
}
