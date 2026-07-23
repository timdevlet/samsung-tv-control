import { useCallback, useEffect, useState } from "react";
import type { DevicePower } from "../types";

// How often to re-probe while the list is on screen. The hook only lives inside the Settings
// surface, so unmounting the page stops the polling with it.
const POLL_MS = 10_000;

// Fetches the live power of each TV in `deviceIds` for the Settings list's status pills. One
// batched IPC (main builds the transport once), re-run every POLL_MS while mounted, whenever the
// id set changes, or when refresh() is called. A TV not yet in the map reads as "unknown" (the
// "Checking…" state) so rows render a muted dot until the first probe returns; later polls keep
// the last-known map, so pills update in place instead of flashing back to "Checking…".
// Best-effort: a failed batch just leaves everything as it was.
//
// The id set is compared by value (joined key), not reference, so a parent that recomputes the
// array each render doesn't trigger an endless refetch.

// Last successful probe result, kept across mounts: Settings mounts fresh on every tab visit, so
// seeding from this shows the previous on/off pills instead of "Checking…" while the mount probe
// runs. A pill can be stale for up to that one round trip.
let lastKnown: Record<string, DevicePower> = {};

export function useDeviceStatuses(deviceIds: string[]): {
  statuses: Record<string, DevicePower>;
  refresh: () => void;
} {
  const [statuses, setStatuses] = useState<Record<string, DevicePower>>(() => lastKnown);
  const [generation, setGeneration] = useState(0);
  const key = deviceIds.join("|");

  useEffect(() => {
    const ids = key ? key.split("|") : [];
    if (ids.length === 0) {
      setStatuses({});
      return;
    }
    let alive = true;
    const probe = () => {
      window.tvAPI
        .getStatuses(ids)
        .then((res) => {
          if (alive && res.ok) {
            lastKnown = res.statuses;
            setStatuses(res.statuses);
          }
        })
        .catch(() => {
          // Leave the last-known map in place; rows fall back to "unknown" for missing ids.
        });
    };
    probe();
    const timer = setInterval(probe, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // key is the value-identity of deviceIds; generation is the manual refresh trigger.
  }, [key, generation]);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  return { statuses, refresh };
}
