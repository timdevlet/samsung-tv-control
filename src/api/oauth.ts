import {
  isTokenFresh,
  applyTokens,
  DEFAULT_REDIRECT_URI,
  type TokenResponse,
} from "../domain/oauth.js";
import type { TVConfig } from "../domain/config.js";
import { saveConfig } from "../config.js";

// Pure helpers are re-exported from their new home for existing importers.
export { authorizeUrl, hasOAuthClient, DEFAULT_REDIRECT_URI, DEFAULT_SCOPES } from "../domain/oauth.js";

// SmartThings OAuth 2.0 token endpoint.
const TOKEN_URL = "https://auth-global.api.smartthings.com/oauth/token";

interface TokenError {
  error?: string;
  error_description?: string;
  raw?: string;
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

// One-time: exchange the browser auth code for tokens and persist them.
export async function exchangeCode(config: TVConfig, code: string): Promise<void> {
  const tok = await postToken(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri ?? DEFAULT_REDIRECT_URI,
  });
  applyTokens(config, tok, Date.now());
  await saveConfig(config);
}

// Returns a valid access token, transparently refreshing when within the skew window of
// expiry and persisting the rotated refresh token back to the config file.
export async function getAccessToken(config: TVConfig): Promise<string> {
  if (!config.refreshToken) {
    throw new Error("Not authorized yet — run `npm run login` once to connect your SmartThings account.");
  }

  if (isTokenFresh(config, Date.now())) return config.accessToken!;

  try {
    const tok = await postToken(config, {
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
    });
    applyTokens(config, tok, Date.now());
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
