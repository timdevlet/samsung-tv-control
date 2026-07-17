import { useEffect, useId, useRef, useState } from "react";
import { ChevronDownIcon } from "./icons";
import "./SelectMenu.scss";

export type SelectMenuOption = {
  value: string;
  label: string;
};

// A single-value dropdown styled to match MultiSelect (trigger button + floating checkbox-less
// panel), used where a native <Select> would be. Unlike Select, the trigger sizes to its content
// (the widest option label, via a hidden sizer) rather than stretching to the field width — so a
// row of these fits its controls instead of each one running full width.
export function SelectMenu({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled = false,
  className,
}: {
  value: string;
  options: readonly SelectMenuOption[];
  onValueChange: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

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

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className={["selectmenu", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        className="selectmenu-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled || options.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        {/* The visible label is overlaid on a hidden stack of every option, so the trigger's width
            is the widest label and never jumps when the selection changes. */}
        <span className="selectmenu-value">
          <span className="selectmenu-current">{selected?.label ?? ""}</span>
          <span aria-hidden="true" className="selectmenu-sizers">
            {options.map((o) => (
              <span key={o.value} className="selectmenu-sizer">
                {o.label}
              </span>
            ))}
          </span>
        </span>
        <ChevronDownIcon size={16} className={open ? "chev open" : "chev"} />
      </button>
      {open && options.length > 0 && (
        <div className="selectmenu-panel" role="listbox" aria-label={ariaLabel}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={o.value === value ? "selectmenu-option selected" : "selectmenu-option"}
              id={`${listId}-${o.value}`}
              onClick={() => {
                onValueChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
