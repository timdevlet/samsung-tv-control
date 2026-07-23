import { describe, expect, it, vi } from "vitest";
import type { DevicePower } from "../src/domain/tv.js";
import { createDeviceStatusStore } from "../src/electron/renderer/src/stores/deviceStatusStore.js";

type StatusResult = Awaited<ReturnType<Parameters<typeof createDeviceStatusStore>[0]>>;

const ok = (statuses: Record<string, DevicePower>): StatusResult => ({ ok: true, statuses });

// One controllable fetch per probe, resolved/rejected by the test in any order.
function stubFetcher() {
  const calls: string[][] = [];
  const pending: {
    resolve: (r: StatusResult) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const fetch = (ids: string[]) => {
    calls.push(ids);
    return new Promise<StatusResult>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  };
  return { fetch, calls, pending };
}

// Flush the store's .then chains after settling a stub promise.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createDeviceStatusStore", () => {
  it("probes immediately on poll and exposes the result", async () => {
    const { fetch, calls, pending } = stubFetcher();
    const store = createDeviceStatusStore(fetch);
    expect(store.getSnapshot()).toEqual({});

    const seen: Record<string, DevicePower>[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()));
    const stop = store.poll(["a", "b"]);
    expect(calls).toEqual([["a", "b"]]);
    pending[0].resolve(ok({ a: "on", b: "off" }));
    await tick();
    expect(store.getSnapshot()).toEqual({ a: "on", b: "off" });
    expect(seen).toEqual([{ a: "on", b: "off" }]);
    stop();

    unsubscribe();
    store.refresh(); // no sessions left — nothing to probe, nothing heard
    expect(calls).toHaveLength(1);
  });

  it("never probes for an empty id set", () => {
    const { fetch, calls } = stubFetcher();
    const store = createDeviceStatusStore(fetch);
    const stop = store.poll([]);
    expect(calls).toHaveLength(0);
    stop(); // the no-op stop is still callable
  });

  it("keeps the last-known map when a probe fails or reports an error", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createDeviceStatusStore(fetch);
    const stop = store.poll(["a"]);
    pending[0].resolve(ok({ a: "on" }));
    await tick();

    store.refresh();
    pending[1].reject(new Error("ipc gone"));
    await tick();
    expect(store.getSnapshot()).toEqual({ a: "on" });

    store.refresh();
    pending[2].resolve({ ok: false, error: "boom" });
    await tick();
    expect(store.getSnapshot()).toEqual({ a: "on" });
    stop();
  });

  it("re-probes on the interval until stopped", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = stubFetcher();
      const store = createDeviceStatusStore(fetch, 1000);
      const stop = store.poll(["a"]);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toHaveLength(2);
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a stopped session's late result", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createDeviceStatusStore(fetch);
    const stop = store.poll(["a"]);
    stop();
    pending[0].resolve(ok({ a: "on" })); // lands after the consumer unmounted…
    await tick();
    expect(store.getSnapshot()).toEqual({}); // …and must not overwrite the snapshot
  });

  it("refresh re-probes every active session immediately", async () => {
    const { fetch, calls, pending } = stubFetcher();
    const store = createDeviceStatusStore(fetch);
    const stop = store.poll(["a"]);
    pending[0].resolve(ok({ a: "on" }));
    await tick();

    store.refresh();
    expect(calls).toEqual([["a"], ["a"]]);
    pending[1].resolve(ok({ a: "off" }));
    await tick();
    expect(store.getSnapshot()).toEqual({ a: "off" });
    stop();
  });

  it("returns an identical snapshot reference between emits", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createDeviceStatusStore(fetch);
    const stop = store.poll(["a"]);
    pending[0].resolve(ok({ a: "on" }));
    await tick();
    expect(store.getSnapshot()).toBe(store.getSnapshot()); // useSyncExternalStore contract
    stop();
  });
});
