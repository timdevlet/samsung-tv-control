import { useEffect, useRef, useState } from "react";
import type { AppSettings, DeviceConfigSettings, ThemePreference, TransportMode } from "../types";

export interface SettingsDraft {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  pcInput: string;
  minimizeToTrayOnClose: boolean;
  wakeHotkey: string;
  offHotkey: string;
  selectedDeviceIds: ReadonlySet<string>;
  // Per-TV settings keyed by deviceId; "" = unset/unbound (entries are pruned on save by the
  // main process when every field is empty).
  deviceConfigs: Record<string, DeviceConfigSettings>;
  theme: ThemePreference;
  // Which transport (cloud/local) commands use.
  transportMode: TransportMode;
}

const EMPTY_DEVICE_CONFIG: DeviceConfigSettings = {
  alias: "",
  description: "",
  pcInput: "",
  wakeHotkey: "",
  offHotkey: "",
  host: "",
  mac: "",
  inputKeySeq: "",
  // Read-only; the pairing IPC flips it via a settings reload, never the draft.
  paired: false,
};

const AUTOSAVE_DEBOUNCE_MS = 400;

// Local draft of the settings form plus the autosave flow: there is no Save button — every
// change is persisted shortly after it's made, and a pending save is flushed on unmount so an
// edit made right before Close isn't lost. `persist` (supplied by the caller) builds the payload
// and returns the inline error to show, or null on success; `error` is the shared inline line
// used by save failures and hotkey-capture validation alike.
export function useSettingsForm(
  initial: AppSettings,
  persist: (draft: SettingsDraft) => Promise<string | null>,
) {
  const [draft, setDraft] = useState<SettingsDraft>({
    clientId: initial.clientId,
    clientSecret: initial.clientSecret,
    redirectUri: initial.redirectUri,
    pcInput: initial.pcInput,
    minimizeToTrayOnClose: initial.minimizeToTrayOnClose,
    wakeHotkey: initial.wakeHotkey,
    offHotkey: initial.offHotkey,
    selectedDeviceIds: new Set(initial.selectedDeviceIds),
    deviceConfigs: initial.deviceConfigs,
    theme: initial.theme,
    transportMode: initial.transportMode,
  });
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const toggleDevice = (deviceId: string, checked: boolean) =>
    setDraft((d) => {
      const next = new Set(d.selectedDeviceIds);
      if (checked) next.add(deviceId);
      else next.delete(deviceId);
      return { ...d, selectedDeviceIds: next };
    });

  const setDeviceConfig = (deviceId: string, key: keyof DeviceConfigSettings, value: string) =>
    setDraft((d) => ({
      ...d,
      deviceConfigs: {
        ...d.deviceConfigs,
        [deviceId]: {
          ...(d.deviceConfigs[deviceId] ?? EMPTY_DEVICE_CONFIG),
          [key]: value,
        },
      },
    }));

  // persistRef keeps the debounce effect keyed on draft changes alone (the persist closure is
  // recreated every render); pending holds the not-yet-fired save so flush/unmount can run it.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const pending = useRef<(() => Promise<void>) | null>(null);
  const skipInitialDraft = useRef(true);

  useEffect(() => {
    // The mount-time draft is what's already on disk — only user edits are saved.
    if (skipInitialDraft.current) {
      skipInitialDraft.current = false;
      return;
    }
    const save = () => {
      pending.current = null;
      return persistRef
        .current(draft)
        .then(setError, (err: unknown) =>
          setError(err instanceof Error ? err.message : String(err)),
        );
    };
    pending.current = save;
    const timer = setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  // Run a still-debouncing save immediately — awaited before sign-in (freshly typed OAuth fields
  // must reach disk for login to see them) and fired on unmount (Close inside the debounce
  // window). `pending` is a ref, so the first-render closure below always sees the latest save.
  const flush = (): Promise<void> => pending.current?.() ?? Promise.resolve();
  useEffect(() => () => void flush(), []);

  return { draft, set, toggleDevice, setDeviceConfig, error, setError, flush };
}
