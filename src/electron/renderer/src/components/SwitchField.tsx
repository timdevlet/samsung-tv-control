import type { ReactNode } from "react";
import { ToggleSwitch } from "./ToggleSwitch";
import "./SwitchField.scss";

// Toggle row inside the modal — switch left, clickable label right.
export function SwitchField({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="field check">
      <ToggleSwitch id={id} checked={checked} onChange={onChange} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}
