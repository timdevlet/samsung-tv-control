import type { LogEntry } from "../../types";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import { ScrollArea } from "../../components/ScrollArea";
import { LogLine } from "./LogLine";
import "./LogView.scss";

// The scrolling log pane. The auto-scroll hook needs the real scrolling element —
// OverlayScrollbars' viewport — which only exists once the instance reports `initialized`.
// The empty state is an explicit element: the host is never :empty anymore (the library
// nests its own wrappers inside), so the old .log:empty::after trick can't work.
export function LogView({ entries, autoScroll }: { entries: LogEntry[]; autoScroll: boolean }) {
  const scroll = useAutoScroll(entries.length, autoScroll);
  return (
    <ScrollArea
      className="log"
      role="log"
      aria-live="polite"
      events={{
        initialized: (inst) => scroll.attach(inst.elements().viewport),
        destroyed: () => scroll.detach(),
        scroll: () => scroll.onScroll(),
      }}
    >
      {entries.length === 0 && <span className="log-empty">Waiting for output…</span>}
      {entries.map((entry) => (
        <LogLine key={entry.id} entry={entry} />
      ))}
    </ScrollArea>
  );
}
