import type { ReactNode } from "react";
import "./MutedMessage.scss";

// Muted single-line message (device list loading / error / empty states).
export function MutedMessage({ children }: { children: ReactNode }) {
  return <div className="muted-message">{children}</div>;
}
