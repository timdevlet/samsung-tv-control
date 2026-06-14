import { saveConfig, type TVConfig } from "./config.js";

// SmartThings OAuth 2.0 endpoints.
const TOKEN_URL = "https://auth-global.api.smartthings.com/oauth/token";
const AUTHORIZE_URL = "https://api.smartthings.com/oauth/authorize";

export const DEFAULT_REDIRECT_URI = "https://httpbin.org/get";
export const DEFAULT_SCOPES = "r:devices:* x:devices:* r:locations:*";

/** Refresh this many ms before the access token's real 24h expiry. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface TokenError {
  error?: string;
  error_description?: string;
  raw?: string;
}

/** True once an OAuth client (clientId + clientSecret) is configured. */
export function hasOAuthClient(config: TVConfig): boolean {
  return Boolean(config.clientId && config.clientSecret);
}

/** Browser URL the user opens once to approve access. */
export function authorizeUrl(config: TVConfig): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", config.clientId ?? "");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", config.scopes ?? DEFAULT_SCOPES);
  u.searchParams.set("redirect_uri", config.redirectUri ?? DEFAULT_REDIRECT_URI);
  return u.toString();
}

function basicAuth(config: TVConfig): string {
  // Credentials go in the HTTP Basic auth header, never in the body.
  return "Basic " + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
}

async function postToken(config: TVConfig, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(config),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  let json: (TokenResponse & TokenError) | TokenError;
  try {
    json = JSON.parse(text) as TokenResponse & TokenError;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const detail = json.error_description || json.error || json.raw || text;
    const err = new Error(`SmartThings token endpoint ${res.status}: ${detail}`);
    (err as Error & { oauthError?: string }).oauthError = json.error;
    throw err;
  }
  return json as TokenResponse;
}

function persistTokens(config: TVConfig, tok: TokenResponse): void {
  config.accessToken = tok.access_token;
  config.refreshToken = tok.refresh_token; // rotated value — must overwrite the old one
  config.accessTokenExpiresAt = Date.now() + (tok.expires_in ?? 86400) * 1000;
}

/** One-time: exchange the browser auth code for tokens and persist them. */
export async function exchangeCode(config: TVConfig, code: string): Promise<void> {
  const tok = await postToken(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri ?? DEFAULT_REDIRECT_URI,
  });
  persistTokens(config, tok);
  await saveConfig(config);
}

/**
 * Returns a valid access token, transparently refreshing when within EXPIRY_SKEW_MS
 * of expiry and persisting the rotated refresh token back to the config file.
 */
export async function getAccessToken(config: TVConfig): Promise<string> {
  if (!config.refreshToken) {
    throw new Error("Not authorized yet — run `npm run login` once to connect your SmartThings account.");
  }

  const stillFresh =
    config.accessToken != null &&
    config.accessTokenExpiresAt != null &&
    Date.now() < config.accessTokenExpiresAt - EXPIRY_SKEW_MS;
  if (stillFresh) return config.accessToken!;

  try {
    const tok = await postToken(config, {
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
    });
    persistTokens(config, tok);
    await saveConfig(config);
    return tok.access_token;
  } catch (err) {
    if ((err as Error & { oauthError?: string }).oauthError === "invalid_grant") {
      throw new Error(
        "SmartThings refused the refresh token (it expires after 30 days of non-use, " +
          "or was already rotated). Run `npm run login` again to re-authorize.",
      );
    }
    throw err;
  }
}
