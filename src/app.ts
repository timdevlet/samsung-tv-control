// Composition root: wires all dependencies and exposes the app's command handlers.
// Both the CLI (src/cli.ts) and the daemon core (src/daemon-core.ts) build an app with
// createApp() and call its handlers — neither knows how the SmartThings client or
// config is constructed. Dependencies are wired per command invocation (each handler
// reloads config + rebuilds the client), so a long-running daemon picks up token
// refreshes rather than holding a stale client.

import { LocalTV, normalizeRemoteKey } from "./api/local-tv.js";
import {
  authorizeUrl,
  DEFAULT_REDIRECT_URI,
  exchangeCode,
  getAccessToken,
  hasOAuthClient,
} from "./api/oauth.js";
import { SmartThings } from "./api/smartthings.js";
import type { TVTransport } from "./api/transport.js";
import { loadConfig, resolveToken, type TVConfig } from "./config.js";
import { isMockMode } from "./dev/mock-cloud.js";
import { makeMockTransport } from "./dev/mock-transport.js";
import { autoWakeEnabled } from "./domain/config.js";
import type { DevicePower, STDevice, TVStatus } from "./domain/tv.js";
import { isOnInput, isTV, pickInput } from "./domain/tv.js";
import { log, logError } from "./log.js";

// Power-on retry loop: (re)send switch:on, wait, re-read status, up to POWER_ON_ATTEMPTS times,
// pausing POWER_ON_RETRY_MS between attempts. Bounds the wake wait at ~15s (5 × 3s).
const POWER_ON_ATTEMPTS = 5;
const POWER_ON_RETRY_MS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// True for a LAN-paired TV's synthetic deviceId (see localDeviceId() in api/local-tv.ts). Anything
// else is a cloud (SmartThings) UUID — the two id namespaces are what lets one transport route
// per-device without a global mode flag.
function isLocalDeviceId(deviceId: string): boolean {
  return deviceId.startsWith("local:");
}

// Runs the cloud and local transports side by side. Per-device operations are dispatched by
// deviceId (local ids → LocalTV, cloud UUIDs → SmartThings); the cloud client is built lazily and
// only when needed, so a local-only, signed-out user never triggers token resolution (which throws
// when no credentials exist). listDevices merges both sources, degrading to local-only if the
// cloud is unreachable/unauthorized rather than emptying the whole list.
class RoutingTransport implements TVTransport {
  private readonly local: LocalTV;
  private cloudClient?: SmartThings;

  constructor(
    private readonly config: TVConfig,
    private readonly resolveToken: (config: TVConfig) => Promise<string>,
  ) {
    this.local = new LocalTV(config);
  }

  // Lazily resolve a cloud client. Cached per invocation so a multi-TV command resolves the token
  // once. Throws (via resolveToken) when no credentials are configured — callers that can degrade
  // (the list methods) catch it; per-device cloud operations let it surface.
  private async cloud(): Promise<SmartThings> {
    if (!this.cloudClient) this.cloudClient = new SmartThings(await this.resolveToken(this.config));
    return this.cloudClient;
  }

  private async transportFor(deviceId: string): Promise<TVTransport> {
    return isLocalDeviceId(deviceId) ? this.local : this.cloud();
  }

  async getStatus(deviceId: string): Promise<TVStatus> {
    return (await this.transportFor(deviceId)).getStatus(deviceId);
  }

  async powerOn(deviceId: string): Promise<void> {
    await (await this.transportFor(deviceId)).powerOn(deviceId);
  }

  async powerOff(deviceId: string): Promise<void> {
    await (await this.transportFor(deviceId)).powerOff(deviceId);
  }

  async setInputSource(deviceId: string, capability: string, source: string): Promise<void> {
    await (await this.transportFor(deviceId)).setInputSource(deviceId, capability, source);
  }

  async sendKeys(deviceId: string, keys: string[]): Promise<void> {
    await (await this.transportFor(deviceId)).sendKeys(deviceId, keys);
  }

  async listDevices(): Promise<STDevice[]> {
    // Local is config-driven and always available; cloud is best-effort — a missing client (signed
    // out) or a cloud error must not hide the local TVs, so log and fall back to local-only.
    const local = await this.local.listDevices();
    let cloud: STDevice[] = [];
    try {
      cloud = await (await this.cloud()).listDevices();
    } catch (err) {
      log(
        `Cloud device list unavailable (${err instanceof Error ? err.message : String(err)}) — showing local TVs only.`,
      );
    }
    return [...local, ...cloud];
  }
}

// How a switch was initiated. `auto` marks the daemon's automatic triggers (wake-on-resume, boot
// reconcile) — the only case where a LAN TV whose input can't be read is left alone (blind remote
// keys would cycle a TV already on the PC input away from it). An explicit user action (hotkey,
// tray, button, CLI) always sends the input keys.
export interface SwitchOptions {
  auto?: boolean;
}

export interface App {
  login(): Promise<void>;
  // Switch the TV to the PC input, powering it on first if needed. `deviceIds` overrides the
  // Settings selection (used by per-device hotkeys); omitted = all selected TVs.
  // Resolves true when the commands went out, false when no TVs were selected.
  switch(inputOverride?: string, deviceIds?: string[], opts?: SwitchOptions): Promise<boolean>;
  off(deviceIds?: string[]): Promise<boolean>;
  // Power the TVs on without touching the input (the "TV on" command).
  powerOn(deviceIds?: string[]): Promise<boolean>;
  // Switch the input on TVs that are already on; an off TV is left off (the "switch HDMI"
  // command — unlike switch(), it never powers anything on).
  switchInputOnly(input: string, deviceIds?: string[]): Promise<boolean>;
  // Send an explicit remote-key sequence to one TV (the Settings "Run key sequence" action). The
  // raw tokens are normalized to KEY_* here. LAN-only in practice (the daemon guards the id);
  // resolves false when the sequence is empty, true when the keys went out.
  sendKeys(deviceId: string, rawKeys: string[]): Promise<boolean>;
  listDevices(): Promise<void>;
  // The TVs on the account (for the Settings selection UI).
  listTVs(): Promise<STDevice[]>;
  // Coarse current power of each given TV, for the Settings list's live status pills. Best-effort
  // per device: a TV that can't be probed (offline, or cloud while signed out) maps to "unknown".
  deviceStatuses(deviceIds: string[]): Promise<Record<string, DevicePower>>;
}

export function createApp(): App {
  // Resolve a usable access token. Precedence:
  //   1. SMARTTHINGS_TOKEN env var (explicit manual override, handy for testing)
  //   2. OAuth auto-refresh, if a client is configured and authorized
  //   3. Legacy static PAT in smartthings-config.json
  async function resolveAccessToken(config: TVConfig): Promise<string> {
    const envPat = process.env.SMARTTHINGS_TOKEN?.trim();
    if (envPat) return envPat;

    if (hasOAuthClient(config) && config.refreshToken) {
      return getAccessToken(config); // refreshes + persists the rotated token as needed
    }

    const pat = resolveToken(config);
    if (pat) return pat;

    if (hasOAuthClient(config)) {
      throw new Error("OAuth client configured but not authorized yet — run `npm run login` once.");
    }
    throw new Error(
      "No SmartThings credentials. Either run `npm run login` (OAuth, auto-refreshing) after adding " +
        '"clientId"/"clientSecret" to smartthings-config.json, or set SMARTTHINGS_TOKEN=<token>.',
    );
  }

  // The TVs commands target: the ids the user selected in Settings. Empty when nothing is
  // selected — callers log a hint and no-op rather than auto-picking a device.
  function resolveDeviceIds(config: TVConfig): string[] {
    return config.selectedDeviceIds ?? [];
  }

  // Build the transport for this invocation. Cloud and local run side by side: a single
  // RoutingTransport dispatches each operation to the right underlying transport by deviceId
  // (`local:<mac>` → LAN, a SmartThings UUID → cloud), and merges both device lists. Mock mode
  // still short-circuits to one in-process fake so `npm run electron:dev:mock` and tests never
  // touch the real cloud or LAN.
  async function buildTransport(config: TVConfig): Promise<TVTransport> {
    if (isMockMode()) return makeMockTransport(config);
    return new RoutingTransport(config, resolveAccessToken);
  }

  // DI core: load config, build the transport (which resolves a token only in cloud mode).
  async function connect(
    inputOverride?: string,
  ): Promise<{ config: TVConfig; transport: TVTransport }> {
    const config = await loadConfig();
    if (inputOverride) config.pcInput = inputOverride;
    const transport = await buildTransport(config);
    return { config, transport };
  }

  // Run `op` against every selected TV in parallel. One TV failing (offline, cloud error) must
  // not abort the others, so we use allSettled and log each rejection. But when *every* selected
  // TV failed we throw: that's almost certainly a transient network/cloud problem (e.g. WiFi still
  // reconnecting right after the PC resumed), not N dead TVs, and the daemon's wake-retry re-runs
  // the whole operation only on a thrown error. Returns false (and logs a hint) when nothing is
  // selected, so callers can stop early. `idsOverride` bypasses the Settings selection (per-device
  // hotkeys target specific TVs regardless of what's selected).
  async function forEachSelected(
    config: TVConfig,
    _transport: TVTransport,
    op: (deviceId: string) => Promise<void>,
    idsOverride?: string[],
  ): Promise<boolean> {
    const ids = idsOverride ?? resolveDeviceIds(config);
    if (ids.length === 0) {
      log("No TVs selected — choose one in Settings.");
      return false;
    }
    const results = await Promise.allSettled(ids.map((id) => op(id)));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        logError(
          `TV ${ids[i]} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        );
      }
    });
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length === ids.length) {
      throw failures.length === 1
        ? failures[0].reason
        : new Error(`all ${ids.length} selected TVs failed — see the per-device errors above`);
    }
    return true;
  }

  // Power the TV on and confirm it actually reports `on`. A single cloud switch:on can be
  // dropped (the TV's WiFi is still waking, or the command lands mid-transition), so we resend
  // up to POWER_ON_ATTEMPTS times. After each send we wait POWER_ON_RETRY_MS, then re-read status
  // — the TV needs a moment to come up after waking, and it only exposes its input-source map
  // once on. We return as soon as it reports `on`. If it never does we still return — the caller
  // logs and the input switch is attempted regardless.
  async function ensurePoweredOn(
    transport: TVTransport,
    deviceId: string,
    status: TVStatus,
    tag: string,
  ): Promise<TVStatus> {
    for (let attempt = 1; status.power !== "on" && attempt <= POWER_ON_ATTEMPTS; attempt++) {
      log(`${tag}TV is off — turning it on (attempt ${attempt}/${POWER_ON_ATTEMPTS})...`);
      await transport.powerOn(deviceId);
      await sleep(POWER_ON_RETRY_MS);
      status = await transport.getStatus(deviceId);
    }
    if (status.power === "on") log(`${tag}TV is on.`);
    else
      log(
        `${tag}TV still reports off after ${POWER_ON_ATTEMPTS} attempts — it may be unreachable by the cloud (deep standby).`,
      );
    return status;
  }

  // A per-device log prefix. Empty when only one TV is targeted (keeps the original single-TV log
  // lines unchanged); "[<alias or id>] " when several, so concurrent per-device lines stay
  // attributable — the user's alias reads better than the SmartThings UUID.
  function deviceTag(config: TVConfig, deviceId: string, ids: string[]): string {
    if (ids.length <= 1) return "";
    return `[${config.deviceConfigs?.[deviceId]?.alias || deviceId}] `;
  }

  // The input to switch/check for one TV: an explicit CLI override wins, then the TV's own
  // configured input, then the shared pcInput.
  function inputFor(config: TVConfig, deviceId: string, override?: string): string {
    return override?.trim() || config.deviceConfigs?.[deviceId]?.pcInput || config.pcInput;
  }

  // Read one line from stdin (only used by the one-time login flow).
  async function prompt(message: string): Promise<string> {
    const readline = await import("node:readline/promises");
    const { stdin, stdout } = await import("node:process");
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question(message)).trim();
    } finally {
      rl.close();
    }
  }

  // One-time OAuth bootstrap: approve in the browser, paste the code, save tokens.
  async function login(): Promise<void> {
    const config = await loadConfig();
    if (!hasOAuthClient(config)) {
      throw new Error(
        'Add your OAuth "clientId" and "clientSecret" to smartthings-config.json first.',
      );
    }

    log("\n1) Open this URL in your browser (logged into your Samsung account) and approve:\n");
    log(`   ${authorizeUrl(config)}\n`);
    log(
      `2) You'll be redirected to ${config.redirectUri ?? DEFAULT_REDIRECT_URI} with ?code=... in the URL.`,
    );
    log("   Copy the value of the `code` query parameter and paste it below.\n");

    const code = await prompt("Paste code: ");
    if (!code) throw new Error("No code entered.");

    await exchangeCode(config, code);
    log(
      "\n✅ Authorized. Tokens saved to smartthings-config.json — they now refresh automatically.",
    );
    log("   Run `npm start` to wake the TV and switch to PC.\n");
  }

  // Switch one already-on TV to `pcInput` — the shared second step of switchOne/inputOnlyOne.
  // `wasOn` = the TV was on before this operation (vs just woken by us); `auto` = triggered by
  // the daemon itself (resume/boot), not an explicit user action — see SwitchOptions.
  async function applyInput(
    transport: TVTransport,
    deviceId: string,
    status: TVStatus,
    pcInput: string,
    tag: string,
    wasOn: boolean,
    auto: boolean,
  ): Promise<void> {
    const capability = status.inputCapability;
    if (!capability) {
      throw new Error(
        "This device doesn't expose an input-source capability via SmartThings, so the source can't be changed.",
      );
    }
    // Best-effort input check, mirroring offOne: the LAN transport can't read the current input
    // (no currentInput/sources), and its input "switch" sends remote keys that move RELATIVE to
    // whatever input is active (KEY_HDMI and recorded sequences cycle). Whether to send them
    // blind to a TV that was already on depends on who asked:
    //   • an AUTOMATIC trigger (wake-on-resume, boot reconcile) — the TV is almost certainly
    //     still on the PC input, so blind keys would cycle AWAY from it. Skip.
    //   • an explicit user action (hotkey, tray, button, CLI) — the user is asking for the
    //     switch precisely because the TV may be on another input. Send the keys.
    // A TV we just woke always gets the keys (it needs them to land on the PC input).
    const inputKnown = Boolean(status.currentInput) || status.sources.length > 0;
    if (!inputKnown && wasOn) {
      if (auto) {
        log(
          `${tag}TV was already on and its input can't be read over this connection — leaving the input unchanged.`,
        );
        return;
      }
      log(
        `${tag}The current input can't be read over this connection — sending the input keys anyway.`,
      );
    }

    const target = pickInput(status, pcInput);
    if (isOnInput(status, target)) {
      log(`${tag}Input is already on ${target}.`);
    } else {
      log(`${tag}Switching input to ${target}...`);
      await transport.setInputSource(deviceId, capability, target);
    }
  }

  // Switch one TV to its PC input, powering it on first if needed. `auto` = triggered by the
  // daemon itself (resume/boot), not an explicit user action — see SwitchOptions.
  async function switchOne(
    transport: TVTransport,
    deviceId: string,
    pcInput: string,
    tag: string,
    auto: boolean,
  ): Promise<void> {
    // 1) Check status first; if off, wake it before switching input. We re-read after waking
    // because the off-state status often doesn't include the input-source map.
    let status = await transport.getStatus(deviceId);
    const wasOn = status.power === "on";
    status = await ensurePoweredOn(transport, deviceId, status, tag);

    // If the TV never came on after all retries, stop here rather than throwing: there's no
    // input-source map to switch to, and ensurePoweredOn has already logged the give-up. Throwing
    // would make the daemon's wake retry pointlessly re-run the whole already-connected operation
    // (its retry is for transient connect/network failures right after wake, not a dead TV).
    if (status.power !== "on") return;

    // 2) Switch the input to the PC, skipping when it's already on the target.
    await applyInput(transport, deviceId, status, pcInput, tag, wasOn, auto);

    log(`${tag}Done — TV is on and on the target input.`);
  }

  // Power one TV on without touching its input (the "TV on" command).
  async function powerOnOne(transport: TVTransport, deviceId: string, tag: string): Promise<void> {
    const status = await transport.getStatus(deviceId);
    if (status.power === "on") {
      log(`${tag}TV is already on.`);
      return;
    }
    await ensurePoweredOn(transport, deviceId, status, tag);
  }

  // Switch one TV's input only if it's already on; an off TV is deliberately left off.
  async function inputOnlyOne(
    transport: TVTransport,
    deviceId: string,
    input: string,
    tag: string,
  ): Promise<void> {
    const status = await transport.getStatus(deviceId);
    if (status.power !== "on") {
      log(`${tag}TV is off — not switching its input (use a "TV on + input" command to wake it).`);
      return;
    }
    // Always user-initiated (there is no automatic trigger for input-only), so auto=false.
    await applyInput(transport, deviceId, status, input, tag, true, false);
    log(`${tag}Done — input switched.`);
  }

  // Switch every targeted TV to its PC input, powering each on first if needed.
  async function switchInput(
    inputOverride?: string,
    deviceIds?: string[],
    opts?: SwitchOptions,
  ): Promise<boolean> {
    const { config, transport } = await connect(inputOverride);
    const ids = deviceIds ?? resolveDeviceIds(config);
    // An automatic trigger (resume/boot) honors each TV's autoWake opt-out; a user action never
    // filters. All targets opted out is a success, not the "No TVs selected" error path — and it
    // must not throw, or the daemon's wake retry loop would pointlessly re-run it.
    let targetIds = ids;
    if (opts?.auto) {
      targetIds = ids.filter((id) => autoWakeEnabled(config.deviceConfigs?.[id]));
      for (const id of ids) {
        if (!targetIds.includes(id)) {
          log(
            `[${config.deviceConfigs?.[id]?.alias || id}] Automatic power-on is off for this TV — leaving it alone.`,
          );
        }
      }
      if (targetIds.length === 0 && ids.length > 0) {
        log("Automatic power-on is off for every selected TV — skipping.");
        return true;
      }
    }
    return forEachSelected(
      config,
      transport,
      (deviceId) =>
        switchOne(
          transport,
          deviceId,
          inputFor(config, deviceId, inputOverride),
          deviceTag(config, deviceId, targetIds),
          opts?.auto ?? false,
        ),
      targetIds,
    );
  }

  // Power every targeted TV on, leaving inputs alone.
  async function powerOn(deviceIds?: string[]): Promise<boolean> {
    const { config, transport } = await connect();
    const ids = deviceIds ?? resolveDeviceIds(config);
    return forEachSelected(
      config,
      transport,
      (deviceId) => powerOnOne(transport, deviceId, deviceTag(config, deviceId, ids)),
      deviceIds,
    );
  }

  // Switch every targeted TV that's already on to `input`; off TVs stay off.
  async function switchInputOnly(input: string, deviceIds?: string[]): Promise<boolean> {
    const { config, transport } = await connect();
    const ids = deviceIds ?? resolveDeviceIds(config);
    return forEachSelected(
      config,
      transport,
      (deviceId) =>
        inputOnlyOne(
          transport,
          deviceId,
          inputFor(config, deviceId, input),
          deviceTag(config, deviceId, ids),
        ),
      deviceIds,
    );
  }

  // Send an explicit remote-key sequence to one TV. Unlike the command actions this targets a
  // single explicit device (no Settings-selection fan-out) and never powers on or reads status —
  // it just fires the keys. Tokens are normalized to KEY_* ids here; an empty result no-ops.
  async function sendKeys(deviceId: string, rawKeys: string[]): Promise<boolean> {
    const keys = rawKeys.map(normalizeRemoteKey).filter(Boolean);
    if (keys.length === 0) return false;
    const { transport } = await connect();
    log(`Sending keys to ${deviceId}: ${keys.join(", ")}`);
    await transport.sendKeys(deviceId, keys);
    return true;
  }

  // Turn one TV off, but only when it's currently on its PC input.
  async function offOne(
    transport: TVTransport,
    deviceId: string,
    pcInput: string,
    tag: string,
  ): Promise<void> {
    const status = await transport.getStatus(deviceId);

    if (status.power === "off") {
      log(`${tag}TV is already off.`);
      return;
    }

    // Best-effort input check: the cloud reports the current input, so we only power off when it's
    // on the PC input (leaving a TV showing something else alone). A LAN transport usually can't
    // read the input at all (no currentInput/sources) — in that case we can't tell, so we assume
    // it's on PC and power off rather than never turning it off. When the input IS known, keep the
    // strict check.
    const inputKnown = Boolean(status.currentInput) || status.sources.length > 0;
    const pcSource = pickInput(status, pcInput);
    if (inputKnown && !isOnInput(status, pcSource)) {
      log(
        `${tag}TV input is "${status.currentInput ?? "?"}", not PC (${pcSource}) — leaving it on.`,
      );
      return;
    }
    if (!inputKnown) {
      log(`${tag}Can't read the current input over this connection — assuming PC and turning off.`);
    }

    // Neutral wording: this runs both from "TV off + sleep this PC" and the sleep-free TV off.
    log(`${tag}TV is on PC input — turning the TV off...`);
    await transport.powerOff(deviceId);
    log(`${tag}Done — TV turned off.`);
  }

  // Turn every targeted TV off (each only if it's on its PC input).
  async function off(deviceIds?: string[]): Promise<boolean> {
    const { config, transport } = await connect();
    const ids = deviceIds ?? resolveDeviceIds(config);
    return forEachSelected(
      config,
      transport,
      (deviceId) =>
        offOne(transport, deviceId, inputFor(config, deviceId), deviceTag(config, deviceId, ids)),
      deviceIds,
    );
  }

  // List account devices with their main capabilities (`--devices`).
  async function listDevices(): Promise<void> {
    const config = await loadConfig();
    const transport = await buildTransport(config);
    const devices = await transport.listDevices();
    if (devices.length === 0) {
      log("No devices found on this SmartThings account.");
      return;
    }
    for (const dev of devices) {
      log(`• ${dev.label}  [${dev.deviceId}]`);
      log(`    capabilities: ${dev.capabilities.join(", ") || "(none)"}`);
    }
  }

  // The account's TVs, for the Settings selection UI. Builds a client the same way listDevices
  // does (load config → resolve token), then filters to input-capable devices.
  async function listTVs(): Promise<STDevice[]> {
    const config = await loadConfig();
    const transport = await buildTransport(config);
    return (await transport.listDevices()).filter(isTV);
  }

  // Probe the current power of each given TV for the Settings list's status pills. Builds the
  // transport once (not per device) so N TVs cost one config load + token resolution, then probes
  // all in parallel. Each probe is independent and best-effort: an offline TV or a cloud TV while
  // signed out rejects, which we map to "unknown" so one dead TV never fails the whole batch.
  async function deviceStatuses(deviceIds: string[]): Promise<Record<string, DevicePower>> {
    const config = await loadConfig();
    const transport = await buildTransport(config);
    const entries = await Promise.all(
      deviceIds.map(async (deviceId): Promise<[string, DevicePower]> => {
        try {
          const { power } = await transport.getStatus(deviceId);
          return [deviceId, power === "on" ? "on" : power === "off" ? "off" : "unknown"];
        } catch {
          return [deviceId, "unknown"];
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  // `switch` is a JS reserved word, so the internal fn is `switchInput`, exposed as `switch`.
  return {
    login,
    switch: switchInput,
    off,
    powerOn,
    switchInputOnly,
    sendKeys,
    listDevices,
    listTVs,
    deviceStatuses,
  };
}
