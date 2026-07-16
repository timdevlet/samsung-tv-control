import "./HintPills.scss";

// A pill is either a bare value (label === value) or a {label, value} pair when the two differ
// (e.g. a "Shared" pill that fills the empty-string "fall back to global" sentinel).
export type Hint = string | { label: string; value: string };

const hintLabel = (h: Hint) => (typeof h === "string" ? h : h.label);
const hintValue = (h: Hint) => (typeof h === "string" ? h : h.value);

// Small gray suggestion pills below an input; clicking one fills the value.
export function HintPills({
  hints,
  onPick,
}: {
  hints: readonly Hint[];
  onPick: (value: string) => void;
}) {
  return (
    <div className="hints">
      {hints.map((h) => (
        <button
          key={hintLabel(h)}
          type="button"
          className="hint"
          onClick={() => onPick(hintValue(h))}
        >
          {hintLabel(h)}
        </button>
      ))}
    </div>
  );
}
