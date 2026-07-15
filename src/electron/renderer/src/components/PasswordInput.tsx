import { useState } from "react";
import type { InputHTMLAttributes, Ref } from "react";
import { TextInput } from "./TextInput";
import { IconButton } from "./IconButton";
import "./PasswordInput.scss";

type PasswordInputProps = {
  value: string;
  onValueChange?: (value: string) => void;
  ref?: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">;

// Masked input for secrets (e.g. the OAuth client secret): a TextInput rendered as a password
// field, with an eye button that toggles the value visible while editing.
export function PasswordInput(props: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="password-input">
      <TextInput type={revealed ? "text" : "password"} {...props} />
      <IconButton
        className="password-reveal"
        title={revealed ? "Hide" : "Show"}
        aria-label={revealed ? "Hide value" : "Show value"}
        onClick={() => setRevealed((r) => !r)}
      >
        {revealed ? <EyeOffIcon /> : <EyeIcon />}
      </IconButton>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.75 8C1.75 8 4.25 3.75 8 3.75S14.25 8 14.25 8 11.75 12.25 8 12.25 1.75 8 1.75 8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.75" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.75 8C1.75 8 4.25 3.75 8 3.75S14.25 8 14.25 8 11.75 12.25 8 12.25 1.75 8 1.75 8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M2.75 2.75l10.5 10.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
