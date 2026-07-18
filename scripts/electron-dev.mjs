// Dev mode: bundle main/preload with esbuild, start the Vite dev server for the React renderer,
// then launch Electron pointed at it via VITE_DEV_SERVER_URL. Renderer edits hot-reload; main or
// preload changes need a restart. Quit any running tray instance first — the app holds a
// single-instance lock, so a second launch just focuses the existing window and exits.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Under plain Node the electron package's default export is the path to the Electron binary.
import electronBin from "electron";
import { createServer } from "vite";
import { buildMainPreloadAndIcons } from "./build-electron.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await buildMainPreloadAndIcons();

const server = await createServer({ configFile: path.join(root, "vite.renderer.config.ts") });
await server.listen();
server.printUrls();

const env = {
  ...process.env,
  VITE_DEV_SERVER_URL: server.resolvedUrls?.local[0] ?? "",
  // Dev serves without a CSP meta (the react-refresh preamble needs inline scripts) — silence
  // Electron's warning about that; the production build injects a strict CSP.
  ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
};
// `npm run electron:dev:mock` → fake the SmartThings cloud (src/dev/mock-cloud.ts): no
// credentials or real TV needed.
if (process.argv.includes("--mock")) env.SMARTTHINGS_MOCK = "1";
// If inherited (some editor/agent terminals set it), Electron would run main.cjs under plain
// Node — no `app`, immediate crash. Always launch as a real Electron app.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, ["."], { cwd: root, stdio: "inherit", env });
child.on("close", (code) => {
  void server.close().finally(() => process.exit(code ?? 0));
});
