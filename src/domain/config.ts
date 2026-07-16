// Pure config types & policy — no I/O. The file adapter lives in src/config.ts.

// App color theme: fixed light/dark, or follow the OS setting.
export type ThemePreference = "light" | "dark" | "system";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

// How the app reaches the TV. "cloud" = the SmartThings REST API (OAuth, needs internet — the
// historical default). "local" = direct LAN control (Wake-on-LAN + the Samsung remote WebSocket,
// no Samsung account, works offline). Unset means "cloud" so existing configs are unchanged.
export type TransportMode = "cloud" | "local";

export const TRANSPORT_MODES: readonly TransportMode[] = ["cloud", "local"];

// A TV's own settings, all optional — an unset field falls back to the app-wide behavior.
export interface DeviceConfig {
  // Custom display name shown instead of the SmartThings label (e.g. "65 TV").
  alias?: string;
  // Free-text note shown under the name (e.g. "living room tv").
  description?: string;
  // Input the PC is on for THIS TV; unset = the shared pcInput.
  pcInput?: string;
  // Hotkeys (Electron accelerator strings) firing the action for only this TV,
  // independent of selectedDeviceIds. Empty/unset = no action of that kind.
  wakeHotkey?: string;
  offHotkey?: string;

  // Local (LAN) transport fields — used only when transportMode is "local".
  // The TV's LAN IP or hostname (the WebSocket + info-endpoint target).
  host?: string;
  // The TV's MAC address, for the Wake-on-LAN magic packet. Canonicalized (lowercase, colon-
  // separated) on save so packet construction is deterministic.
  mac?: string;
  // Optional comma-separated remote-key sequence to reach the PC input over LAN (e.g.
  // "KEY_HDMI,KEY_HDMI"). There's no authoritative "set HDMI2" over the local remote protocol,
  // so an advanced user can record the keypresses that land on their PC input. Unset = send a
  // single source/HDMI key.
  inputKeySeq?: string;
  // The local WebSocket pairing token returned by the TV's on-screen "Allow" the first time we
  // connect. A SECRET — persisted here but never surfaced to the renderer (getSettings exposes
  // only a `paired` boolean) and only written by the pairing IPC, not through saveSettings.
  wsToken?: string;
}

// The DeviceConfig plain-string fields normalized field-by-field from untrusted maps. wsToken is
// handled separately (see normalizeDeviceConfigs) so it's preserved but never treated as a
// user-editable text field.
const DEVICE_CONFIG_FIELDS = [
  "alias",
  "description",
  "pcInput",
  "wakeHotkey",
  "offHotkey",
  "host",
  "mac",
  "inputKeySeq",
] as const;

// Persisted as smartthings-config.json (plain JSON, rewritten in full by saveConfig — any
// comment added there is stripped on the next save). Document fields here. This is the shared
// config shape imported across the app.
export interface TVConfig {
  // You set these by hand (or via env / `npm run login`)
  // Legacy SmartThings Personal Access Token (expires in 24h). Prefer OAuth below.
  token?: string;

  // OAuth client (auto-refreshing, the long-lived path; you set these once)
  // OAuth client id from your SmartThings OAuth-In app.
  clientId?: string;
  // OAuth client secret (also accepted under the legacy key "secret").
  clientSecret?: string;
  // Redirect URI registered on the OAuth client. Default https://httpbin.org/get.
  redirectUri?: string;
  // Space-separated OAuth scopes.
  scopes?: string;

  // OAuth tokens (managed automatically; do not hand-edit)
  // Long-lived refresh token; rotates on every refresh.
  refreshToken?: string;
  // Current 24h access token.
  accessToken?: string;
  // Epoch ms when the access token expires.
  accessTokenExpiresAt?: number;

  // Your preference
  // Target input the PC is on. Matched against the TV's supported-input map by
  // id ("HDMI3") first, then by label ("PC"). Default "HDMI2".
  pcInput: string;

  // App behavior
  // When true (default), closing the window hides it to the tray and the daemon
  // keeps running. When false, closing the window quits the app.
  minimizeToTrayOnClose?: boolean;

  // Global hotkeys (Electron accelerator strings like "Command+Control+E").
  // Registered system-wide. Unset = the platform default combo is active; an explicit
  // empty string = the user cleared the binding and the action is disabled (no hotkey).
  // wakeHotkey fires "Wake TV → PC"; offHotkey fires "TV Off & Sleep".
  wakeHotkey?: string;
  offHotkey?: string;

  // Device ids of the TVs commands target. Chosen in Settings from the account's
  // TV list. Empty/unset means none selected — commands no-op rather than auto-pick.
  selectedDeviceIds?: string[];

  // Per-TV settings keyed by SmartThings deviceId: alias/description, an input override, and
  // hotkeys that fire the action for ONLY that TV (selectedDeviceIds scopes only the global
  // wakeHotkey/offHotkey above).
  deviceConfigs?: Record<string, DeviceConfig>;

  // App color theme. "system" follows the OS light/dark setting. Unset means dark —
  // the app's historical appearance.
  theme?: ThemePreference;

  // How commands reach the TV. Unset = "cloud" (the historical SmartThings behavior).
  transportMode?: TransportMode;
}

const DEFAULTS: TVConfig = {
  pcInput: "HDMI2",
  minimizeToTrayOnClose: true,
};

// Merge parsed config over defaults and migrate the legacy "secret" key.
export function mergeConfig(parsed: Partial<TVConfig> & { secret?: string }): TVConfig {
  // Accept the legacy "secret" key as an alias for clientSecret.
  if (parsed.secret && !parsed.clientSecret) parsed.clientSecret = parsed.secret;
  delete parsed.secret;
  return { ...DEFAULTS, ...parsed };
}

// A fresh defaults-only config (used when no config file exists).
export function defaultConfig(): TVConfig {
  return { ...DEFAULTS };
}

// The static token to use: env var takes precedence over config.token.
export function resolveStaticToken(config: TVConfig, envToken: string | undefined): string | undefined {
  return envToken?.trim() || config.token;
}

// Sign out: drop everything that identifies the signed-in account (OAuth tokens + the legacy
// static token) while keeping the OAuth client (clientId/clientSecret/redirectUri/scopes) and
// all user preferences, so the next sign-in reuses the configured client with no re-entry.
export function clearTokens(config: TVConfig): TVConfig {
  const next = { ...config };
  delete next.refreshToken;
  delete next.accessToken;
  delete next.accessTokenExpiresAt;
  delete next.token;
  return next;
}

// Coerce an untrusted value (config file / IPC payload) to a valid theme, defaulting to dark —
// the app's historical appearance.
export function normalizeTheme(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : "dark";
}

// Coerce an untrusted value to a valid transport mode. The app is now LAN-only (the Cloud/Local
// toggle was removed), so anything unset/malformed resolves to "local". The "cloud" value is
// still accepted if explicitly present in an old config, and the SmartThings code stays in the
// tree, but nothing in the UI selects it anymore.
export function normalizeTransportMode(value: unknown): TransportMode {
  return TRANSPORT_MODES.includes(value as TransportMode) ? (value as TransportMode) : "local";
}

// Canonicalize a MAC address to lowercase colon-separated form ("AA-BB-…" / "aabb…" → "aa:bb:…")
// so the Wake-on-LAN packet is built deterministically. Returns "" for anything that isn't 12
// hex digits once separators are stripped — the caller treats that as "no MAC".
export function canonicalizeMac(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 12) return "";
  return hex.match(/.{2}/g)!.join(":");
}

// Coerce an untrusted value (config file / IPC payload) to a clean per-device config map:
// only non-empty string fields are kept (trimmed), and entries left with no field at all are
// pruned entirely — so clearing every field of a TV removes it from the persisted map.
export function normalizeDeviceConfigs(value: unknown): Record<string, DeviceConfig> {
  const result: Record<string, DeviceConfig> = {};
  if (typeof value !== "object" || value === null) return result;
  for (const [deviceId, raw] of Object.entries(value)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry: DeviceConfig = {};
    for (const field of DEVICE_CONFIG_FIELDS) {
      const v = (raw as Record<string, unknown>)[field];
      if (typeof v === "string" && v.trim()) entry[field] = v.trim();
    }
    // Canonicalize a captured MAC so WoL is deterministic; drop it if it isn't a valid MAC.
    if (entry.mac) {
      const mac = canonicalizeMac(entry.mac);
      if (mac) entry.mac = mac;
      else delete entry.mac;
    }
    // wsToken is a secret set by the pairing IPC, not a user text field — preserve it as-is
    // (it also keeps a paired-but-otherwise-empty TV from being pruned below).
    const token = (raw as Record<string, unknown>).wsToken;
    if (typeof token === "string" && token.trim()) entry.wsToken = token.trim();
    if (Object.keys(entry).length > 0) result[deviceId] = entry;
  }
  return result;
}
