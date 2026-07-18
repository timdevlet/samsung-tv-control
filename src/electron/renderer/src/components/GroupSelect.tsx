import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "./icons";
import "./GroupSelect.scss";

export type GroupSelectOption = {
  value: string;
  label: string;
};

export type GroupSelectGroup = {
  label: string;
  options: readonly GroupSelectOption[];
};

// An action picker styled like SelectMenu (trigger button + floating panel), but holding no value:
// the options are grouped under headings and clicking one fires onSelect. The panel stays OPEN
// after a pick — the use case is firing several in a row (e.g. appending keys to a sequence) —
// and closes on outside click, Escape, or a trigger re-click.
export function GroupSelect({
  groups,
  onSelect,
  triggerLabel,
  ariaLabel,
  disabled = false,
  className,
}: {
  groups: readonly GroupSelectGroup[];
  onSelect: (value: string) => void;
  triggerLabel: string;
  ariaLabel?: string;
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

  return (
    <div ref={rootRef} className={["groupselect", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        className="groupselect-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled || groups.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerLabel}
        <ChevronDownIcon size={16} className={open ? "chev open" : "chev"} />
      </button>
      {open && (
        <div className="groupselect-panel" role="menu" aria-label={ariaLabel}>
          {groups.map((g) => (
            <div key={g.label} role="group" aria-label={g.label} className="groupselect-group">
              <div aria-hidden="true" className="groupselect-heading">
                {g.label}
              </div>
              {g.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="menuitem"
                  className="groupselect-option"
                  onClick={() => onSelect(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
