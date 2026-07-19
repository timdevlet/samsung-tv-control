import { useCallback, useEffect, useState } from "react";
import type { STDevice } from "../types";

export type DeviceListState =
  | { kind: "loading" }
  | { kind: "message"; text: string }
  | { kind: "ready"; devices: STDevice[] };

// Loads the account's TVs on mount (the settings overlay mounts fresh on every open).
// `reload` refetches — used after signing in from inside the overlay.
export function useDeviceList(): { state: DeviceListState; reload: () => void } {
  const [state, setState] = useState<DeviceListState>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    window.tvAPI
      .listTVs()
      .then((res) => {
        if (!alive) return;
        if (!res.ok) {
          // Not signed in is the expected pre-auth state, not an error — show the sign-in prompt.
          const text = res.notAuthorized || !res.error ? "Sign in to load your TVs." : res.error;
          setState({ kind: "message", text });
        } else if (res.devices.length === 0) {
          setState({ kind: "message", text: "No TVs found — add one in the SmartThings app." });
        } else {
          setState({ kind: "ready", devices: res.devices });
        }
      })
      .catch((err: unknown) => {
        if (alive) {
          setState({ kind: "message", text: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      alive = false;
    };
    // generation is the refetch trigger: reload() bumps it to re-run this effect.
  }, [generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  return { state, reload };
}
