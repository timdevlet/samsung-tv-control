// Main-process helper for the in-window Settings panel: the GUI equivalent of hand-editing
// smartthings-config.json. It reads/writes the user-facing preferences (pcInput and the
// close-to-tray behavior) plus the SmartThings OAuth client fields (clientId/clientSecret/
// redirectUri) — everything you configure once. The OAuth *tokens* stay managed by auth.ts.
// config.ts does the actual persistence, so this writes the same smartthings-config.json the
// rest of the app reads.

import { loadConfig, saveConfig } from "../config.js";
import { DEFAULT_REDIRECT_URI } from "../api/oauth.js";

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
  // Empty string means no hotkey is bound.
  wakeHotkey: string;
  // Global hotkey for "TV Off & Sleep". Empty string means no hotkey is bound.
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
    wakeHotkey: config.wakeHotkey ?? "",
    offHotkey: config.offHotkey ?? "",
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
  await saveConfig(config);
}
