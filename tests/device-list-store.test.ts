import { describe, expect, it } from "vitest";
import {
  createDeviceListStore,
  type DeviceListState,
  toDeviceListState,
} from "../src/electron/renderer/src/stores/deviceListStore.js";
import type { STDevice } from "../src/domain/tv.js";

const tv = (id: string): STDevice => ({
  deviceId: id,
  label: `TV ${id}`,
  name: id,
  capabilities: ["switch"],
});

type ListResult = Parameters<typeof toDeviceListState>[0];

// One controllable fetch per load() call, resolved/rejected by the test in any order.
function stubFetcher() {
  const pending: {
    resolve: (r: ListResult) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const fetch = () =>
    new Promise<ListResult>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  return { fetch, pending };
}

// Flush the store's .then chains after settling a stub promise.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("toDeviceListState", () => {
  it("maps a device list to ready", () => {
    expect(toDeviceListState({ ok: true, devices: [tv("a")] })).toEqual({
      kind: "ready",
      devices: [tv("a")],
    });
  });

  it("maps an empty list to the no-TVs message", () => {
    expect(toDeviceListState({ ok: true, devices: [] })).toEqual({
      kind: "message",
      text: "No TVs found — add one in the SmartThings app.",
    });
  });

  it("maps notAuthorized (and errorless failures) to the sign-in prompt", () => {
    expect(toDeviceListState({ ok: false, error: "401", notAuthorized: true })).toEqual({
      kind: "message",
      text: "Sign in to load your TVs.",
    });
    expect(toDeviceListState({ ok: false, error: "" })).toEqual({
      kind: "message",
      text: "Sign in to load your TVs.",
    });
  });

  it("maps other failures to their error text", () => {
    expect(toDeviceListState({ ok: false, error: "boom" })).toEqual({
      kind: "message",
      text: "boom",
    });
  });
});

describe("createDeviceListStore", () => {
  it("starts loading and becomes ready on the first result", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createDeviceListStore(fetch);
    expect(store.getSnapshot()).toEqual({ kind: "loading" });

    store.ensureFresh();
    expect(store.getSnapshot()).toEqual({ kind: "loading" }); // no data yet — nothing to keep showing
    pending[0].resolve({ ok: true, devices: [tv("a")] });
    await tick();
    expect(store.getSnapshot()).toEqual({ kind: "ready", devices: [tv("a")] });
  });

  it("revalidates without ever returning to loading", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createDeviceListStore(fetch);
    store.ensureFresh();
    pending[0].resolve({ ok: true, devices: [tv("a")] });
    await tick();

    store.ensureFresh(); // e.g. Settings mounted again
    expect(store.getSnapshot()).toEqual({
      kind: "ready",
      devices: [tv("a")],
      refreshing: true, // cached list still showing while the refetch runs
    });
    pending[1].resolve({ ok: true, devices: [tv("a"), tv("b")] });
    await tick();
    expect(store.getSnapshot()).toEqual({ kind: "ready", devices: [tv("a"), tv("b")] });
  });

  it("coalesces concurrent ensureFresh calls into one fetch", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createDeviceListStore(fetch);
    store.ensureFresh();
    store.ensureFresh(); // StrictMode's doubled dev effect / two views mounting
    expect(pending).toHaveLength(1);
    pending[0].resolve({ ok: true, devices: [tv("a")] });
    await tick();
    expect(store.getSnapshot()).toEqual({ kind: "ready", devices: [tv("a")] });

    store.ensureFresh(); // after settling, a new revalidate does fetch again
    expect(pending).toHaveLength(2);
  });

  it("lets a forced refresh supersede an in-flight fetch (latest wins)", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createDeviceListStore(fetch);
    store.ensureFresh();
    store.refresh(); // e.g. pairing finished while the mount revalidate was still out
    expect(pending).toHaveLength(2);

    pending[1].resolve({ ok: true, devices: [tv("a"), tv("paired")] });
    await tick();
    pending[0].resolve({ ok: true, devices: [tv("a")] }); // stale result lands last…
    await tick();
    expect(store.getSnapshot()).toEqual({
      kind: "ready",
      devices: [tv("a"), tv("paired")], // …and is discarded
    });
  });

  it("keeps the cached list when a background revalidate throws", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createDeviceListStore(fetch);
    store.ensureFresh();
    pending[0].resolve({ ok: true, devices: [tv("a")] });
    await tick();

    store.ensureFresh();
    pending[1].reject(new Error("ipc gone"));
    await tick();
    expect(store.getSnapshot()).toEqual({ kind: "ready", devices: [tv("a")] }); // refreshing cleared
  });

  it("reports a forced refresh failure instead of hiding it", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createDeviceListStore(fetch);
    store.ensureFresh();
    pending[0].resolve({ ok: true, devices: [tv("a")] });
    await tick();

    store.refresh();
    pending[1].reject(new Error("ipc gone"));
    await tick();
    expect(store.getSnapshot()).toEqual({ kind: "message", text: "ipc gone" });
  });

  it("notifies subscribers on change and stops after unsubscribe", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createDeviceListStore(fetch);
    const seen: DeviceListState[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()));

    store.ensureFresh();
    pending[0].resolve({ ok: true, devices: [tv("a")] });
    await tick();
    expect(seen).toEqual([{ kind: "ready", devices: [tv("a")] }]);

    unsubscribe();
    store.refresh();
    pending[1].resolve({ ok: true, devices: [] });
    await tick();
    expect(seen).toHaveLength(1); // the refreshing + result emits after unsubscribe went unheard
  });

  it("returns an identical snapshot reference between emits", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createDeviceListStore(fetch);
    store.ensureFresh();
    pending[0].resolve({ ok: true, devices: [tv("a")] });
    await tick();
    expect(store.getSnapshot()).toBe(store.getSnapshot()); // useSyncExternalStore contract
  });
});
