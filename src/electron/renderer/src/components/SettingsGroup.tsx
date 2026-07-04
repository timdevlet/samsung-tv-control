import type { ReactNode } from "react";
import "./SettingsGroup.scss";

// A raised card collecting related settings — panel surface, rounded border, 20px padding.
export function SettingsGroup({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-group">
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}
