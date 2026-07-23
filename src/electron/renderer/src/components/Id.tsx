import { type SyntheticEvent, useState } from "react";
import { shortId } from "../lib/id";
import "./Id.scss";

// A long opaque id rendered as a compact chip: only the last few characters show (the full value
// sits in the title tooltip), and clicking copies the complete id to the clipboard, confirmed by
// a brief shake. A span-with-button-role rather than a real <button> because it nests inside
// interactive rows (the Settings tv-row <button>, the picker's <label>) where a nested button is
// invalid — the handler stops propagation/default so copying never selects the row or flips its
// checkbox.
export function Id({ value, tail = 6 }: { value: string; tail?: number }) {
  const [shaking, setShaking] = useState(false);

  const copy = (e: SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Shake only once the write lands — writeText rejects (e.g. document unfocused) and shaking
    // then would falsely confirm a copy that never happened.
    navigator.clipboard.writeText(value).then(
      () => setShaking(true),
      () => {},
    );
  };

  return (
    <span
      className={shaking ? "id-chip shake" : "id-chip"}
      role="button"
      tabIndex={0}
      title={value}
      aria-label={`Copy ID ${value}`}
      onClick={copy}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") copy(e);
      }}
      onAnimationEnd={() => setShaking(false)}
    >
      {shortId(value, tail)}
    </span>
  );
}
