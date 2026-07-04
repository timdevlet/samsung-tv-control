import "./HintPills.scss";
// Small gray suggestion pills below an input; clicking one fills the value.
export function HintPills({
  hints,
  onPick,
}: {
  hints: readonly string[];
  onPick: (value: string) => void;
}) {
  return (
    <div className="hints">
      {hints.map((value) => (
        <button key={value} type="button" className="hint" onClick={() => onPick(value)}>
          {value}
        </button>
      ))}
    </div>
  );
}
