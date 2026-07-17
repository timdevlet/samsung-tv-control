import type { SelectHTMLAttributes } from "react";
import "./Select.scss";

type SelectProps = {
  value: string;
  onValueChange?: (value: string) => void;
  options: readonly { value: string; label: string }[];
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">;

// Native <select> styled like the app's text inputs (Field.scss).
export function Select({ value, onValueChange, options, className, ...rest }: SelectProps) {
  return (
    <select
      className={["select", className].filter(Boolean).join(" ")}
      value={value}
      onChange={(e) => onValueChange?.(e.currentTarget.value)}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
