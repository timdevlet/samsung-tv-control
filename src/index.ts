import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, resetConfig, resolveToken, type TVConfig } from "./config.js";
import { SmartThings, type TVStatus } from "./smartthings.js";
import {
  hasOAuthClient,
  getAccessToken,
  authorizeUrl,
  exchangeCode,
  DEFAULT_REDIRECT_URI,
} from "./oauth.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(msg);

/**
 * Resolve a usable access token. Precedence:
 *   1. SMARTTHINGS_TOKEN env var (explicit manual override, handy for testing)
 *   2. OAuth auto-refresh, if a client is configured and authorized
 *   3. Legacy static PAT in smartthings-config.json
 */
export async function resolveAccessToken(config: TVConfig): Promise<string> {
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

/** One-time OAuth bootstrap: approve in the browser, paste the code, save tokens. */
async function login(): Promise<void> {
  const config = await loadConfig();
  if (!hasOAuthClient(config)) {
    throw new Error(
      'Add your OAuth "clientId" and "clientSecret" to smartthings-config.json first.',
    );
  }

  log("\n1) Open this URL in your browser (logged into your Samsung account) and approve:\n");
  log("   " + authorizeUrl(config) + "\n");
  log(`2) You'll be redirected to ${config.redirectUri ?? DEFAULT_REDIRECT_URI} with ?code=... in the URL.`);
  log("   Copy the value of the `code` query parameter and paste it below.\n");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const code = (await rl.question("Paste code: ")).trim();
  rl.close();
  if (!code) throw new Error("No code entered.");

  await exchangeCode(config, code);
  log("\n✅ Authorized. Tokens saved to smartthings-config.json — they now refresh automatically.");
  log("   Run `npm start` to wake the TV and switch to PC.\n");
}

/** Resolve the TV's device id, discovering and caching it on first run. */
async function resolveDevice(st: SmartThings, config: TVConfig): Promise<string> {
  if (config.deviceId) {
    log(`Using cached TV "${config.deviceLabel ?? config.deviceId}".`);
    return config.deviceId;
  }
  log("Finding the TV in your SmartThings account...");
  const tv = await st.findTV();
  if (!tv) {
    throw new Error(
      "No TV found in SmartThings. Add it in the SmartThings app first, then run `npm run devices` to inspect.",
    );
  }
  config.deviceId = tv.deviceId;
  config.deviceLabel = tv.label;
  await saveConfig(config);
  log(`Found "${tv.label}".`);
  return tv.deviceId;
}

/** Pick the source id to switch to: match config.pcInput by id, then by label. */
function pickInput(status: TVStatus, pcInput: string): string {
  const want = pcInput.toLowerCase();
  const byId = status.sources.find((s) => s.id.toLowerCase() === want);
  if (byId) return byId.id;
  const byName = status.sources.find((s) => s.name.toLowerCase() === want);
  if (byName) return byName.id;
  // Nothing matched the configured value — fall back to the raw value and let the TV try.
  return pcInput;
}

/** Parse `--hdmi <n>`, `--hdmi=n`, or `--hdmiN` (n = 1..4) into "HDMI<n>". */
function parseHdmiFlag(args: string[]): string | undefined {
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

export async function run(inputOverride?: string): Promise<void> {
  const config = await loadConfig();
  if (inputOverride) config.pcInput = inputOverride;
  const st = new SmartThings(await resolveAccessToken(config));
  const deviceId = await resolveDevice(st, config);

  let status = await st.getStatus(deviceId);

  // 1) Power on if needed (SmartThings wakes the TV from standby over the cloud).
  if (status.power === "on") {
    log("TV is already on.");
  } else {
    log("Turning the TV on...");
    await st.powerOn(deviceId);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && status.power !== "on") {
      await sleep(2000);
      status = await st.getStatus(deviceId);
    }
    log(status.power === "on" ? "TV is on." : "Sent power-on (TV not yet reporting 'on').");
  }

  // 2) Switch the input to the PC.
  const capability = status.inputCapability;
  if (!capability) {
    throw new Error(
      "This device doesn't expose an input-source capability via SmartThings, so the source can't be changed.",
    );
  }
  const target = pickInput(status, config.pcInput);
  if (status.currentInput && status.currentInput.toLowerCase() === target.toLowerCase()) {
    log(`Input is already on ${target}.`);
  } else {
    log(`Switching input to ${target} (PC)...`);
    await st.setInputSource(deviceId, capability, target);
  }

  log("Done — TV is on and switched to PC.");
}

/** Turn the TV off, but only when it's currently on the PC input. */
export async function turnOff(): Promise<void> {
  const config = await loadConfig();
  const st = new SmartThings(await resolveAccessToken(config));
  const deviceId = await resolveDevice(st, config);
  const status = await st.getStatus(deviceId);

  if (status.power === "off") {
    log("TV is already off.");
    return;
  }

  const pcSource = pickInput(status, config.pcInput);
  const onPc =
    status.currentInput && status.currentInput.toLowerCase() === pcSource.toLowerCase();
  if (!onPc) {
    log(`TV input is "${status.currentInput ?? "?"}", not PC (${pcSource}) — leaving it on.`);
    return;
  }

  log("PC is sleeping and TV is on PC input — turning the TV off...");
  await st.powerOff(deviceId);
  log("Done — TV turned off.");
}

/** `--devices`: list account devices with their main capabilities. */
async function listDevices(): Promise<void> {
  const config = await loadConfig();
  const st = new SmartThings(await resolveAccessToken(config));
  const devices = await st.listDevices();
  if (devices.length === 0) {
    log("No devices found on this SmartThings account.");
    return;
  }
  for (const d of devices) {
    log(`• ${d.label}  [${d.deviceId}]`);
    log(`    capabilities: ${d.capabilities.join(", ") || "(none)"}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--login")) {
    await login();
    return;
  }
  if (args.includes("--reset")) {
    await resetConfig();
    log("Cleared smartthings-config.json (cached device id and token).");
    return;
  }
  if (args.includes("--devices")) {
    await listDevices();
    return;
  }
  await run(parseHdmiFlag(args));
}

// Only run the CLI when this file is the entry point — not when imported (e.g. by the daemon).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
