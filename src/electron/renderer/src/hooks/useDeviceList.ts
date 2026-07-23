import { useEffect, useSyncExternalStore } from "react";
import { deviceListStore } from "../stores/deviceListStore";

export type { DeviceListState } from "../stores/deviceListStore";

// The shared device list (stores/deviceListStore). Views mount fresh on every tab switch, so the
// snapshot renders the cached list instantly while a background revalidate runs — no blank
// "loading" flash after the first-ever load. `reload` forces a refetch — used after pairing and
// after signing in/out from inside Settings.
export function useDeviceList() {
  const state = useSyncExternalStore(deviceListStore.subscribe, deviceListStore.getSnapshot);
  useEffect(() => {
    deviceListStore.ensureFresh();
  }, []);
  return { state, reload: deviceListStore.refresh };
}
