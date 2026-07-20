import { useCallback, useEffect, useState } from "react";
import type { DevicePower } from "../types";

// Fetches the live power of each TV in `deviceIds` for the Settings list's status pills. One
// batched IPC (main builds the transport once), re-run whenever the id set changes or refresh() is
// called. A TV not yet in the map reads as "unknown" (the "Checking…" state) so rows render a
// muted dot until the probe returns. Best-effort: a failed batch just leaves everything "unknown".
//
// The id set is compared by value (joined key), not reference, so a parent that recomputes the
// array each render doesn't trigger an endless refetch.
export function useDeviceStatuses(deviceIds: string[]): {
  statuses: Record<string, DevicePower>;
  refresh: () => void;
} {
  const [statuses, setStatuses] = useState<Record<string, DevicePower>>({});
  const [generation, setGeneration] = useState(0);
  const key = deviceIds.join("|");

  useEffect(() => {
    const ids = key ? key.split("|") : [];
    if (ids.length === 0) {
      setStatuses({});
      return;
    }
    let alive = true;
    window.tvAPI
      .getStatuses(ids)
      .then((res) => {
        if (alive && res.ok) setStatuses(res.statuses);
      })
      .catch(() => {
        // Leave the last-known map in place; rows fall back to "unknown" for missing ids.
      });
    return () => {
      alive = false;
    };
    // key is the value-identity of deviceIds; generation is the manual refresh trigger.
  }, [key, generation]);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  return { statuses, refresh };
}
