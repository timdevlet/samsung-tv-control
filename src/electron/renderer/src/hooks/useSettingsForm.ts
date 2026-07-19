import { useEffect, useRef, useState } from "react";
import type { AppSettings, CommandSettings, DeviceConfigSettings, ThemePreference } from "../types";

export interface SettingsDraft {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  minimizeToTrayOnClose: boolean;
  selectedDeviceIds: ReadonlySet<string>;
  // Per-TV settings keyed by deviceId; "" = unset (entries are pruned on save by the
  // main process when every field is empty).
  deviceConfigs: Record<string, DeviceConfigSettings>;
  theme: ThemePreference;
  // User-defined command list, in display order; persisted as a whole-list replace.
  commands: CommandSettings[];
}

const EMPTY_DEVICE_CONFIG: DeviceConfigSettings = {
  alias: "",
  description: "",
  host: "",
  mac: "",
  inputKeySeq: "",
  keyDelay: "",
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
    minimizeToTrayOnClose: initial.minimizeToTrayOnClose,
    selectedDeviceIds: new Set(initial.selectedDeviceIds),
    deviceConfigs: initial.deviceConfigs,
    theme: initial.theme,
    commands: initial.commands,
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

  // Make exactly one TV the selected/controlled one — replaces the whole set with {deviceId}. The
  // TV control list is single-select, so selecting a TV both edits it and makes it what "All TVs"
  // commands act on. selectedDeviceIds stays a set on disk (a one-element array), so the daemon's
  // "act on the selected TVs" path is unchanged.
  const selectOnlyDevice = (deviceId: string) =>
    setDraft((d) => ({ ...d, selectedDeviceIds: new Set([deviceId]) }));

  const setDeviceConfig = <K extends keyof DeviceConfigSettings>(
    deviceId: string,
    key: K,
    value: DeviceConfigSettings[K],
  ) =>
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

  // Command-list edits: append, drop by id, patch fields of one row by id.
  const addCommand = (cmd: CommandSettings) =>
    setDraft((d) => ({ ...d, commands: [...d.commands, cmd] }));

  const removeCommand = (id: string) =>
    setDraft((d) => ({ ...d, commands: d.commands.filter((c) => c.id !== id) }));

  const setCommand = (id: string, patch: Partial<CommandSettings>) =>
    setDraft((d) => ({
      ...d,
      commands: d.commands.map((c) => (c.id === id ? { ...c, ...patch } : c)),
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
  // Mount/unmount only: flush the pending save on unmount. flush reads a ref, so the first-render
  // closure always sees the latest save — adding it as a dep would re-run this every render.
  useEffect(() => () => void flush(), []);

  return {
    draft,
    set,
    toggleDevice,
    selectOnlyDevice,
    setDeviceConfig,
    addCommand,
    removeCommand,
    setCommand,
    error,
    setError,
    flush,
  };
}
