import { updateConfig } from "../config.js";
import type { TVConfig } from "../domain/config.js";
import {
  applyTokens,
  DEFAULT_REDIRECT_URI,
  isTokenFresh,
  type TokenResponse,
} from "../domain/oauth.js";
import { log } from "../log.js";
import { fetchErrorDetail } from "./smartthings.js";

// Pure helpers are re-exported from their new home for existing importers.
export { authorizeUrl, DEFAULT_REDIRECT_URI, hasOAuthClient } from "../domain/oauth.js";

// SmartThings OAuth 2.0 token endpoint.
const TOKEN_URL = "https://auth-global.api.smartthings.com/oauth/token";

interface TokenError {
  error?: string;
  error_description?: string;
  raw?: string;
}

function basicAuth(config: TVConfig): string {
  // Credentials go in the HTTP Basic auth header, never in the body.
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
}

async function postToken(config: TVConfig, params: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuth(config),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Same visibility rule as the SmartThings client: a fetch that never completes (network
    // still down after resume, timeout) must leave a trace in the logs. Log the grant type and
    // reason only — never the params, tokens, or auth header.
    const detail = fetchErrorDetail(err);
    log(`SmartThings token ${params.grant_type} → network error (${detail})`);
    throw new Error(`SmartThings token request failed: ${detail}`);
  }

  const text = await res.text();
  let json: (TokenResponse & TokenError) | TokenError;
  try {
    json = JSON.parse(text) as TokenResponse & TokenError;
  } catch {
    json = { raw: text };
  }

  // Outcome only (grant type + HTTP status) — token responses must never be logged.
  log(
    `SmartThings token ${params.grant_type} → ${res.status} ${res.ok ? "ok" : (json.error ?? "error")}`,
  );

  if (!res.ok) {
    const detail = json.error_description || json.error || json.raw || text;
    const err = new Error(`SmartThings token endpoint ${res.status}: ${detail}`);
    (err as Error & { oauthError?: string }).oauthError = json.error;
    throw err;
  }
  return json as TokenResponse;
}

// Persist a token response: apply it to the caller's config copy (kept current for the request
// about to use it) and to the stored config under the write lock, so a concurrent Settings save
// can't be clobbered by our stale copy of the rest of the file.
async function persistTokens(config: TVConfig, tok: TokenResponse): Promise<void> {
  const now = Date.now();
  applyTokens(config, tok, now);
  await updateConfig((stored) => applyTokens(stored, tok, now));
}

// One-time: exchange the browser auth code for tokens and persist them.
export async function exchangeCode(config: TVConfig, code: string): Promise<void> {
  const tok = await postToken(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri ?? DEFAULT_REDIRECT_URI,
  });
  await persistTokens(config, tok);
}

// The one in-flight refresh, shared by every concurrent caller. SmartThings ROTATES the refresh
// token on each use: two callers refreshing at once (a daemon action racing the Settings device
// list) would each spend the same one-use token, and whichever rotation persisted last could be
// the rejected one — every later refresh then fails with invalid_grant until the user re-logs-in.
let refreshInFlight: Promise<TokenResponse> | null = null;

// Returns a valid access token, transparently refreshing when within the skew window of
// expiry and persisting the rotated refresh token back to the config file.
export async function getAccessToken(config: TVConfig): Promise<string> {
  if (!config.refreshToken) {
    throw new Error(
      "Not authorized yet — run `npm run login` once to connect your SmartThings account.",
    );
  }

  if (isTokenFresh(config, Date.now())) return config.accessToken!;

  try {
    refreshInFlight ??= postToken(config, {
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
    }).finally(() => {
      refreshInFlight = null;
    });
    const tok = await refreshInFlight;
    await persistTokens(config, tok);
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
