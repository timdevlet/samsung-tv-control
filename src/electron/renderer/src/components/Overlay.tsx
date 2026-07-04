import type { ReactNode } from "react";
import "./Overlay.scss";

// Full-window dialog. Mounted == open: the parent renders it conditionally, which also resets
// all of its state on every open (the vanilla UI re-populated fields in openSettings() instead).
export function Overlay({ labelledBy, children }: { labelledBy?: string; children: ReactNode }) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      {children}
    </div>
  );
}
