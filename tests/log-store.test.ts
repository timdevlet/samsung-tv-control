import { describe, expect, it } from "vitest";
import type { LogEntry } from "../src/log.js";
import { createLogStore } from "../src/electron/renderer/src/stores/logStore.js";

const entry = (id: number): LogEntry => ({ id, level: "info", message: `line ${id}` });
const ids = (store: { getSnapshot: () => { entries: LogEntry[] } }) =>
  store.getSnapshot().entries.map((e) => e.id);

// A controllable LogSource: the test emits live lines and settles history fetches by hand.
function stubSource() {
  let live: ((e: LogEntry) => void) | null = null;
  let unsubscribes = 0;
  const history: { resolve: (h: LogEntry[]) => void }[] = [];
  let clears = 0;
  const source = {
    onLog: (cb: (e: LogEntry) => void) => {
      live = cb;
      return () => {
        unsubscribes++;
        live = null;
      };
    },
    getHistory: () =>
      new Promise<LogEntry[]>((resolve) => {
        history.push({ resolve });
      }),
    clearHistory: () => {
      clears++;
    },
  };
  return {
    source,
    emit: (e: LogEntry) => live?.(e),
    history,
    counts: () => ({ unsubscribes, clears }),
  };
}

// Flush the store's .then chains after settling a stub promise.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createLogStore", () => {
  it("merges the live stream with the history backlog, deduped by id", async () => {
    const { source, emit, history } = stubSource();
    const store = createLogStore(source);
    const stop = store.start();

    emit(entry(2)); // logged in the gap between subscribing and the history fetch landing
    history[0].resolve([entry(1), entry(2)]);
    await tick();
    expect(ids(store)).toEqual([2, 1]); // the overlapping line renders exactly once
    expect(store.getSnapshot().count).toBe(2);
    stop();
  });

  it("caps the rendered entries but keeps counting", () => {
    const { source, emit } = stubSource();
    const store = createLogStore(source, 2);
    const stop = store.start();

    [1, 2, 3].forEach((id) => emit(entry(id)));
    expect(ids(store)).toEqual([2, 3]); // oldest trimmed at the cap
    expect(store.getSnapshot().count).toBe(3); // separate counter, not entries.length
    stop();
  });

  it("clear wipes the snapshot and forwards to the source", () => {
    const { source, emit, counts } = stubSource();
    const store = createLogStore(source);
    const stop = store.start();

    emit(entry(1));
    store.clear();
    expect(store.getSnapshot()).toEqual({ entries: [], count: 0 });
    expect(counts().clears).toBe(1);
    emit(entry(2)); // the stream keeps flowing after a clear
    expect(ids(store)).toEqual([2]);
    stop();
  });

  it("a stopped session unsubscribes and discards its late history", async () => {
    const { source, history, counts } = stubSource();
    const store = createLogStore(source);
    const stop = store.start();
    stop();
    expect(counts().unsubscribes).toBe(1);

    history[0].resolve([entry(1)]); // lands after stop…
    await tick();
    expect(ids(store)).toEqual([]); // …and is discarded
  });

  it("restarting re-fetches history without duplicating lines (StrictMode)", async () => {
    const { source, history } = stubSource();
    const store = createLogStore(source);
    store.start()(); // start + immediate stop, like a doubled dev effect
    const stop = store.start();

    history[1].resolve([entry(1)]);
    await tick();
    history[0]?.resolve([entry(1)]); // even if the first fetch settled, dedupe would hold
    await tick();
    expect(ids(store)).toEqual([1]);
    expect(store.getSnapshot().count).toBe(1);
    stop();
  });
});
