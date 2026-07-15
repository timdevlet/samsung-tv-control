// Pure config types & policy — no I/O. The file adapter lives in src/config.ts.

// App color theme: fixed light/dark, or follow the OS setting.
export type ThemePreference = "light" | "dark" | "system";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

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
}

// The DeviceConfig string fields, used to normalize untrusted maps field-by-field.
const DEVICE_CONFIG_FIELDS = ["alias", "description", "pcInput", "wakeHotkey", "offHotkey"] as const;

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
    if (Object.keys(entry).length > 0) result[deviceId] = entry;
  }
  return result;
}
