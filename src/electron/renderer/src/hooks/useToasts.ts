import { useCallback, useEffect, useRef, useState } from "react";
import { beginLeave, pushToast, removeToast, type Toast, type ToastKind } from "../lib/toasts";

const AUTO_DISMISS_MS = 3500;
const LEAVE_MS = 250; // matches the .leaving transition in ToastStack.scss

// Owns the toast list and its timers: each toast auto-dismisses AUTO_DISMISS_MS
// after its own creation (so a burst drains oldest-first), with a two-step exit
// (leaving flag → CSS slide-out → removal).
export function useToasts(): {
  toasts: Toast[];
  push: (kind: ToastKind, text: string) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id)); // click and auto-timer don't race
    setToasts((ts) => beginLeave(ts, id));
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setToasts((ts) => removeToast(ts, id));
      }, LEAVE_MS),
    );
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current++;
      setToasts((ts) => {
        const { toasts: next, dropped } = pushToast(ts, { id, kind, text });
        // Idempotent, so safe under StrictMode's double-invoked updater.
        dropped.forEach((d) => {
          clearTimeout(timers.current.get(d));
          timers.current.delete(d);
        });
        return next;
      });
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach(clearTimeout);
  }, []);

  return { toasts, push, dismiss };
}
