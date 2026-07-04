import type { ReactNode } from "react";
import "./StatusPill.scss";

// Dot + short status text. "unknown" keeps the muted dot (the initial "Checking…" state).
export function StatusPill({
  state,
  children,
}: {
  state: "ok" | "off" | "unknown";
  children: ReactNode;
}) {
  return (
    <span className={state === "unknown" ? "status" : `status ${state}`}>
      <span className="dot" />
      {children}
    </span>
  );
}
