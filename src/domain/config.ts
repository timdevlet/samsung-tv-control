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

  // Device cache (filled in automatically on first use)
  // Cached SmartThings device id of the TV (avoids re-listing every run).
  deviceId?: string;
  // Human-readable device label (informational).
  deviceLabel?: string;

  // Your preference
  // Target input the PC is on. Matched against the TV's supported-input map by
  // id ("HDMI3") first, then by label ("PC"). Default "HDMI2".
  pcInput: string;
}

const DEFAULTS: TVConfig = {
  pcInput: "HDMI2",
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
