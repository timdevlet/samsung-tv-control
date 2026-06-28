// Pure config types & policy — no I/O. The file adapter lives in src/config.ts.

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
  // Registered system-wide; empty/unset means the action has no hotkey.
  // wakeHotkey fires "Wake TV → PC"; offHotkey fires "TV Off & Sleep".
  wakeHotkey?: string;
  offHotkey?: string;
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
