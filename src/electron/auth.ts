// Main-process OAuth helper for the Electron app: the in-window equivalent of `npm run login`.
// It stores the OAuth client (clientId/clientSecret) into the config, opens the SmartThings
// approval page in a child window, auto-captures the `code` from the redirect, and exchanges it
// for tokens — no terminal, no copy-paste. config.ts/api/oauth.ts do the actual persistence and
// token exchange, exactly as the CLI does, so both paths write the same smartthings-config.json.

import { BrowserWindow } from "electron";
import { loadConfig, signOut } from "../config.js";
import { hasOAuthClient } from "../domain/oauth.js";
import { authorizeUrl, exchangeCode, DEFAULT_REDIRECT_URI } from "../api/oauth.js";
import { isMockMode, isMockAuthorized, setMockAuthorized } from "../dev/mock-cloud.js";

export interface AuthStatus {
  // An OAuth client (clientId + clientSecret) is configured. The client fields themselves now
  // live in Settings (settings.ts), so status only reports whether sign-in is possible/done.
  hasClient: boolean;
  // We hold a refresh token, i.e. login completed at least once.
  authorized: boolean;
}

// Mock mode has no real tokens, so auth state is just a flag (isMockAuthorized/setMockAuthorized in
// dev/mock-cloud.js — shared there so the pure FakeTransport can read it to hide cloud TVs when
// signed out). It starts signed in (the fake cloud TVs load immediately), and Sign out / Sign in
// flip it. The daemon's TV actions keep working regardless: mock mode's token comes from the env.

export async function getAuthStatus(): Promise<AuthStatus> {
  if (isMockMode()) return { hasClient: true, authorized: isMockAuthorized() };
  const config = await loadConfig();
  return {
    hasClient: hasOAuthClient(config),
    authorized: Boolean(config.refreshToken),
  };
}

// Sign out: clear the OAuth tokens but keep the OAuth client (clientId/clientSecret/redirectUri)
// and preferences, so signing back in needs no re-entry. In mock mode just flip the fake state —
// keeping the mock config file preserves the seeded device selection.
export async function logout(): Promise<void> {
  if (isMockMode()) {
    setMockAuthorized(false);
    return;
  }
  await signOut();
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

// Sentinel returned (not thrown) when the user closes the popup to abort the flow — closing the
// window is a normal "never mind", not an error the caller should surface as a failure.
export const LOGIN_CANCELLED = Symbol("login-cancelled");

// Run the OAuth approval: open the SmartThings window, capture the code, exchange it for tokens.
// The client (clientId/clientSecret/redirectUri) must already be saved via Settings; resolves once
// tokens are saved (or with LOGIN_CANCELLED if the user closed the window); rejects if the client
// is missing, on denial, or on timeout.
export async function login(parent: BrowserWindow | null): Promise<void | typeof LOGIN_CANCELLED> {
  // Mock mode: succeed instantly instead of opening the real SmartThings approval window (there
  // is no OAuth client configured, and the fake cloud has no auth server anyway).
  if (isMockMode()) {
    setMockAuthorized(true);
    return;
  }
  const config = await loadConfig();
  if (!hasOAuthClient(config)) {
    throw new Error("Configure your SmartThings client in Settings first.");
  }

  const redirectUri = config.redirectUri ?? DEFAULT_REDIRECT_URI;

  const code = await captureCode(parent, authorizeUrl(config), redirectUri);
  if (code === LOGIN_CANCELLED) return LOGIN_CANCELLED;
  await exchangeCode(config, code);
}

// Open the SmartThings approval page and resolve with the `code` from the redirect, or with
// LOGIN_CANCELLED if the user closes the window to abort.
function captureCode(
  parent: BrowserWindow | null,
  startUrl: string,
  redirectUri: string,
): Promise<string | typeof LOGIN_CANCELLED> {
  return new Promise<string | typeof LOGIN_CANCELLED>((resolve, reject) => {
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

    // A "Cancel" button in the window's own menu/escape isn't available on a bare BrowserWindow,
    // so Escape closes the window — which onClosed turns into a clean cancellation.
    authWin.webContents.on("before-input-event", (_e, input) => {
      if (input.type === "keyDown" && input.key === "Escape" && !authWin.isDestroyed()) authWin.close();
    });

    const onNavigate = (url: string, event?: Electron.Event): void => {
      const hit = extractCode(url, redirectUri);
      if (!hit) return;
      // The default redirect target is a third-party echo service (httpbin.org) that would
      // receive — and could log — the authorization code in its query string. Once the code is
      // captured from the redirect URL, cancel the navigation so the request never goes out.
      event?.preventDefault();
      if (hit.error) finish(() => reject(new Error(`Authorization was denied: ${hit.error}`)));
      else if (hit.code) finish(() => resolve(hit.code!));
    };

    const onClosed = (): void => {
      // The user closed the window to back out of the flow — resolve as a cancellation rather than
      // rejecting, so the renderer can quietly return to "Not authorized" without an error.
      if (!settled) {
        settled = true;
        resolve(LOGIN_CANCELLED);
      }
    };

    // will-redirect catches the 302 to the redirect URI BEFORE it loads (and cancels it — see
    // onNavigate); did-navigate covers the case where the page loads directly. Same one-shot
    // handler either way.
    authWin.webContents.on("will-redirect", (e, url) => onNavigate(url, e));
    authWin.webContents.on("did-navigate", (_e, url) => onNavigate(url));
    authWin.webContents.on("did-navigate-in-page", (_e, url) => onNavigate(url));
    authWin.on("closed", onClosed);

    void authWin.loadURL(startUrl);
  });
}
