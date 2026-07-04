import type { ButtonHTMLAttributes } from "react";
import "./Button.scss";

type ButtonProps = {
  variant?: "default" | "primary" | "danger";
} & ButtonHTMLAttributes<HTMLButtonElement>;

// The one <button> — header actions, modal actions, danger zone all use it, colored by variant.
export function Button({ variant = "default", className, ...rest }: ButtonProps) {
  const classes = [variant === "default" ? "" : variant, className].filter(Boolean).join(" ");
  return <button type="button" className={classes || undefined} {...rest} />;
}
