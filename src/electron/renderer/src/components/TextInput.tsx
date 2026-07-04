import type { InputHTMLAttributes, Ref } from "react";

type TextInputProps = {
  value: string;
  onValueChange?: (value: string) => void;
  ref?: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">;

// Text input with the app's defaults (no autocomplete/spellcheck). Override `type` for password
// fields; `ref` works as a regular prop (React 19).
export function TextInput({ value, onValueChange, ...rest }: TextInputProps) {
  return (
    <input
      type="text"
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={(e) => onValueChange?.(e.currentTarget.value)}
      {...rest}
    />
  );
}
