import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Persisted next to the project root so it survives across runs. */
export const CONFIG_PATH = join(__dirname, "..", "smartthings-config.json");

// Persisted as smartthings-config.json. NOTE: that file is plain JSON (no comments) and is
// rewritten in full by saveConfig() — any comment you add to it is stripped on the next save.
// Document fields HERE instead. The "App writes:" note on each field says when (if ever) the
// app overwrites your value.
export interface TVConfig {
  // --- You set these by hand (or via env / `npm run login`) ---

  /**
   * Legacy SmartThings Personal Access Token (expires in 24h). Prefer OAuth below.
   * App writes: never (you set it; env SMARTTHINGS_TOKEN takes precedence at read time).
   */
  token?: string;

  // --- OAuth client (auto-refreshing, the long-lived path; you set these once) ---
  /** OAuth client id from your SmartThings OAuth-In app. App writes: never. */
  clientId?: string;
  /** OAuth client secret (also accepted under the legacy key "secret"). App writes: never. */
  clientSecret?: string;
  /** Redirect URI registered on the OAuth client. Default https://httpbin.org/get. App writes: never. */
  redirectUri?: string;
  /** Space-separated OAuth scopes. Default "r:devices:* x:devices:* r:locations:*". App writes: never. */
  scopes?: string;

  // --- OAuth tokens (managed automatically; do not hand-edit) ---
  /**
   * Long-lived refresh token; rotates on every refresh.
   * App writes: on `npm run login` and on every token refresh (the value rotates each time).
   */
  refreshToken?: string;
  /**
   * Current 24h access token.
   * App writes: on `npm run login` and whenever it refreshes an expired/near-expiry token.
   */
  accessToken?: string;
  /**
   * Epoch ms when the access token expires.
   * App writes: alongside accessToken, every time the token is obtained or refreshed.
   */
  accessTokenExpiresAt?: number;

  // --- Device cache (filled in automatically on first use) ---
  /**
   * Cached SmartThings device id of the TV (avoids re-listing every run).
   * App writes: once on first run (TV discovery); cleared by `npm run reset`.
   */
  deviceId?: string;
  /**
   * Human-readable device label (informational).
   * App writes: once on first run, alongside deviceId.
   */
  deviceLabel?: string;

  // --- Your preference ---
  /**
   * Target input the PC is on. Matched against the TV's supported-input map by
   * id ("HDMI3") first, then by label ("PC"). Default "HDMI3".
   * App writes: never (a `--hdmi <n>` flag overrides it for that run only, in memory).
   */
  pcInput: string;
}

const DEFAULTS: TVConfig = {
  pcInput: "HDMI2",
};

export async function loadConfig(): Promise<TVConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<TVConfig> & { secret?: string };
    // Accept the legacy "secret" key as an alias for clientSecret.
    if (parsed.secret && !parsed.clientSecret) parsed.clientSecret = parsed.secret;
    delete parsed.secret;
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULTS };
    throw err;
  }
}

export async function saveConfig(config: TVConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export async function resetConfig(): Promise<void> {
  try {
    await unlink(CONFIG_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Token from the environment takes precedence over the config file. */
export function resolveToken(config: TVConfig): string | undefined {
  return process.env.SMARTTHINGS_TOKEN?.trim() || config.token;
}
