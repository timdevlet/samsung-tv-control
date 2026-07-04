import type { ReactNode } from "react";
import "./AppHeader.scss";

// Universal header — one component, one style, shared by the main screen and Settings. Children
// (status pill, buttons) render after the title, which pushes them right via margin-right: auto.
export function AppHeader({
  title,
  subtitle,
  titleId,
  children,
}: {
  title: string;
  subtitle?: string;
  titleId?: string;
  children?: ReactNode;
}) {
  return (
    <div className="app-header">
      <h2 className="title" id={titleId}>
        {title}
        {subtitle && <small>{subtitle}</small>}
      </h2>
      {children}
    </div>
  );
}
