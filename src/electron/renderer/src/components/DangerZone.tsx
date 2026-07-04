import type { ReactNode } from "react";
import "./DangerZone.scss";

// Destructive actions, set apart from normal settings.
export function DangerZone({
  description,
  children,
}: {
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="danger-zone">
      <p>{description}</p>
      {children}
    </div>
  );
}
