import { useEffect, useRef, useState } from "react";
import { selectionState, triggerLabel } from "../lib/multiselect";
import { ChevronDownIcon } from "./icons";
import { MultiSelectList, type MultiSelectOption } from "./MultiSelectList";
import "./MultiSelect.scss";

export type { MultiSelectOption };

// A dropdown that selects any subset of its options via checkboxes. The collapsed trigger shows a
// counter only ("No TVs", "1 TV", "3 TVs", "All TVs") — never the names — so the control stays a
// fixed width regardless of how many are picked. Opening it reveals the shared MultiSelectList
// (a "(Select all)" row plus one checkbox per option); the always-visible inline variant renders
// that same list without this trigger.
export function MultiSelect({
  options,
  selected,
  onChange,
  ariaLabel,
  // Shown as the trigger text when there are no options to choose from (loading / not signed in).
  placeholder,
  // The singular/plural noun for the counter ("TV" → "1 TV" / "2 TVs").
  noun = "item",
  // When true, a zero selection reads "All {noun}s" instead of "No {noun}s" — for callers where an
  // empty list means "fall back to everything" (a command's target list).
  emptyMeansAll = false,
  disabled = false,
  className,
}: {
  options: readonly MultiSelectOption[];
  selected: ReadonlySet<string>;
  onChange: (value: string, checked: boolean) => void;
  ariaLabel?: string;
  placeholder?: string;
  noun?: string;
  emptyMeansAll?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const { count, total } = selectionState(
    options.map((o) => o.value),
    selected,
  );
  const triggerText = triggerLabel(count, total, noun, placeholder ?? "None", emptyMeansAll);

  return (
    <div ref={rootRef} className={["multiselect", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        className="multiselect-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled || total === 0}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="multiselect-value">{triggerText}</span>
        <ChevronDownIcon size={16} className={open ? "chev open" : "chev"} />
      </button>
      {open && total > 0 && (
        <div
          className="multiselect-panel"
          role="listbox"
          aria-label={ariaLabel}
          aria-multiselectable
        >
          <MultiSelectList options={options} selected={selected} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
