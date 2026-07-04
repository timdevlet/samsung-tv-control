import { useEffect, useRef, useState } from "react";
import type { LogEntry } from "../types";

// Bound the rendered backlog: the daemon logs sparsely, so in practice this never trims, but a
// runaway stream can't grow the DOM forever (the vanilla UI appended nodes unbounded). The
// footer count keeps counting past the cap — it's a separate counter, not entries.length.
const MAX_RENDERED_LINES = 5000;

export function useLogs(): { entries: LogEntry[]; count: number; clear: () => void } {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [count, setCount] = useState(0);
  // Each entry carries a monotonic id from the main process. The history backlog and the live
  // onLog stream can overlap (a line logged right as the window opens lands in both), so dedupe
  // by id to render every line exactly once. A ref, so it also survives StrictMode's dev
  // effect re-run without double-appending.
  const seenIds = useRef(new Set<number>());

  useEffect(() => {
    let alive = true;
    const append = (entry: LogEntry) => {
      if (!alive || seenIds.current.has(entry.id)) return;
      seenIds.current.add(entry.id);
      setCount((c) => c + 1);
      setEntries((prev) =>
        prev.length >= MAX_RENDERED_LINES
          ? [...prev.slice(prev.length - MAX_RENDERED_LINES + 1), entry]
          : [...prev, entry],
      );
    };
    // Subscribe to the live stream BEFORE fetching history so a line logged in the gap isn't
    // lost; the id dedupe renders any overlap between the two sources only once.
    const unsubscribe = window.tvAPI.onLog(append);
    void window.tvAPI.getHistory().then((history) => history.forEach(append));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const clear = () => {
    // Optimistic: wipe the UI immediately; the main-process backlog clears fire-and-forget.
    window.tvAPI.clearHistory();
    seenIds.current.clear();
    setEntries([]);
    setCount(0);
  };

  return { entries, count, clear };
}
