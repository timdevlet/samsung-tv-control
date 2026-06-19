import { fileURLToPath } from "node:url";
import { resolveToken, type TVConfig } from "./config.js";
import { hasOAuthClient, getAccessToken, authorizeUrl, exchangeCode, DEFAULT_REDIRECT_URI } from "./oauth.js";
import { pickInput, isOnInput, parseHdmiFlag } from "./domain.js";
import { buildDeps, type Deps, type TVApi } from "./interfaces.js";

/**
 * Resolve a usable access token. Precedence:
 *   1. SMARTTHINGS_TOKEN env var (explicit manual override, handy for testing)
 *   2. OAuth auto-refresh, if a client is configured and authorized
 *   3. Legacy static PAT in smartthings-config.json
 */
export async function resolveAccessToken(config: TVConfig, deps: Deps): Promise<string> {
  const envPat = process.env.SMARTTHINGS_TOKEN?.trim();
  if (envPat) return envPat;

  if (hasOAuthClient(config) && config.refreshToken) {
    return getAccessToken(config, deps); // refreshes + persists the rotated token as needed
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
async function login(deps: Deps): Promise<void> {
  const log = (m: string) => deps.logger.info(m);
  const config = await deps.config.load();
  if (!hasOAuthClient(config)) {
    throw new Error('Add your OAuth "clientId" and "clientSecret" to smartthings-config.json first.');
  }

  log("\n1) Open this URL in your browser (logged into your Samsung account) and approve:\n");
  log("   " + authorizeUrl(config) + "\n");
  log(`2) You'll be redirected to ${config.redirectUri ?? DEFAULT_REDIRECT_URI} with ?code=... in the URL.`);
  log("   Copy the value of the `code` query parameter and paste it below.\n");

  const code = await deps.prompter.question("Paste code: ");
  if (!code) throw new Error("No code entered.");

  await exchangeCode(config, code, deps);
  log("\n✅ Authorized. Tokens saved to smartthings-config.json — they now refresh automatically.");
  log("   Run `npm start` to wake the TV and switch to PC.\n");
}

/** Resolve the TV's device id, discovering and caching it on first run. */
async function resolveDevice(st: TVApi, config: TVConfig, deps: Deps): Promise<string> {
  const log = (m: string) => deps.logger.info(m);
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
  await deps.config.save(config);
  log(`Found "${tv.label}".`);
  return tv.deviceId;
}

export async function run(inputOverride?: string, deps?: Deps): Promise<void> {
  const d = deps ?? (await buildDeps());
  const log = (m: string) => d.logger.info(m);
  const config = await d.config.load();
  if (inputOverride) config.pcInput = inputOverride;
  const st = d.tvApi(await resolveAccessToken(config, d));
  const deviceId = await resolveDevice(st, config, d);

  // 1) Always power on — no state check (SmartThings wakes the TV from standby over the cloud).
  log("Turning the TV on...");
  await st.powerOn(deviceId);

  // 2) Always switch the input to the PC — no "already on it" check. We still read status once
  // to resolve the TV's input-capability id and map config.pcInput to a real source id.
  const status = await st.getStatus(deviceId);
  const capability = status.inputCapability;
  if (!capability) {
    throw new Error(
      "This device doesn't expose an input-source capability via SmartThings, so the source can't be changed.",
    );
  }
  const target = pickInput(status, config.pcInput);
  log(`Switching input to ${target} (PC)...`);
  await st.setInputSource(deviceId, capability, target);

  log("Done — TV is on and switched to PC.");
}

/** Turn the TV off, but only when it's currently on the PC input. */
export async function turnOff(deps?: Deps): Promise<void> {
  const d = deps ?? (await buildDeps());
  const log = (m: string) => d.logger.info(m);
  const config = await d.config.load();
  const st = d.tvApi(await resolveAccessToken(config, d));
  const deviceId = await resolveDevice(st, config, d);
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

/** `--devices`: list account devices with their main capabilities. */
async function listDevices(deps: Deps): Promise<void> {
  const log = (m: string) => deps.logger.info(m);
  const config = await deps.config.load();
  const st = deps.tvApi(await resolveAccessToken(config, deps));
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const deps = await buildDeps();

  if (args.includes("--login")) {
    await login(deps);
    return;
  }
  if (args.includes("--reset")) {
    await deps.config.reset();
    deps.logger.info("Cleared smartthings-config.json (cached device id and token).");
    return;
  }
  if (args.includes("--devices")) {
    await listDevices(deps);
    return;
  }
  await run(parseHdmiFlag(args), deps);
}

// Only run the CLI when this file is the entry point — not when imported (e.g. by the daemon).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
