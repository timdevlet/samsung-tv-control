import { useEffect, useRef, useState } from "react";
import { captureFromEvent } from "../lib/accelerator";

// Global keydown listener that lives only while capturing. Capture phase (like the vanilla UI)
// so the settings form never sees the keystrokes; the effect cleanup means the listener can't
// outlive the overlay — no explicit stop() needed on close.
export function useHotkeyCapture(opts: {
  onCapture: (accelerator: string) => void;
  onInvalid: (message: string) => void;
}): { capturing: boolean; start: () => void; cancel: () => void } {
  const [capturing, setCapturing] = useState(false);
  // Latest-ref so the effect doesn't re-run on every render's new callback closures.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const result = captureFromEvent(e);
      if (result.kind === "pending") return; // modifier-only press — wait for the real key
      if (result.kind === "cancel") return setCapturing(false); // Escape keeps the previous value
      if (result.kind === "invalid") return optsRef.current.onInvalid(result.reason);
      optsRef.current.onCapture(result.accelerator);
      setCapturing(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing]);

  return {
    capturing,
    start: () => setCapturing(true),
    cancel: () => setCapturing(false),
  };
}
