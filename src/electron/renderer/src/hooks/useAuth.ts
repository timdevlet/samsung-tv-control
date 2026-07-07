import { useCallback, useEffect, useState } from "react";
import type { AuthStatus } from "../types";

// Auth status for the header pill. The sign-in flow itself lives in the Settings overlay
// (Account group); it calls refresh so the pill tracks the result.
export function useAuth() {
  const [status, setStatus] = useState<AuthStatus | null>(null);

  const refresh = useCallback(async (): Promise<AuthStatus> => {
    const next = await window.tvAPI.authStatus();
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pillState: "ok" | "off" | "unknown" =
    status === null ? "unknown" : status.authorized ? "ok" : "off";
  const pillText =
    status === null ? "Checking…" : status.authorized ? "" : status.hasClient ? "N/A" : "N/C";

  return { status, pillState, pillText, refresh };
}
