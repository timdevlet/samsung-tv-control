import type { ButtonHTMLAttributes } from "react";
import "./IconButton.scss";

type IconButtonProps = {
  // Icon-only buttons have no visible text, so a label for screen readers is mandatory.
  "aria-label": string;
} & ButtonHTMLAttributes<HTMLButtonElement>;

// A square button that holds a single SVG icon (passed as children).
export function IconButton({ className, children, ...rest }: IconButtonProps) {
  const classes = ["icon-button", className].filter(Boolean).join(" ");
  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  );
}

export function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
