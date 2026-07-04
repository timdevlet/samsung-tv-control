import type { ReactNode } from "react";

// Plain checkbox with a clickable label (the footer's Auto-scroll toggle).
export function LabeledCheckbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />{" "}
      {children}
    </label>
  );
}
