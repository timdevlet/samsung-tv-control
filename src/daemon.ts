// Long-running daemon: listens for global hotkeys and acts on the TV. Run with: npm run daemon
//
// This is the headless (terminal) entry point. It starts the shared daemon core and keeps the
// process alive until Ctrl+C. The Electron app (src/electron/main.ts) drives the same core.
//
// Hotkeys:
//   Wake TV + switch to PC      macOS -> Cmd+Ctrl+E    Win/Linux -> Ctrl+Alt+E
//   Turn TV off + sleep this PC macOS -> Cmd+Ctrl+Q    Win/Linux -> Ctrl+Alt+Q

import { startDaemon } from "./daemon-core.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  const daemon = await startDaemon();
  log("Press Ctrl+C to quit.");

  const shutdown = () => {
    daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive indefinitely.
  process.stdin.resume();
}

main().catch((err: unknown) => {
  console.error(`\nDaemon error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
