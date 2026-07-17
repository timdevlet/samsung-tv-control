// CLI entry point: parse argv and dispatch to the app's handlers.
//   npm start            → switch the TV to PC (optionally --hdmi 1|2|3|4)
//   npm run off          → turn the TV off (this PC stays on)
//   npm run login        → one-time OAuth bootstrap
//   npm run devices      → list account devices
//   npm run reset        → clear smartthings-config.json

import { createApp } from "./app.js";
import { resetConfig } from "./config.js";
import { parseHdmiFlag } from "./domain/cli.js";
import { isMockMode, installMockCloud } from "./dev/mock-cloud.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  if (isMockMode()) {
    installMockCloud();
    log("⚠ MOCK MODE — SmartThings cloud is simulated; no real TV will be controlled.");
  }
  const app = createApp();
  const args = process.argv.slice(2);

  if (args.includes("--login")) return app.login();
  if (args.includes("--off")) {
    await app.off();
    return;
  }
  if (args.includes("--devices")) return app.listDevices();
  if (args.includes("--reset")) {
    await resetConfig();
    log("Cleared smartthings-config.json (token and OAuth credentials).");
    return;
  }
  await app.switch(parseHdmiFlag(args));
}

main().catch((err: unknown) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
