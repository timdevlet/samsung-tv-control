import type { ReactNode } from "react";
import "./CollapsibleGroup.scss";

// Controlled <details> — the collapsed-by-default "Advanced" group. The browser toggles the
// element natively on summary click; onToggle reports the new state back into React state.
export function CollapsibleGroup({
  summary,
  detail,
  open,
  onToggle,
  children,
}: {
  summary: ReactNode;
  detail?: ReactNode;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details className="group" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary>
        {summary}
        {detail && <small>{detail}</small>}
      </summary>
      <div className="group-body">{children}</div>
    </details>
  );
}
