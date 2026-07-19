// Pure config types & policy — no I/O. The file adapter lives in src/config.ts.

// App color theme: fixed light/dark, or follow the OS setting.
export type ThemePreference = "light" | "dark" | "system";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

// Sentinel wsToken for a TV that accepts the connection but issues no token — some Samsung models
// authorize a client by name/IP and never send one on ms.channel.connect. We still need a
// non-empty marker so the TV persists as paired (empty wsToken = "not paired", and
// normalizeDeviceConfigs prunes empty tokens). At send time this sentinel maps back to a
// token-less connection (see RoutingTransport.sendKeys / wsTokenForConnect).
export const NO_TOKEN_PAIRED = "__no_token__";

// The wsToken value to actually put on the wire: the sentinel means "paired, connect without a
// token", so it resolves to undefined (remoteUrl then builds a token-less URL).
export function wsTokenForConnect(wsToken?: string): string | undefined {
  return wsToken && wsToken !== NO_TOKEN_PAIRED ? wsToken : undefined;
}

// A TV's own settings, all optional — an unset field falls back to the app-wide behavior.
export interface DeviceConfig {
  // Custom display name shown instead of the SmartThings label (e.g. "65 TV").
  alias?: string;
  // Free-text note shown under the name (e.g. "living room tv").
  description?: string;
  // Input the PC is on for THIS TV; unset = the shared pcInput. No longer editable in the UI —
  // kept because the daemon's automatic wake (resume/boot) still switches to the PC input.
  pcInput?: string;
  // Whether the daemon's automatic power-on (PC resume / boot) acts on this TV. Default true;
  // only `false` is ever persisted (see normalizeDeviceConfigs). Never affects user-initiated
  // actions (hotkeys, tray, Power screen, commands).
  autoWake?: boolean;

  // Local (LAN) transport fields — set for LAN-paired TVs (deviceId "local:…"); cloud TVs
  // (SmartThings UUIDs) leave them unset.
  // The TV's LAN IP or hostname (the WebSocket + info-endpoint target).
  host?: string;
  // The TV's MAC address, for the Wake-on-LAN magic packet. Canonicalized (lowercase, colon-
  // separated) on save so packet construction is deterministic.
  mac?: string;
  // Optional comma-separated remote-key sequence to reach the PC input over LAN (e.g.
  // "KEY_HDMI,KEY_HDMI"). There's no authoritative "set HDMI2" over the local remote protocol,
  // so an advanced user can record the keypresses that land on their PC input. Unset = send a
  // single source/HDMI key.
  inputKeySeq?: string;
  // Extra seconds to wait between the keys of a sequence sent to this TV (> 0, ≤ 5; decimals ok)
  // — some TVs/menus need more than the default ~200ms beat between presses. Unset = default
  // pacing only.
  keyDelay?: number;
  // The local WebSocket pairing token returned by the TV's on-screen "Allow" the first time we
  // connect. A SECRET — persisted here but never surfaced to the renderer (getSettings exposes
  // only a `paired` boolean) and only written by the pairing IPC, not through saveSettings.
  wsToken?: string;
}

// The DeviceConfig plain-string fields normalized field-by-field from untrusted maps. wsToken is
// handled separately (see normalizeDeviceConfigs) so it's preserved but never treated as a
// user-editable text field.
const DEVICE_CONFIG_FIELDS = [
  "alias",
  "description",
  "pcInput",
  "host",
  "mac",
  "inputKeySeq",
] as const;

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
  // id ("HDMI3") first, then by label ("PC"). Default "HDMI2". No longer editable in the UI —
  // kept because the daemon's automatic wake (resume/boot) and the tray actions still switch to
  // the PC input; user-facing input choices live in `commands`.
  pcInput: string;

  // App behavior
  // When true (default), closing the window hides it to the tray and the daemon
  // keeps running. When false, closing the window quits the app.
  minimizeToTrayOnClose?: boolean;

  // Device ids of the TVs commands target. Chosen in Settings from the account's
  // TV list. Empty/unset means none selected — commands no-op rather than auto-pick.
  selectedDeviceIds?: string[];

  // Per-TV settings keyed by SmartThings deviceId: alias/description, LAN fields, and a stored
  // input override (see DeviceConfig.pcInput).
  deviceConfigs?: Record<string, DeviceConfig>;

  // App color theme. "system" follows the OS light/dark setting. Unset means dark —
  // the app's historical appearance.
  theme?: ThemePreference;

  // User-defined command list (Settings → Commands): each entry is an action, an HDMI input for
  // the switch actions, and an optional hotkey. Run from the Settings list or via the hotkey;
  // acts on the TVs selected in Settings, like the built-in wake/off pair.
  commands?: CommandConfig[];
}

const DEFAULTS: TVConfig = {
  pcInput: "HDMI2",
  minimizeToTrayOnClose: true,
};

// Merge parsed config over defaults and migrate/retire legacy keys.
export function mergeConfig(
  parsed: Partial<TVConfig> & {
    secret?: string;
    transportMode?: string;
    wakeHotkey?: string;
    offHotkey?: string;
    hotkeyBindings?: unknown;
    mainButtons?: unknown;
  },
): TVConfig {
  // Accept the legacy "secret" key as an alias for clientSecret.
  if (parsed.secret && !parsed.clientSecret) parsed.clientSecret = parsed.secret;
  delete parsed.secret;
  // transportMode is retired: cloud and local run side by side, routed per deviceId (app.ts's
  // RoutingTransport) — nothing selects a transport globally anymore. Drop the stale key so old
  // configs shed it on their next save.
  delete parsed.transportMode;
  // The global wake/off hotkeys (and the even older hotkeyBindings list) are retired: hotkeys
  // are now bound per command (see `commands`). Drop the stale keys so old configs shed them.
  delete parsed.wakeHotkey;
  delete parsed.offHotkey;
  delete parsed.hotkeyBindings;
  // The built-in Main-screen power buttons are retired: the Main screen shows only pinned
  // commands now. Drop the stale toggle map so old configs shed it on their next save.
  delete parsed.mainButtons;
  return { ...DEFAULTS, ...parsed };
}

// A fresh defaults-only config (used when no config file exists).
export function defaultConfig(): TVConfig {
  return { ...DEFAULTS };
}

// The static token to use: env var takes precedence over config.token.
export function resolveStaticToken(
  config: TVConfig,
  envToken: string | undefined,
): string | undefined {
  return envToken?.trim() || config.token;
}

// Sign out: drop everything that identifies the signed-in account (OAuth tokens + the legacy
// static token) while keeping the OAuth client (clientId/clientSecret/redirectUri/scopes) and
// all user preferences, so the next sign-in reuses the configured client with no re-entry.
export function clearTokens(config: TVConfig): TVConfig {
  const next = { ...config };
  delete next.refreshToken;
  delete next.accessToken;
  delete next.accessTokenExpiresAt;
  delete next.token;
  return next;
}

// Coerce an untrusted value (config file / IPC payload) to a valid theme, defaulting to dark —
// the app's historical appearance.
export function normalizeTheme(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : "dark";
}

// Canonicalize a MAC address to lowercase colon-separated form ("AA-BB-…" / "aabb…" → "aa:bb:…")
// so the Wake-on-LAN packet is built deterministically. Returns "" for anything that isn't 12
// hex digits once separators are stripped — the caller treats that as "no MAC".
export function canonicalizeMac(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 12) return "";
  // Safe: length === 12 is guaranteed above, so this match never returns null.
  return hex.match(/.{2}/g)!.join(":");
}

// User-defined commands

// What a command does when run. The HDMI-switching actions carry which input to switch to;
// "tvOffSleepPc" also puts this computer to sleep after the TV is off.
export type CommandAction = "tvOn" | "tvOff" | "tvOnHdmi" | "tvOffSleepPc" | "switchHdmi";

export const COMMAND_ACTIONS: readonly CommandAction[] = [
  "tvOn",
  "tvOff",
  "tvOnHdmi",
  "tvOffSleepPc",
  "switchHdmi",
];

// The HDMI inputs a command can switch to (matched against the TV's input map like pcInput —
// by id first, then label).
export const COMMAND_HDMI_INPUTS = ["HDMI1", "HDMI2", "HDMI3", "HDMI4", "HDMI5"] as const;

// True for a LAN-paired TV's synthetic deviceId (see localDeviceId() in api/local-tv.ts). A LAN
// command runs a raw key sequence instead of a cloud action, so several places branch on this.
export function isLocalDeviceId(deviceId: string): boolean {
  return deviceId.startsWith("local:");
}

// One entry of the user-defined command list. A command targets a single TV. What it does depends
// on that TV: a CLOUD TV runs `action` (with `hdmi` for the switch actions); a LAN TV runs the
// raw `keySeq` instead (there's no SmartThings action channel over the LAN — see commandIsKeySeq).
export interface CommandConfig {
  // Stable id (minted by the UI when the row is added) — React key + run/delete identity.
  id: string;
  action: CommandAction;
  // The TVs this command targets. Unset/empty = every TV selected in Settings ("all enabled TVs").
  // The UI now picks a single TV, so this holds at most one id; the array shape is kept for
  // backward/`forEachSelected` compatibility.
  deviceIds?: string[];
  // Which HDMI input to switch to; present only for the HDMI-switching actions (cloud target).
  hdmi?: string;
  // A comma-separated remote-key sequence (e.g. "HDMI, UP, UP, LEFT") run when the target is a LAN
  // TV — used instead of `action`. Unset/empty for a cloud command. Normalized to KEY_* at send.
  keySeq?: string;
  // Optional global hotkey (Electron accelerator). Unset/empty = run only from the Settings list.
  hotkey?: string;
  // When true, this command is surfaced as a button on the Main screen (which shows only pinned
  // commands). Unset/false = it lives only in the Settings list. Toggled by the eye icon.
  pinned?: boolean;
}

// True when the action switches inputs, so a command needs its HDMI selection.
export function commandUsesHdmi(action: CommandAction): boolean {
  return action === "tvOnHdmi" || action === "switchHdmi";
}

// True when this command runs a raw key sequence rather than a cloud action: its single target is
// a LAN TV. A command with no target (all enabled TVs) or a cloud target runs its `action`.
export function commandIsKeySeq(cmd: CommandConfig): boolean {
  const id = cmd.deviceIds?.[0];
  return id != null && isLocalDeviceId(id);
}

// Human label for a command, used in logs and as the accessible name of its Run button. A LAN
// key-sequence command is labeled by its sequence rather than a cloud action verb.
export function commandLabel(cmd: CommandConfig): string {
  if (commandIsKeySeq(cmd)) {
    const seq = cmd.keySeq?.trim();
    return seq ? `Keys: ${seq}` : "Key sequence";
  }
  switch (cmd.action) {
    case "tvOn":
      return "TV on";
    case "tvOff":
      return "TV off";
    case "tvOnHdmi":
      return `TV on → ${cmd.hdmi ?? "HDMI?"}`;
    case "tvOffSleepPc":
      return "TV off + sleep PC";
    case "switchHdmi":
      return `Switch to ${cmd.hdmi ?? "HDMI?"}`;
  }
}

// Coerce an untrusted value (config file / IPC payload) to a clean command list. Entries with an
// unknown action are dropped; an HDMI action outside the known list falls back to HDMI1 and a
// non-HDMI action sheds any stray hdmi field; a missing id gets a positional fallback (stable
// enough for React keys — the UI always mints real ids for rows it creates).
export function normalizeCommands(value: unknown): CommandConfig[] {
  if (!Array.isArray(value)) return [];
  const result: CommandConfig[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const action = entry.action;
    if (!COMMAND_ACTIONS.includes(action as CommandAction)) continue;
    const cmd: CommandConfig = {
      id:
        typeof entry.id === "string" && entry.id.trim()
          ? entry.id.trim()
          : `cmd-${result.length + 1}`,
      action: action as CommandAction,
    };
    // Target TVs: an array of non-empty ids, deduped. The pre-checkbox shape stored a single
    // `deviceId` string — migrate it. Empty/absent = all enabled TVs.
    const rawIds = Array.isArray(entry.deviceIds)
      ? entry.deviceIds
      : typeof entry.deviceId === "string"
        ? [entry.deviceId]
        : [];
    const deviceIds = [
      ...new Set(
        rawIds
          .filter((v): v is string => typeof v === "string" && v.trim() !== "")
          .map((v) => v.trim()),
      ),
    ];
    if (deviceIds.length > 0) cmd.deviceIds = deviceIds;
    // A LAN-targeted command runs a raw key sequence instead of a cloud action — keep its keySeq
    // (trimmed) and skip the HDMI handling. A cloud/all-TVs command keeps hdmi for the switch
    // actions as before and sheds any stray keySeq.
    if (commandIsKeySeq(cmd)) {
      if (typeof entry.keySeq === "string" && entry.keySeq.trim()) cmd.keySeq = entry.keySeq.trim();
    } else if (commandUsesHdmi(cmd.action)) {
      const raw = typeof entry.hdmi === "string" ? entry.hdmi.trim() : "";
      // A known HDMI input is normalized to its canonical upper-case id; any other non-empty value
      // is a custom input name/alias (e.g. "pc") kept verbatim so it can be matched by label or
      // mapped by the LAN transport. Empty falls back to HDMI1.
      const known = (COMMAND_HDMI_INPUTS as readonly string[]).includes(raw.toUpperCase());
      cmd.hdmi = known ? raw.toUpperCase() : raw || "HDMI1";
    }
    if (typeof entry.hotkey === "string" && entry.hotkey.trim()) cmd.hotkey = entry.hotkey.trim();
    if (entry.pinned === true) cmd.pinned = true;
    result.push(cmd);
  }
  return result;
}

// Coerce an untrusted value (config file / IPC payload) to a clean per-device config map:
// only non-empty string fields are kept (trimmed), and entries left with no field at all are
// pruned entirely — so clearing every field of a TV removes it from the persisted map.
export function normalizeDeviceConfigs(value: unknown): Record<string, DeviceConfig> {
  const result: Record<string, DeviceConfig> = {};
  if (typeof value !== "object" || value === null) return result;
  for (const [deviceId, raw] of Object.entries(value)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry: DeviceConfig = {};
    for (const field of DEVICE_CONFIG_FIELDS) {
      const v = (raw as Record<string, unknown>)[field];
      if (typeof v === "string" && v.trim()) entry[field] = v.trim();
    }
    // Canonicalize a captured MAC so WoL is deterministic; drop it if it isn't a valid MAC.
    if (entry.mac) {
      const mac = canonicalizeMac(entry.mac);
      if (mac) entry.mac = mac;
      else delete entry.mac;
    }
    // wsToken is a secret set by the pairing IPC, not a user text field — preserve it as-is
    // (it also keeps a paired-but-otherwise-empty TV from being pruned below).
    const token = (raw as Record<string, unknown>).wsToken;
    if (typeof token === "string" && token.trim()) entry.wsToken = token.trim();
    // keyDelay is numeric, not a text field: accept a number or numeric string (the renderer
    // sends the form value as a string), clamp to the 0–5s range, and store only a meaningful
    // value (> 0) — 0/junk means "default pacing" and stays unpersisted.
    const rawDelay = (raw as Record<string, unknown>).keyDelay;
    if (typeof rawDelay === "number" || (typeof rawDelay === "string" && rawDelay.trim())) {
      const n = Number(rawDelay);
      if (Number.isFinite(n) && n > 0) entry.keyDelay = Math.min(5, n);
    }
    // autoWake defaults to true, so only the opt-out is stored — a strict `false` here keeps an
    // opt-out-only entry from being pruned below, while `true` (or junk) stays unpersisted.
    if ((raw as Record<string, unknown>).autoWake === false) entry.autoWake = false;
    if (Object.keys(entry).length > 0) result[deviceId] = entry;
  }
  return result;
}

// Whether the daemon's automatic power-on may act on this TV. Strict `!== false` because the
// daemon consumes raw loadConfig() output (only the settings bridge normalizes), so hand-edited
// junk values ("false", 0) safely fall back to enabled.
export function autoWakeEnabled(cfg?: DeviceConfig): boolean {
  return cfg?.autoWake !== false;
}
