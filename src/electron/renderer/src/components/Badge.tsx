import type { ReactNode } from "react";
import "./Badge.scss";

// Small uppercase pill (e.g. the "Cloud" badge marking a SmartThings-listed TV).
export function Badge({ children }: { children: ReactNode }) {
  return <span className="source-badge">{children}</span>;
}
