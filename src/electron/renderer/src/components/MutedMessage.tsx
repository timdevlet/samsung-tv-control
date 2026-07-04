import type { ReactNode } from "react";

// Muted single-line message (device list loading / error / empty states).
export function MutedMessage({ children }: { children: ReactNode }) {
  return <div className="device-empty">{children}</div>;
}
