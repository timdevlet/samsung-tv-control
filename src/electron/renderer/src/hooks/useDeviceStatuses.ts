import { useEffect, useSyncExternalStore } from "react";
import { deviceStatusStore } from "../stores/deviceStatusStore";
import type { DevicePower } from "../types";

// React binding for the shared power-status store (stores/deviceStatusStore): polls the given
// TVs while mounted; the cached map renders instantly on remount so pills update in place
// instead of flashing back to "Checking…". The id set is compared by value (joined key), not
// reference, so a parent that recomputes the array each render doesn't restart the polling.
export function useDeviceStatuses(deviceIds: string[]): {
  statuses: Record<string, DevicePower>;
  refresh: () => void;
} {
  const statuses = useSyncExternalStore(deviceStatusStore.subscribe, deviceStatusStore.getSnapshot);
  const key = deviceIds.join("|");
  useEffect(() => deviceStatusStore.poll(key ? key.split("|") : []), [key]);
  return { statuses, refresh: deviceStatusStore.refresh };
}
