// Main-process OAuth helper for the Electron app: the in-window equivalent of `npm run login`.
// It stores the OAuth client (clientId/clientSecret) into the config, opens the SmartThings
// approval page in a child window, auto-captures the `code` from the redirect, and exchanges it
// for tokens — no terminal, no copy-paste. config.ts/api/oauth.ts do the actual persistence and
// token exchange, exactly as the CLI does, so both paths write the same smartthings-config.json.

import { BrowserWindow } from "electron";
import { loadConfig, saveConfig, resetConfig } from "../config.js";
import { hasOAuthClient } from "../domain/oauth.js";
import { authorizeUrl, exchangeCode, DEFAULT_REDIRECT_URI } from "../api/oauth.js";

export interface AuthStatus {
  // An OAuth client (clientId + clientSecret) is configured.
  hasClient: boolean;
  // We hold a refresh token, i.e. login completed at least once.
  authorized: boolean;
  // Echo the saved client fields so the renderer can pre-fill the form (secret included so the
  // user can see/edit it; this is a local single-user desktop app reading its own config file).
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const config = await loadConfig();
  return {
    hasClient: hasOAuthClient(config),
    authorized: Boolean(config.refreshToken),
    clientId: config.clientId ?? "",
    clientSecret: config.clientSecret ?? "",
    redirectUri: config.redirectUri ?? DEFAULT_REDIRECT_URI,
  };
}

// Clear all stored credentials and tokens (the GUI equivalent of `npm run reset`).
export async function logout(): Promise<void> {
  await resetConfig();
}

// Pull the OAuth `code` (or an `error`) out of a redirect URL, but only once navigation has
// actually reached the configured redirect target — so intermediate auth-server hops are ignored.
function extractCode(navigated: string, redirectUri: string): { code?: string; error?: string } | null {
  let url: URL;
  let redirect: URL;
  try {
    url = new URL(navigated);
    redirect = new URL(redirectUri);
  } catch {
    return null;
  }
  const sameTarget = url.origin === redirect.origin && url.pathname === redirect.pathname;
  if (!sameTarget) return null;
  const error = url.searchParams.get("error") ?? undefined;
  const code = url.searchParams.get("code") ?? undefined;
  if (!code && !error) return null;
  return { code, error };
}

// Run the full login: save the client creds, open the approval window, capture the code, exchange
// it for tokens. Resolves once tokens are saved; rejects on denial, timeout, or a closed window.
export async function login(parent: BrowserWindow | null, creds: ClientCredentials): Promise<void> {
  const clientId = creds.clientId.trim();
  const clientSecret = creds.clientSecret.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Both Client ID and Client Secret are required.");
  }

  // Persist the client fields first so they survive even if the user cancels the approval, and so
  // authorizeUrl() below reads them back from the same config the rest of the app uses.
  const config = await loadConfig();
  config.clientId = clientId;
  config.clientSecret = clientSecret;
  if (creds.redirectUri?.trim()) config.redirectUri = creds.redirectUri.trim();
  await saveConfig(config);

  const redirectUri = config.redirectUri ?? DEFAULT_REDIRECT_URI;

  const code = await captureCode(parent, authorizeUrl(config), redirectUri);
  await exchangeCode(config, code);
}

// Open the SmartThings approval page and resolve with the `code` from the redirect.
function captureCode(parent: BrowserWindow | null, startUrl: string, redirectUri: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const authWin = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parent ?? undefined,
      modal: Boolean(parent),
      title: "Sign in to SmartThings",
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      authWin.removeListener("closed", onClosed);
      if (!authWin.isDestroyed()) authWin.close();
      fn();
    };

    const onNavigate = (url: string): void => {
      const hit = extractCode(url, redirectUri);
      if (!hit) return;
      if (hit.error) finish(() => reject(new Error(`Authorization was denied: ${hit.error}`)));
      else if (hit.code) finish(() => resolve(hit.code!));
    };

    const onClosed = (): void => {
      if (!settled) {
        settled = true;
        reject(new Error("Login window was closed before authorization completed."));
      }
    };

    // will-redirect catches the 302 to the redirect URI before it loads; did-navigate covers the
    // case where the page loads directly. Both feed the same one-shot handler.
    authWin.webContents.on("will-redirect", (_e, url) => onNavigate(url));
    authWin.webContents.on("did-navigate", (_e, url) => onNavigate(url));
    authWin.webContents.on("did-navigate-in-page", (_e, url) => onNavigate(url));
    authWin.on("closed", onClosed);

    void authWin.loadURL(startUrl);
  });
}
