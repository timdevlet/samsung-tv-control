// Shared device-list store: one snapshot of the account's TVs for every view (Main grid,
// Settings list). Views mount fresh on each tab switch (App conditionally renders them), so
// component state would re-fetch from blank every visit; this module-level store keeps the last
// result across mounts and revalidates in the background — the list renders instantly once it has
// loaded at least once. Framework-free (React binds via useSyncExternalStore in useDeviceList) so
// it's unit-testable in the node vitest env like lib/toasts.ts.

// Type-only import — the preload module itself must never be loaded here (its graph reaches
// node: modules and `process`, which don't exist in the sandboxed renderer); erased at build.
import type { DeviceListResult } from "../../../preload.js";
import type { STDevice } from "../types";

export type DeviceListState =
  | { kind: "loading" } // only before the first-ever result; the store never returns to it
  | { kind: "message"; text: string; refreshing?: boolean }
  | { kind: "ready"; devices: STDevice[]; refreshing?: boolean };

// Map one fetch result to display state. Exported for tests.
export function toDeviceListState(res: DeviceListResult): DeviceListState {
  if (!res.ok) {
    // Not signed in is the expected pre-auth state, not an error — show the sign-in prompt.
    const text = res.notAuthorized || !res.error ? "Sign in to load your TVs." : res.error;
    return { kind: "message", text };
  }
  if (res.devices.length === 0) {
    return { kind: "message", text: "No TVs found — add one in the SmartThings app." };
  }
  return { kind: "ready", devices: res.devices };
}

export function createDeviceListStore(fetchList: () => Promise<DeviceListResult>) {
  let snapshot: DeviceListState = { kind: "loading" };
  const listeners = new Set<() => void>();
  let inflight: Promise<void> | null = null;
  // Monotonic fetch id: only the newest fetch's result is applied, so a forced refresh (which
  // reflects a config change — pairing, sign-in/out) can't be overwritten by a slower, staler
  // background revalidate that started earlier.
  let seq = 0;

  function emit(next: DeviceListState): void {
    snapshot = next;
    for (const l of listeners) l();
  }

  function load(force: boolean): Promise<void> {
    // Coalesce concurrent revalidates (per-mount ensureFresh calls, StrictMode's doubled dev
    // effects) into the one in-flight fetch; only a forced refresh starts a superseding one.
    if (inflight && !force) return inflight;
    const mySeq = ++seq;
    // Keep showing what we have while refetching — never wipe back to "loading".
    if (snapshot.kind !== "loading" && !snapshot.refreshing) {
      emit({ ...snapshot, refreshing: true });
    }
    inflight = fetchList()
      .then((res) => {
        if (mySeq === seq) emit(toDeviceListState(res));
      })
      .catch((err: unknown) => {
        if (mySeq !== seq) return;
        // A background revalidate that fails must not clobber a good cached list; a forced
        // reload was user-initiated, so its failure is reported.
        if (!force && snapshot.kind === "ready") {
          const { refreshing: _, ...rest } = snapshot;
          emit(rest);
        } else {
          emit({ kind: "message", text: err instanceof Error ? err.message : String(err) });
        }
      })
      .finally(() => {
        if (mySeq === seq) inflight = null;
      });
    return inflight;
  }

  return {
    getSnapshot: (): DeviceListState => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // On consumer mount: first-ever call fetches, later calls revalidate the cached snapshot in
    // the background (stale-while-revalidate).
    ensureFresh: (): void => void load(false),
    // Forced refetch after a change the current list can't reflect (pairing, sign-in/out).
    refresh: (): void => void load(true),
  };
}

export const deviceListStore = createDeviceListStore(() => window.tvAPI.listTVs());
