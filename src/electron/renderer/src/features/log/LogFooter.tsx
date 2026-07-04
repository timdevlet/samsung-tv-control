import { LabeledCheckbox } from "../../components/LabeledCheckbox";
import "./LogFooter.scss";

export function LogFooter({
  autoScroll,
  onAutoScrollChange,
  count,
}: {
  autoScroll: boolean;
  onAutoScrollChange: (checked: boolean) => void;
  count: number;
}) {
  return (
    <footer>
      <LabeledCheckbox checked={autoScroll} onChange={onAutoScrollChange}>
        Auto-scroll
      </LabeledCheckbox>
      <span className="count">
        {count} {count === 1 ? "line" : "lines"}
      </span>
    </footer>
  );
}
