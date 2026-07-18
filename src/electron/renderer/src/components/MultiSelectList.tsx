import { useId, type ReactNode } from "react";
import { ToggleSwitch } from "./ToggleSwitch";
import { selectionState } from "../lib/multiselect";
import "./MultiSelectList.scss";

export type MultiSelectOption = {
  value: string;
  // Primary line — plain text or rich content (e.g. a name with a "Cloud" badge).
  label: ReactNode;
  // Optional second line shown muted under the label (device id, model, note).
  subtitle?: ReactNode;
};

// The selection body used by MultiSelect's dropdown panel (Commands target picker). A "(Select
// all)" row at the top toggles every option at once; each option below is a labeled row with an
// optional muted subtitle. It renders no trigger and owns no open/closed state — the caller decides
// where it lives (inside a floating panel or straight in the layout). The "toggle" control is a
// general inline-list mode (macOS switch per row) kept available for reuse.
//
// `control` picks how each row selects: "checkbox" (default) puts a checkbox on the left and shows
// a partial selection as an indeterminate Select-all — right for the compact dropdown menu;
// "toggle" puts a macOS-style switch on the right of each row (a toggle has no indeterminate state,
// so Select-all just reflects whether every option is on) — for the roomier inline list.
export function MultiSelectList({
  options,
  selected,
  onChange,
  control = "checkbox",
  className,
}: {
  options: readonly MultiSelectOption[];
  selected: ReadonlySet<string>;
  onChange: (value: string, checked: boolean) => void;
  control?: "checkbox" | "toggle";
  className?: string;
}) {
  const allId = useId();
  const { allChecked, someChecked } = selectionState(
    options.map((o) => o.value),
    selected,
  );

  const toggleAll = (checked: boolean) => {
    // Emit one change per option that actually flips, so the parent's per-item toggle handler and
    // its change-tracking stay consistent with individual toggles.
    for (const o of options) {
      if (selected.has(o.value) !== checked) onChange(o.value, checked);
    }
  };

  const isToggle = control === "toggle";

  return (
    <div
      className={["multiselect-list", isToggle && "with-toggles", className]
        .filter(Boolean)
        .join(" ")}
    >
      {isToggle ? (
        <div className="multiselect-option multiselect-all">
          <span className="multiselect-text">
            <span className="multiselect-label">(Select all)</span>
          </span>
          <ToggleSwitch
            checked={allChecked}
            onChange={toggleAll}
            aria-label="Select all"
          />
        </div>
      ) : (
        <label className="multiselect-option multiselect-all" htmlFor={allId}>
          <input
            id={allId}
            type="checkbox"
            checked={allChecked}
            ref={(el) => {
              if (el) el.indeterminate = someChecked;
            }}
            onChange={(e) => toggleAll(e.currentTarget.checked)}
          />
          <span className="multiselect-label">(Select all)</span>
        </label>
      )}
      <div className="multiselect-divider" role="separator" />
      {options.map((o) => {
        const id = `${allId}-${o.value}`;
        const checked = selected.has(o.value);
        const text = (
          <span className="multiselect-text">
            <span className="multiselect-label">{o.label}</span>
            {o.subtitle != null && o.subtitle !== "" && (
              <small className="multiselect-subtitle">{o.subtitle}</small>
            )}
          </span>
        );
        return isToggle ? (
          <label key={o.value} className="multiselect-option" htmlFor={id}>
            {text}
            <ToggleSwitch
              id={id}
              checked={checked}
              onChange={(next) => onChange(o.value, next)}
            />
          </label>
        ) : (
          <label key={o.value} className="multiselect-option" htmlFor={id}>
            <input
              id={id}
              type="checkbox"
              checked={checked}
              onChange={(e) => onChange(o.value, e.currentTarget.checked)}
            />
            {text}
          </label>
        );
      })}
    </div>
  );
}
