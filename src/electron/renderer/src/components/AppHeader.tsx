import type { ReactNode } from "react";
import "./AppHeader.scss";

// macOS-style glass toolbar, fixed over the content: title on the left (after the traffic
// lights on macOS), the view tabs dead-centered, and contextual actions on the right.
export function AppHeader({
  title,
  tabs,
  actions,
}: {
  title: string;
  tabs?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="app-header">
      <h2 className="title">{title}</h2>
      {tabs && <div className="header-tabs">{tabs}</div>}
      <div className="header-actions">{actions}</div>
    </header>
  );
}
