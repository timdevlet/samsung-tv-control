// Composition root: wires all dependencies and exposes the app's command handlers.
// Both the CLI (src/cli.ts) and the daemon core (src/daemon-core.ts) build an app with
// createApp() and call its handlers — neither knows how the SmartThings client or
// config is constructed. Dependencies are wired per command invocation (each handler
// reloads config + rebuilds the client), so a long-running daemon picks up token
// refreshes rather than holding a stale client.

import { loadConfig, resolveToken, type TVConfig } from "./config.js";
import { hasOAuthClient, getAccessToken, authorizeUrl, exchangeCode, DEFAULT_REDIRECT_URI } from "./api/oauth.js";
import { pickInput, isOnInput } from "./domain/tv.js";
import { SmartThings } from "./api/smartthings.js";
import type { TVStatus, STDevice } from "./domain/tv.js";
import { log, logError } from "./log.js";

// Power-on retry loop: (re)send switch:on, wait, re-read status, up to POWER_ON_ATTEMPTS times,
// pausing POWER_ON_RETRY_MS between attempts. Bounds the wake wait at ~15s (5 × 3s).
const POWER_ON_ATTEMPTS = 5;
const POWER_ON_RETRY_MS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface App {
  login(): Promise<void>;
  // Switch the TV to the PC input, powering it on first if needed. `deviceIds` overrides the
  // Settings selection (used by per-device hotkeys); omitted = all selected TVs.
  // Resolves true when the commands went out, false when no TVs were selected.
  switch(inputOverride?: string, deviceIds?: string[]): Promise<boolean>;
  off(deviceIds?: string[]): Promise<boolean>;
  listDevices(): Promise<void>;
  // The TVs on the account (for the Settings selection UI).
  listTVs(): Promise<STDevice[]>;
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
        "\"clientId\"/\"clientSecret\" to smartthings-config.json, or set SMARTTHINGS_TOKEN=<token>.",
    );
  }

  // The TVs commands target: the ids the user selected in Settings. Empty when nothing is
  // selected — callers log a hint and no-op rather than auto-picking a device.
  function resolveDeviceIds(config: TVConfig): string[] {
    return config.selectedDeviceIds ?? [];
  }

  // DI core: load config, resolve token, build the client.
  async function connect(inputOverride?: string): Promise<{ config: TVConfig; st: SmartThings }> {
    const config = await loadConfig();
    if (inputOverride) config.pcInput = inputOverride;
    const st = new SmartThings(await resolveAccessToken(config));
    return { config, st };
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
    st: SmartThings,
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
        logError(`TV ${ids[i]} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
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
  async function ensurePoweredOn(st: SmartThings, deviceId: string, status: TVStatus, tag: string): Promise<TVStatus> {
    for (let attempt = 1; status.power !== "on" && attempt <= POWER_ON_ATTEMPTS; attempt++) {
      log(`${tag}TV is off — turning it on (attempt ${attempt}/${POWER_ON_ATTEMPTS})...`);
      await st.powerOn(deviceId);
      await sleep(POWER_ON_RETRY_MS);
      status = await st.getStatus(deviceId);
    }
    if (status.power === "on") log(`${tag}TV is on.`);
    else log(`${tag}TV still reports off after ${POWER_ON_ATTEMPTS} attempts — it may be unreachable by the cloud (deep standby).`);
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
      throw new Error('Add your OAuth "clientId" and "clientSecret" to smartthings-config.json first.');
    }

    log("\n1) Open this URL in your browser (logged into your Samsung account) and approve:\n");
    log("   " + authorizeUrl(config) + "\n");
    log(`2) You'll be redirected to ${config.redirectUri ?? DEFAULT_REDIRECT_URI} with ?code=... in the URL.`);
    log("   Copy the value of the `code` query parameter and paste it below.\n");

    const code = await prompt("Paste code: ");
    if (!code) throw new Error("No code entered.");

    await exchangeCode(config, code);
    log("\n✅ Authorized. Tokens saved to smartthings-config.json — they now refresh automatically.");
    log("   Run `npm start` to wake the TV and switch to PC.\n");
  }

  // Switch one TV to its PC input, powering it on first if needed.
  async function switchOne(st: SmartThings, deviceId: string, pcInput: string, tag: string): Promise<void> {
    // 1) Check status first; if off, wake it before switching input. We re-read after waking
    // because the off-state status often doesn't include the input-source map.
    let status = await st.getStatus(deviceId);
    status = await ensurePoweredOn(st, deviceId, status, tag);

    // If the TV never came on after all retries, stop here rather than throwing: there's no
    // input-source map to switch to, and ensurePoweredOn has already logged the give-up. Throwing
    // would make the daemon's wake retry pointlessly re-run the whole already-connected operation
    // (its retry is for transient connect/network failures right after wake, not a dead TV).
    if (status.power !== "on") return;

    // 2) Switch the input to the PC, skipping when it's already on the target.
    const capability = status.inputCapability;
    if (!capability) {
      throw new Error(
        "This device doesn't expose an input-source capability via SmartThings, so the source can't be changed.",
      );
    }
    const target = pickInput(status, pcInput);
    if (isOnInput(status, target)) {
      log(`${tag}Input is already on ${target}.`);
    } else {
      log(`${tag}Switching input to ${target} (PC)...`);
      await st.setInputSource(deviceId, capability, target);
    }

    log(`${tag}Done — TV is on and switched to PC.`);
  }

  // Switch every targeted TV to its PC input, powering each on first if needed.
  async function switchInput(inputOverride?: string, deviceIds?: string[]): Promise<boolean> {
    const { config, st } = await connect(inputOverride);
    const ids = deviceIds ?? resolveDeviceIds(config);
    return forEachSelected(
      config,
      st,
      (deviceId) =>
        switchOne(st, deviceId, inputFor(config, deviceId, inputOverride), deviceTag(config, deviceId, ids)),
      deviceIds,
    );
  }

  // Turn one TV off, but only when it's currently on its PC input.
  async function offOne(st: SmartThings, deviceId: string, pcInput: string, tag: string): Promise<void> {
    const status = await st.getStatus(deviceId);

    if (status.power === "off") {
      log(`${tag}TV is already off.`);
      return;
    }

    const pcSource = pickInput(status, pcInput);
    if (!isOnInput(status, pcSource)) {
      log(`${tag}TV input is "${status.currentInput ?? "?"}", not PC (${pcSource}) — leaving it on.`);
      return;
    }

    log(`${tag}PC is sleeping and TV is on PC input — turning the TV off...`);
    await st.powerOff(deviceId);
    log(`${tag}Done — TV turned off.`);
  }

  // Turn every targeted TV off (each only if it's on its PC input).
  async function off(deviceIds?: string[]): Promise<boolean> {
    const { config, st } = await connect();
    const ids = deviceIds ?? resolveDeviceIds(config);
    return forEachSelected(
      config,
      st,
      (deviceId) => offOne(st, deviceId, inputFor(config, deviceId), deviceTag(config, deviceId, ids)),
      deviceIds,
    );
  }

  // List account devices with their main capabilities (`--devices`).
  async function listDevices(): Promise<void> {
    const config = await loadConfig();
    const st = new SmartThings(await resolveAccessToken(config));
    const devices = await st.listDevices();
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
    const st = new SmartThings(await resolveAccessToken(config));
    return st.listTVs();
  }

  // `switch` is a JS reserved word, so the internal fn is `switchInput`, exposed as `switch`.
  return { login, switch: switchInput, off, listDevices, listTVs };
}
