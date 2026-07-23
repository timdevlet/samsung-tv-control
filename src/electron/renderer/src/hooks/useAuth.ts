import { useSyncExternalStore } from "react";
import { authStore } from "../stores/authStore";

// React binding for the shared auth store (stores/authStore). Deliberately no fetch on mount:
// auth only matters once Settings opens, so the caller decides when to refresh (and can await
// the fresh status — the sign-in flow lives in Settings and calls refresh so every consumer
// tracks the result).
export function useAuth() {
  const status = useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
  return { status, refresh: authStore.refresh };
}
