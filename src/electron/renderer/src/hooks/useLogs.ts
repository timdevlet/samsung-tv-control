import { useEffect, useSyncExternalStore } from "react";
import { logStore } from "../stores/logStore";
import type { LogEntry } from "../types";

// React binding for the shared log store (stores/logStore), which merges the history backlog
// with the live stream, dedupes by entry id, and caps the rendered backlog.
export function useLogs(): { entries: LogEntry[]; count: number; clear: () => void } {
  const { entries, count } = useSyncExternalStore(logStore.subscribe, logStore.getSnapshot);
  useEffect(() => logStore.start(), []);
  return { entries, count, clear: logStore.clear };
}
