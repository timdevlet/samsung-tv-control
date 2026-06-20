// Pure decision logic — no I/O, no node:* APIs, no fetch/Date.now/timers, no process.
// Everything here is deterministic given its inputs, so it can be unit-tested directly.
// Side effects live behind the interfaces in interfaces.ts; the concrete files (index.ts,
// daemon.ts, config.ts, the api/ cloud adapters, and the os/ system adapters) call into
// these helpers.

// --- Shared domain types (single source of truth; other files import from here) ---

export interface STDevice {
  deviceId: string;
  label: string;
  name: string;
  capabilities: string[];
}

export interface InputSource {
  id: string;
  name: string;
}

export interface TVStatus {
  /** "on" | "off" | undefined */
  power?: string;
  /** Which capability id this TV uses for input switching. */
  inputCapability?: string;
  currentInput?: string;
  sources: InputSource[];
}

// Persisted as smartthings-config.json (plain JSON, rewritten in full by saveConfig — any
// comment added there is stripped on the next save). Document fields here.
export interface TVConfig {
  // --- You set these by hand (or via env / `npm run login`) ---
  /** Legacy SmartThings Personal Access Token (expires in 24h). Prefer OAuth below. */
  token?: string;

  // --- OAuth client (auto-refreshing, the long-lived path; you set these once) ---
  /** OAuth client id from your SmartThings OAuth-In app. */
  clientId?: string;
  /** OAuth client secret (also accepted under the legacy key "secret"). */
  clientSecret?: string;
  /** Redirect URI registered on the OAuth client. Default https://httpbin.org/get. */
  redirectUri?: string;
  /** Space-separated OAuth scopes. */
  scopes?: string;

  // --- OAuth tokens (managed automatically; do not hand-edit) ---
  /** Long-lived refresh token; rotates on every refresh. */
  refreshToken?: string;
  /** Current 24h access token. */
  accessToken?: string;
  /** Epoch ms when the access token expires. */
  accessTokenExpiresAt?: number;

  // --- Device cache (filled in automatically on first use) ---
  /** Cached SmartThings device id of the TV (avoids re-listing every run). */
  deviceId?: string;
  /** Human-readable device label (informational). */
  deviceLabel?: string;

  // --- Your preference ---
  /**
   * Target input the PC is on. Matched against the TV's supported-input map by
   * id ("HDMI3") first, then by label ("PC"). Default "HDMI2".
   */
  pcInput: string;
}

// --- OAuth constants & token shapes (used by domain + the oauth adapter) ---

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

// --- Input selection ---

/** Pick the source id to switch to: match pcInput by id, then by label, else raw value. */
export function pickInput(status: TVStatus, pcInput: string): string {
  const want = pcInput.toLowerCase();
  const byId = status.sources.find((s) => s.id.toLowerCase() === want);
  if (byId) return byId.id;
  const byName = status.sources.find((s) => s.name.toLowerCase() === want);
  if (byName) return byName.id;
  // Nothing matched the configured value — fall back to the raw value and let the TV try.
  return pcInput;
}

/** True when the TV's current input equals `target` (case-insensitive). */
export function isOnInput(status: TVStatus, target: string): boolean {
  return Boolean(status.currentInput && status.currentInput.toLowerCase() === target.toLowerCase());
}

// --- CLI parsing ---

/** Parse `--hdmi <n>`, `--hdmi=n`, or `--hdmiN` (n = 1..4) into "HDMI<n>". */
export function parseHdmiFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let raw: string | undefined;
    if (arg === "--hdmi") raw = args[i + 1];
    else if (arg.startsWith("--hdmi=")) raw = arg.slice("--hdmi=".length);
    else if (/^--hdmi[1-4]$/.test(arg)) raw = arg.slice("--hdmi".length);
    else continue;

    const n = raw?.replace(/^hdmi/i, "").trim();
    if (!n || !/^[1-4]$/.test(n)) {
      throw new Error(`Invalid --hdmi value "${raw ?? ""}". Use --hdmi 1, 2, 3, or 4.`);
    }
    return `HDMI${n}`;
  }
  return undefined;
}

// --- SmartThings status JSON parsing ---

/** The two capability ids Samsung TVs expose for input switching. */
export const INPUT_CAPABILITIES = ["samsungvd.mediaInputSource", "mediaInputSource"] as const;

interface RawSource {
  id: string;
  name?: string;
}
type RawAttr = { value?: unknown };
type RawCapability = Record<string, RawAttr>;
export interface RawStatus {
  components?: Record<string, Record<string, RawCapability>>;
}

/** Parse a raw `/devices/{id}/status` response into a TVStatus. */
export function parseStatus(data: RawStatus): TVStatus {
  const main = data.components?.main ?? {};

  const power = main["switch"]?.["switch"]?.value as string | undefined;

  const inputCapability = INPUT_CAPABILITIES.find((c) => main[c] != null);
  const cap = inputCapability ? main[inputCapability] : undefined;

  const rawMap = (cap?.["supportedInputSourcesMap"]?.value ?? []) as RawSource[];
  const sources: InputSource[] = rawMap.map((s) => ({
    id: String(s.id),
    name: String(s.name ?? s.id),
  }));
  const currentInput = cap?.["inputSource"]?.value as string | undefined;

  return { power, inputCapability, currentInput, sources };
}

export interface RawDevice {
  deviceId: string;
  label?: string;
  name?: string;
  components?: { id: string; capabilities: { id: string }[] }[];
}

/** Capability ids on a device's "main" component. */
export function mainCapabilities(d: RawDevice): string[] {
  const main = d.components?.find((c) => c.id === "main");
  return (main?.capabilities ?? []).map((c) => c.id);
}

/** Pick the most likely TV from a device list: input-capable, preferring a power switch. */
export function pickTV(devices: STDevice[]): STDevice | null {
  const tvs = devices.filter((d) => INPUT_CAPABILITIES.some((c) => d.capabilities.includes(c)));
  return tvs.find((d) => d.capabilities.includes("switch")) ?? tvs[0] ?? null;
}

// --- OAuth decisions ---

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

// --- Config policy ---

const DEFAULTS: TVConfig = {
  pcInput: "HDMI2",
};

/** Merge parsed config over defaults and migrate the legacy "secret" key. */
export function mergeConfig(parsed: Partial<TVConfig> & { secret?: string }): TVConfig {
  // Accept the legacy "secret" key as an alias for clientSecret.
  if (parsed.secret && !parsed.clientSecret) parsed.clientSecret = parsed.secret;
  delete parsed.secret;
  return { ...DEFAULTS, ...parsed };
}

/** A fresh defaults-only config (used when no config file exists). */
export function defaultConfig(): TVConfig {
  return { ...DEFAULTS };
}

/** The static token to use: env var takes precedence over config.token. */
export function resolveStaticToken(config: TVConfig, envToken: string | undefined): string | undefined {
  return envToken?.trim() || config.token;
}

// --- Hotkey matching ---

export type Platform = "mac" | "other";

export interface KeyEvent {
  state: string; // "DOWN" | "UP"
  name?: string;
}
export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

/** True when the configured modifiers are held and `key` is the key going down. */
export function matchHotkey(e: KeyEvent, mods: ModifierState, key: string, platform: Platform): boolean {
  if (e.state !== "DOWN" || e.name !== key) return false;
  return platform === "mac" ? mods.meta && mods.ctrl : mods.ctrl && mods.alt;
}

// --- Boot window ---

/** True if the system booted within `windowSeconds` (i.e. the daemon started near boot). */
export function isWithinBootWindow(uptimeSeconds: number, windowSeconds = 120): boolean {
  return uptimeSeconds < windowSeconds;
}

// --- Trigger cooldown gate (timer-free state machine) ---

/**
 * Serializes triggers: a new trigger is rejected while one is running (busy) or within
 * `cooldownMs` after the last one settled. Equivalent to the old `busy` flag + setTimeout,
 * but holds no timer — callers pass the current time in.
 */
export class TriggerGate {
  private busy = false;
  private cooldownUntil = 0;

  constructor(private readonly cooldownMs: number) {}

  /** Returns true and marks busy if a trigger may start at `now`; false otherwise. */
  tryAcquire(now: number): boolean {
    if (this.busy || now < this.cooldownUntil) return false;
    this.busy = true;
    return true;
  }

  /** Call when a handler settles; opens a cooldown window of `cooldownMs` from `now`. */
  release(now: number): void {
    this.busy = false;
    this.cooldownUntil = now + this.cooldownMs;
  }
}

// --- Wake detection (timer-free state machine) ---

/**
 * Detects a sleep/wake gap from heartbeat ticks. Feed each tick's timestamp; a gap of at
 * least `gapMs` since the previous tick (outside the pause window) means the PC slept and
 * woke. After firing, detection is paused for `pauseMs`.
 */
export class WakeDetector {
  private last: number;
  private pausedUntil = 0;

  constructor(
    private readonly gapMs: number,
    private readonly pauseMs: number,
    startNow: number,
  ) {
    this.last = startNow;
  }

  /** Returns the approximate sleep duration (ms) if a wake is detected at `now`, else null. */
  tick(now: number): number | null {
    const gap = now - this.last;
    this.last = now;
    if (gap >= this.gapMs && now >= this.pausedUntil) {
      this.pausedUntil = now + this.pauseMs;
      return gap;
    }
    return null;
  }
}
