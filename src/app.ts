// Composition root: wires all dependencies and exposes the app's command handlers.
// Both the CLI (src/cli.ts) and the daemon (src/daemon.ts) build an app with
// createApp() and call its handlers — neither knows how the SmartThings client or
// config is constructed. Dependencies are wired per command invocation (each handler
// reloads config + rebuilds the client), so a long-running daemon picks up token
// refreshes rather than holding a stale client.

import { loadConfig, resolveToken, type TVConfig } from "./config.js";
import { hasOAuthClient, getAccessToken, authorizeUrl, exchangeCode, DEFAULT_REDIRECT_URI } from "./api/oauth.js";
import { pickInput, isOnInput } from "./domain/tv.js";
import { SmartThings } from "./api/smartthings.js";
import type { TVStatus } from "./domain/tv.js";
import { log } from "./log.js";

// Power-on retry loop: (re)send switch:on, wait, re-read status, up to POWER_ON_ATTEMPTS times,
// pausing POWER_ON_RETRY_MS between attempts. Bounds the wake wait at ~30s (10 × 3s).
const POWER_ON_ATTEMPTS = 10;
const POWER_ON_RETRY_MS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface App {
  login(): Promise<void>;
  // Switch the TV to the PC input, powering it on first if needed.
  switch(inputOverride?: string): Promise<void>;
  off(): Promise<void>;
  listDevices(): Promise<void>;
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

  // Resolve the TV's device id by discovering it fresh on every run (no caching).
  async function resolveDevice(st: SmartThings): Promise<string> {
    log("Finding the TV in your SmartThings account...");
    const tv = await st.findTV();
    if (!tv) {
      throw new Error(
        "No TV found in SmartThings. Add it in the SmartThings app first, then run `npm run devices` to inspect.",
      );
    }
    log(`Found "${tv.label}".`);
    return tv.deviceId;
  }

  // DI core: load config, resolve token, build the client, resolve the device id.
  async function connect(inputOverride?: string): Promise<{ config: TVConfig; st: SmartThings; deviceId: string }> {
    const config = await loadConfig();
    if (inputOverride) config.pcInput = inputOverride;
    const st = new SmartThings(await resolveAccessToken(config));
    const deviceId = await resolveDevice(st);
    return { config, st, deviceId };
  }

  // Power the TV on and confirm it actually reports `on`. A single cloud switch:on can be
  // dropped (the TV's WiFi is still waking, or the command lands mid-transition), so we resend
  // up to POWER_ON_ATTEMPTS times. After each send we wait POWER_ON_RETRY_MS, then re-read status
  // — the TV needs a moment to come up after waking, and it only exposes its input-source map
  // once on. We return as soon as it reports `on`. If it never does we still return — the caller
  // logs and the input switch is attempted regardless.
  async function ensurePoweredOn(st: SmartThings, deviceId: string, status: TVStatus): Promise<TVStatus> {
    for (let attempt = 1; status.power !== "on" && attempt <= POWER_ON_ATTEMPTS; attempt++) {
      log(`TV is off — turning it on (attempt ${attempt}/${POWER_ON_ATTEMPTS})...`);
      await st.powerOn(deviceId);
      await sleep(POWER_ON_RETRY_MS);
      status = await st.getStatus(deviceId);
    }
    if (status.power === "on") log("TV is on.");
    else log(`TV still reports off after ${POWER_ON_ATTEMPTS} attempts — it may be unreachable by the cloud (deep standby).`);
    return status;
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

  // Switch the TV to the PC input, powering it on first if needed.
  async function switchInput(inputOverride?: string): Promise<void> {
    const { config, st, deviceId } = await connect(inputOverride);

    // 1) Check status first; if off, wake it before switching input. We re-read after waking
    // because the off-state status often doesn't include the input-source map.
    let status = await st.getStatus(deviceId);
    status = await ensurePoweredOn(st, deviceId, status);

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
    const target = pickInput(status, config.pcInput);
    if (isOnInput(status, target)) {
      log(`Input is already on ${target}.`);
    } else {
      log(`Switching input to ${target} (PC)...`);
      await st.setInputSource(deviceId, capability, target);
    }

    log("Done — TV is on and switched to PC.");
  }

  // Turn the TV off, but only when it's currently on the PC input.
  async function off(): Promise<void> {
    const { config, st, deviceId } = await connect();
    const status = await st.getStatus(deviceId);

    if (status.power === "off") {
      log("TV is already off.");
      return;
    }

    const pcSource = pickInput(status, config.pcInput);
    if (!isOnInput(status, pcSource)) {
      log(`TV input is "${status.currentInput ?? "?"}", not PC (${pcSource}) — leaving it on.`);
      return;
    }

    log("PC is sleeping and TV is on PC input — turning the TV off...");
    await st.powerOff(deviceId);
    log("Done — TV turned off.");
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

  // `switch` is a JS reserved word, so the internal fn is `switchInput`, exposed as `switch`.
  return { login, switch: switchInput, off, listDevices };
}
