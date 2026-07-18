import type { InputHTMLAttributes } from "react";
import "./NumberInput.scss";

type NumberInputProps = {
  // The raw form string ("" = unset) — kept a string so the field stays a controlled input and
  // in-progress typing ("2.") isn't mangled.
  value: string;
  onValueChange?: (value: string) => void;
  min: number;
  max: number;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max" | "type">;

// Numeric input with the app's text-input styling (Field.scss): decimals allowed, clamped into
// [min, max] on blur. "" stays "" (unset) — clearing the field is meaningful, not an error.
export function NumberInput({ value, onValueChange, min, max, className, ...rest }: NumberInputProps) {
  const clamp = () => {
    if (value.trim() === "") return;
    const n = Number(value);
    if (!Number.isFinite(n)) {
      onValueChange?.("");
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    if (clamped !== n) onValueChange?.(String(clamped));
  };
  return (
    <input
      className={["number-input", className].filter(Boolean).join(" ")}
      type="number"
      inputMode="decimal"
      step="any"
      autoComplete="off"
      spellCheck={false}
      min={min}
      max={max}
      value={value}
      onChange={(e) => onValueChange?.(e.currentTarget.value)}
      onBlur={clamp}
      {...rest}
    />
  );
}
