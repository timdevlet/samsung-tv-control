// Main-process helper for the in-window Settings panel: the GUI equivalent of hand-editing
// smartthings-config.json. It reads/writes the user-facing preferences (the command list and the
// close-to-tray behavior) plus the SmartThings OAuth client fields (clientId/clientSecret/
// redirectUri) — everything you configure once. The OAuth *tokens* stay managed by auth.ts.
// config.ts does the actual persistence, so this writes the same smartthings-config.json the
// rest of the app reads.

import { loadConfig, updateConfig, type TVConfig } from "../config.js";
import {
  commandUsesHdmi,
  normalizeCommands,
  normalizeDeviceConfigs,
  normalizeMainButtons,
  normalizeTheme,
  THEME_PREFERENCES,
  type CommandAction,
  type MainButtons,
  type ThemePreference,
} from "../domain/config.js";
import { DEFAULT_REDIRECT_URI } from "../api/oauth.js";

export interface AppSettings {
  // OAuth client id from your SmartThings OAuth-In app.
  clientId: string;
  // OAuth client secret for that app.
  clientSecret: string;
  // Redirect URI registered on the OAuth client.
  redirectUri: string;
  // When true, closing the window hides to the tray; when false, it quits the app.
  minimizeToTrayOnClose: boolean;
  // Device ids of the TVs "All TVs" commands (and the Main-screen buttons) target, chosen from
  // the account's TV list. Empty = none.
  selectedDeviceIds: string[];
  // Per-TV settings keyed by deviceId: alias/description and the LAN fields.
  deviceConfigs: Record<string, DeviceConfigSettings>;
  // App color theme: "light", "dark", or "system" (follow the OS setting).
  theme: ThemePreference;
  // Which built-in power buttons the Main screen shows (each defaults to true).
  mainButtons: MainButtons;
  // User-defined command list (Settings → Commands), in stored order.
  commands: CommandSettings[];
}

// One command row as the renderer edits it: like CommandConfig but with every field filled
// ("" / [] = unset) so the form inputs are always controlled.
export interface CommandSettings {
  id: string;
  action: CommandAction;
  // The TVs this command targets (checkboxes); [] = every TV selected in Settings.
  deviceIds: string[];
  // "" for actions that don't switch inputs; "HDMI1".."HDMI5" otherwise.
  hdmi: string;
  // Electron accelerator; "" = no hotkey (run from the list only).
  hotkey: string;
  // When true, the command is shown as a button on the Main screen. Always present (defaults to
  // false) so the eye toggle is a controlled input.
  pinned: boolean;
}

export interface DeviceConfigSettings {
  alias: string;
  description: string;
  // Local (LAN) transport fields — set for LAN-paired TVs; cloud TVs leave them empty.
  host: string;
  mac: string;
  // Optional comma-separated remote-key sequence for reaching the PC input over LAN.
  inputKeySeq: string;
  // Read-only in the UI: true once a LAN pairing token is stored. The token itself is never sent
  // to the renderer (a secret) — only this flag.
  paired: boolean;
}

export async function getSettings(): Promise<AppSettings> {
  const config = await loadConfig();
  return {
    clientId: config.clientId ?? "",
    clientSecret: config.clientSecret ?? "",
    redirectUri: config.redirectUri ?? DEFAULT_REDIRECT_URI,
    // Default to the historical behavior (hide to tray) when unset.
    minimizeToTrayOnClose: config.minimizeToTrayOnClose ?? true,
    selectedDeviceIds: config.selectedDeviceIds ?? [],
    deviceConfigs: Object.fromEntries(
      Object.entries(normalizeDeviceConfigs(config.deviceConfigs)).map(([id, cfg]) => [
        id,
        {
          alias: cfg.alias ?? "",
          description: cfg.description ?? "",
          host: cfg.host ?? "",
          mac: cfg.mac ?? "",
          inputKeySeq: cfg.inputKeySeq ?? "",
          // Expose only whether a pairing token exists — never the token itself.
          paired: Boolean(cfg.wsToken),
        },
      ]),
    ),
    // Defaults to dark (the historical appearance) when unset or invalid.
    theme: normalizeTheme(config.theme),
    // Each button defaults to on when unset — the historical "all three shown" Main screen.
    mainButtons: normalizeMainButtons(config.mainButtons),
    commands: normalizeCommands(config.commands).map((cmd) => ({
      id: cmd.id,
      action: cmd.action,
      deviceIds: cmd.deviceIds ?? [],
      hdmi: commandUsesHdmi(cmd.action) ? cmd.hdmi ?? "HDMI1" : "",
      hotkey: cmd.hotkey ?? "",
      pinned: cmd.pinned ?? false,
    })),
  };
}

// Persist the provided settings fields, leaving everything else (tokens) untouched. Empty/
// whitespace string fields are ignored so the user can't blank out a saved value by accident —
// matching the pcInput guard. Sign out clears the tokens but deliberately keeps the OAuth client,
// so the client is only ever changed by saving new values here.
export async function saveSettings(partial: Partial<AppSettings>): Promise<void> {
  // updateConfig serializes this read-modify-write against the other config writers (token
  // refresh, pairing), so an autosave can't clobber a token rotated mid-edit and vice versa.
  await updateConfig((config) => {
    applySettings(config, partial);
  });
}

function applySettings(config: TVConfig, partial: Partial<AppSettings>): void {
  if (typeof partial.clientId === "string" && partial.clientId.trim()) {
    config.clientId = partial.clientId.trim();
  }
  if (typeof partial.clientSecret === "string" && partial.clientSecret.trim()) {
    config.clientSecret = partial.clientSecret.trim();
  }
  if (typeof partial.redirectUri === "string" && partial.redirectUri.trim()) {
    config.redirectUri = partial.redirectUri.trim();
  }
  if (typeof partial.minimizeToTrayOnClose === "boolean") {
    config.minimizeToTrayOnClose = partial.minimizeToTrayOnClose;
  }
  // Unlike the string fields above, an empty array is meaningful (the user unchecked every TV),
  // so persist it whenever an array is supplied rather than guarding against empties.
  if (Array.isArray(partial.selectedDeviceIds)) {
    config.selectedDeviceIds = partial.selectedDeviceIds;
  }
  // Whole-map replace, like selectedDeviceIds: the renderer always sends the complete map, and
  // replacing is what lets clearing all of a TV's fields delete its entry (the sanitizer prunes
  // all-empty entries). A malformed payload normalizes to only its valid entries.
  //
  // The renderer never sees wsToken (it's a secret set by the pairing IPC) and no longer edits
  // pcInput (the stored per-TV input the automatic wake still switches to), so a naive replace
  // would wipe both. Carry each forward from the stored config by deviceId before normalizing.
  if (typeof partial.deviceConfigs === "object" && partial.deviceConfigs !== null) {
    const stored = config.deviceConfigs ?? {};
    const merged: Record<string, unknown> = {};
    for (const [id, cfg] of Object.entries(partial.deviceConfigs)) {
      const kept = stored[id];
      merged[id] = {
        ...cfg,
        ...(kept?.pcInput ? { pcInput: kept.pcInput } : {}),
        ...(kept?.wsToken ? { wsToken: kept.wsToken } : {}),
      };
    }
    config.deviceConfigs = normalizeDeviceConfigs(merged);
  }
  // Only the three known values are accepted — a malformed IPC payload can't corrupt the config.
  if (THEME_PREFERENCES.includes(partial.theme as ThemePreference)) {
    config.theme = partial.theme;
  }
  // Normalized to a full record (each key on unless explicitly false), so a malformed payload
  // can't corrupt the config and a missing button key defaults back to shown.
  if (typeof partial.mainButtons === "object" && partial.mainButtons !== null) {
    config.mainButtons = normalizeMainButtons(partial.mainButtons);
  }
  // Whole-list replace, like deviceConfigs: the renderer always sends the complete list, and an
  // empty array is meaningful (the user deleted every command). Malformed entries are dropped by
  // the normalizer.
  if (Array.isArray(partial.commands)) {
    config.commands = normalizeCommands(partial.commands);
  }
}
