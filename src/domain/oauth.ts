// Pure OAuth decisions & token shapes — no I/O. The HTTP adapter lives in src/api/oauth.ts.

import type { TVConfig } from "./config.js";

export const DEFAULT_REDIRECT_URI = "https://httpbin.org/get";
export const DEFAULT_SCOPES = "r:devices:* x:devices:* r:locations:*";
const AUTHORIZE_URL = "https://api.smartthings.com/oauth/authorize";

/** Refresh this many ms before the access token's real 24h expiry. */
export const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Shape of the SmartThings OAuth token endpoint response (the parts we read). */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
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

/** True when the cached access token is present and not within the skew window of expiry. */
export function isTokenFresh(config: TVConfig, now: number): boolean {
  return (
    config.accessToken != null &&
    config.accessTokenExpiresAt != null &&
    now < config.accessTokenExpiresAt - EXPIRY_SKEW_MS
  );
}

/** Apply a token response onto the config (mutates). `now` is epoch ms. */
export function applyTokens(config: TVConfig, tok: TokenResponse, now: number): void {
  config.accessToken = tok.access_token;
  config.refreshToken = tok.refresh_token; // rotated value — must overwrite the old one
  config.accessTokenExpiresAt = now + (tok.expires_in ?? 86400) * 1000;
}
