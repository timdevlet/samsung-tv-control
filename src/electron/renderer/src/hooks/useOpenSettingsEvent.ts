import { useEffect, useRef } from "react";

// Tray "Settings…" → open the overlay. Latest-ref handler so the IPC subscription is created
// once; the returned unsubscribe function is the effect cleanup.
export function useOpenSettingsEvent(handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => window.tvAPI.onOpenSettings(() => ref.current()), []);
}
