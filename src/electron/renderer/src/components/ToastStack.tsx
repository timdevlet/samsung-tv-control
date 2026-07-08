import type { CSSProperties } from "react";
import { MAX_VISIBLE, type Toast, depthOf } from "../lib/toasts";
import "./ToastStack.scss";

// Bottom-center stack of auto-dismissing notification cards. The newest card sits
// in front; older ones peek out above it with a small offset + scale-down (depth
// effect). At most MAX_VISIBLE cards are shown; deeper ones stay in state but are
// hidden. Click a card to dismiss it early.
export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t, i) => {
        const depth = depthOf(toasts, i);
        const cls =
          `toast-card ${t.kind}` +
          (t.leaving ? " leaving" : "") +
          (depth >= MAX_VISIBLE ? " buried" : "");
        return (
          <button
            key={t.id}
            type="button"
            className={cls}
            style={{ "--depth": depth } as CSSProperties}
            onClick={() => onDismiss(t.id)}
          >
            <span className="toast-body">
              <span className="dot" />
              {t.text}
            </span>
          </button>
        );
      })}
    </div>
  );
}
