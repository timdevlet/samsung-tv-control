import type { ReactNode } from "react";
import "./Disclosure.scss";

// Controlled inline <details> for secondary options inside a settings group (e.g. the Account
// group's "Show additional options"). The browser toggles the element natively on summary click;
// onToggle reports the new state back into React state.
export function Disclosure({
  summary,
  open,
  onToggle,
  children,
}: {
  summary: ReactNode;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details className="disclosure" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
