import type { ReactNode } from "react";
import "./ErrorText.scss";

// Shared inline error line. Always rendered (like the vanilla #settingsError node) so the layout
// doesn't jump when a message appears.
export function ErrorText({ children }: { children?: ReactNode }) {
  return <p className="error">{children}</p>;
}
