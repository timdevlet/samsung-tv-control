import type { ButtonHTMLAttributes } from "react";
import { TvFrame } from "./icons";
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
    <TvFrame size={14}>
      <path
        d="M6.25 5.25l3.5 3.5M9.75 5.25l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </TvFrame>
  );
}
