// Main-process helper for the in-window Settings panel: the GUI equivalent of hand-editing
// smartthings-config.json. It reads/writes the user-facing preferences (pcInput and the
// close-to-tray behavior) plus the SmartThings OAuth client fields (clientId/clientSecret/
// redirectUri) — everything you configure once. The OAuth *tokens* stay managed by auth.ts.
// config.ts does the actual persistence, so this writes the same smartthings-config.json the
// rest of the app reads.

import { loadConfig, saveConfig } from "../config.js";
import {
  normalizeDeviceConfigs,
  normalizeTheme,
  THEME_PREFERENCES,
  type ThemePreference,
} from "../domain/config.js";
import { defaultHotkeys } from "../domain/daemon.js";
import { DEFAULT_REDIRECT_URI } from "../api/oauth.js";

// The combos the daemon uses when a hotkey was never configured — shown in Settings so the
// active binding is always visible, never hidden behind an empty field.
const HOTKEY_DEFAULTS = defaultHotkeys(process.platform === "darwin" ? "mac" : "other");

export interface AppSettings {
  // OAuth client id from your SmartThings OAuth-In app.
  clientId: string;
  // OAuth client secret for that app.
  clientSecret: string;
  // Redirect URI registered on the OAuth client.
  redirectUri: string;
  // Target input the PC is on (matched by id like "HDMI3" or label like "PC").
  pcInput: string;
  // When true, closing the window hides to the tray; when false, it quits the app.
  minimizeToTrayOnClose: boolean;
  // Global hotkey for "Wake TV → PC" as an Electron accelerator ("Command+Control+E").
  // Always the *active* combo: the platform default is filled in when the config never set one.
  // Empty string means the command is disabled (no hotkey bound).
  wakeHotkey: string;
  // Global hotkey for "TV Off & Sleep". Same semantics as wakeHotkey.
  offHotkey: string;
  // Device ids of the TVs commands target, chosen from the account's TV list. Empty = none.
  selectedDeviceIds: string[];
  // Per-TV settings keyed by deviceId: alias/description, an input override (empty = shared
  // pcInput), and hotkeys firing the action for only that TV (independent of selectedDeviceIds;
  // "" = unbound, same convention as wakeHotkey/offHotkey).
  deviceConfigs: Record<string, DeviceConfigSettings>;
  // App color theme: "light", "dark", or "system" (follow the OS setting).
  theme: ThemePreference;
}

export interface DeviceConfigSettings {
  alias: string;
  description: string;
  pcInput: string;
  wakeHotkey: string;
  offHotkey: string;
}

export async function getSettings(): Promise<AppSettings> {
  const config = await loadConfig();
  return {
    clientId: config.clientId ?? "",
    clientSecret: config.clientSecret ?? "",
    redirectUri: config.redirectUri ?? DEFAULT_REDIRECT_URI,
    pcInput: config.pcInput,
    // Default to the historical behavior (hide to tray) when unset.
    minimizeToTrayOnClose: config.minimizeToTrayOnClose ?? true,
    // Unset = the platform default is active — show it; an explicit "" = disabled, stays empty.
    wakeHotkey: (config.wakeHotkey ?? HOTKEY_DEFAULTS.wake).trim(),
    offHotkey: (config.offHotkey ?? HOTKEY_DEFAULTS.off).trim(),
    selectedDeviceIds: config.selectedDeviceIds ?? [],
    deviceConfigs: Object.fromEntries(
      Object.entries(normalizeDeviceConfigs(config.deviceConfigs)).map(([id, cfg]) => [
        id,
        {
          alias: cfg.alias ?? "",
          description: cfg.description ?? "",
          pcInput: cfg.pcInput ?? "",
          wakeHotkey: cfg.wakeHotkey ?? "",
          offHotkey: cfg.offHotkey ?? "",
        },
      ]),
    ),
    // Defaults to dark (the historical appearance) when unset or invalid.
    theme: normalizeTheme(config.theme),
  };
}

// Persist the provided settings fields, leaving everything else (tokens) untouched. Empty/
// whitespace string fields are ignored so the user can't blank out a saved value by accident —
// matching the pcInput guard; the OAuth client is cleared via Sign out (resetConfig), not here.
export async function saveSettings(partial: Partial<AppSettings>): Promise<void> {
  const config = await loadConfig();
  if (typeof partial.clientId === "string" && partial.clientId.trim()) {
    config.clientId = partial.clientId.trim();
  }
  if (typeof partial.clientSecret === "string" && partial.clientSecret.trim()) {
    config.clientSecret = partial.clientSecret.trim();
  }
  if (typeof partial.redirectUri === "string" && partial.redirectUri.trim()) {
    config.redirectUri = partial.redirectUri.trim();
  }
  if (typeof partial.pcInput === "string" && partial.pcInput.trim()) {
    config.pcInput = partial.pcInput.trim();
  }
  if (typeof partial.minimizeToTrayOnClose === "boolean") {
    config.minimizeToTrayOnClose = partial.minimizeToTrayOnClose;
  }
  // Hotkeys differ from the fields above: an empty string is meaningful (it clears
  // the binding), so we apply the value as-is rather than guarding against blanks.
  if (typeof partial.wakeHotkey === "string") {
    config.wakeHotkey = partial.wakeHotkey.trim();
  }
  if (typeof partial.offHotkey === "string") {
    config.offHotkey = partial.offHotkey.trim();
  }
  // Unlike the string fields above, an empty array is meaningful (the user unchecked every TV),
  // so persist it whenever an array is supplied rather than guarding against empties.
  if (Array.isArray(partial.selectedDeviceIds)) {
    config.selectedDeviceIds = partial.selectedDeviceIds;
  }
  // Whole-map replace, like selectedDeviceIds: the renderer always sends the complete map, and
  // replacing is what lets clearing all of a TV's fields delete its entry (the sanitizer prunes
  // all-empty entries). A malformed payload normalizes to only its valid entries.
  if (typeof partial.deviceConfigs === "object" && partial.deviceConfigs !== null) {
    config.deviceConfigs = normalizeDeviceConfigs(partial.deviceConfigs);
  }
  // Only the three known values are accepted — a malformed IPC payload can't corrupt the config.
  if (THEME_PREFERENCES.includes(partial.theme as ThemePreference)) {
    config.theme = partial.theme;
  }
  await saveConfig(config);
}
