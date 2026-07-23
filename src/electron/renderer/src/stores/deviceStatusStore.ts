// Shared power-status store for the TV list's status pills. The last successful probe is kept
// across mounts (Settings mounts fresh on every tab visit), so rows show the previous on/off
// state instead of "Checking…" while the mount probe runs; a TV missing from the map reads as
// "unknown". Framework-free (React binds via useSyncExternalStore in hooks/useDeviceStatuses) so
// it's unit-testable in the node vitest env like the other stores.

import type { DevicePower } from "../types";
import { api, type DeviceStatusResult } from "./api";

// How often to re-probe while a consumer is polling. Polling stops with its consumer's unmount,
// so leaving the surface that shows the pills stops the traffic with it.
const POLL_MS = 10_000;

export function createDeviceStatusStore(
  fetchStatuses: (ids: string[]) => Promise<DeviceStatusResult>,
  pollMs = POLL_MS,
) {
  let snapshot: Record<string, DevicePower> = {};
  const listeners = new Set<() => void>();
  // Active polling sessions (one per mounted consumer), so refresh() can re-probe them all.
  const sessions = new Set<{ probe: () => void }>();

  function emit(next: Record<string, DevicePower>): void {
    snapshot = next;
    for (const l of listeners) l();
  }

  return {
    getSnapshot: (): Record<string, DevicePower> => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Probe `ids` immediately (one batched IPC; main builds the transport once) and again every
    // pollMs until the returned stop function is called. Best-effort: a failed batch leaves the
    // last-known map in place, and a stopped session's late result is discarded so it can't
    // overwrite a fresher snapshot.
    poll(ids: string[]): () => void {
      if (ids.length === 0) return () => {};
      let alive = true;
      const probe = (): void => {
        fetchStatuses(ids)
          .then((res) => {
            if (alive && res.ok) emit(res.statuses);
          })
          .catch(() => {
            // Keep the last-known map; rows fall back to "unknown" for missing ids.
          });
      };
      const session = { probe };
      sessions.add(session);
      probe();
      const timer = setInterval(probe, pollMs);
      return () => {
        alive = false;
        clearInterval(timer);
        sessions.delete(session);
      };
    },
    // Re-probe every active session now — for callers that just changed a TV's power and want
    // the pills to catch up before the next interval tick.
    refresh(): void {
      for (const s of sessions) s.probe();
    },
  };
}

export const deviceStatusStore = createDeviceStatusStore(api.getStatuses);
