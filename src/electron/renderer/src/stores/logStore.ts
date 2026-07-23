// Shared log backlog for the Logs view: the pre-window history and the live stream merged,
// deduped by entry id and capped. Framework-free (React binds via hooks/useLogs) so it's
// unit-testable in the node vitest env like the other stores.

import type { LogEntry } from "../types";
import { api } from "./api";

// Bound the rendered backlog: the daemon logs sparsely, so in practice this never trims, but a
// runaway stream can't grow the DOM forever (the vanilla UI appended nodes unbounded). `count`
// keeps counting past the cap — it's a separate counter, not entries.length.
const MAX_RENDERED_LINES = 5000;

export interface LogSnapshot {
  entries: LogEntry[];
  count: number;
}

// The slice of the preload bridge the store needs, injected so tests can drive it without IPC.
export interface LogSource {
  onLog(cb: (entry: LogEntry) => void): () => void;
  getHistory(): Promise<LogEntry[]>;
  clearHistory(): void;
}

export function createLogStore(source: LogSource, maxRenderedLines = MAX_RENDERED_LINES) {
  let snapshot: LogSnapshot = { entries: [], count: 0 };
  const listeners = new Set<() => void>();
  // Each entry carries a monotonic id from the main process. The history backlog and the live
  // onLog stream can overlap (a line logged right as the window opens lands in both), so dedupe
  // by id to render every line exactly once — which also makes StrictMode's doubled dev effect
  // (start/stop/start, history fetched twice) harmless.
  const seenIds = new Set<number>();

  function emit(next: LogSnapshot): void {
    snapshot = next;
    for (const l of listeners) l();
  }

  function append(entry: LogEntry): void {
    if (seenIds.has(entry.id)) return;
    seenIds.add(entry.id);
    const prev = snapshot.entries;
    const entries =
      prev.length >= maxRenderedLines
        ? [...prev.slice(prev.length - maxRenderedLines + 1), entry]
        : [...prev, entry];
    emit({ entries, count: snapshot.count + 1 });
  }

  return {
    getSnapshot: (): LogSnapshot => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Subscribe to the live stream BEFORE fetching history so a line logged in the gap isn't
    // lost; the id dedupe renders any overlap between the two sources only once. Returns stop;
    // a stopped session's late history result is discarded.
    start(): () => void {
      let alive = true;
      const unsubscribe = source.onLog((entry) => {
        if (alive) append(entry);
      });
      void source.getHistory().then((history) => {
        if (alive) history.forEach(append);
      });
      return () => {
        alive = false;
        unsubscribe();
      };
    },
    // Optimistic: wipe the UI immediately; the main-process backlog clears fire-and-forget.
    clear(): void {
      source.clearHistory();
      seenIds.clear();
      emit({ entries: [], count: 0 });
    },
  };
}

export const logStore = createLogStore(api);
