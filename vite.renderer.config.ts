// Vite config for the React renderer. Deliberately NOT named vite.config.ts: vitest auto-loads
// a root vite.config.ts, and this config's `root`/plugins would break `npm test`. The build and
// dev scripts pass this file explicitly via `configFile`.

import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

// Production CSP for the file://-loaded build ('self' matches file: URLs in Electron). Injected
// at build time only: the dev server needs inline scripts (react-refresh preamble) and injected
// <style> tags, which this policy would block. style-src keeps 'unsafe-inline' for React inline
// style props (e.g. the log line's marginTop separator).
const PROD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

export default defineConfig({
  root: path.join(root, "src/electron/renderer"),
  // Assets must resolve relative to index.html — the packaged app loads it over file://.
  base: "./",
  plugins: [
    react(),
    {
      name: "inject-csp",
      apply: "build",
      transformIndexHtml: () => [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: PROD_CSP },
          injectTo: "head-prepend",
        },
      ],
    },
  ],
  build: {
    // Same place the old build copied the static HTML to, so main.ts's loadFile path and the
    // electron-builder "files" globs stay unchanged.
    outDir: path.join(root, "dist-electron/renderer"),
    emptyOutDir: true, // outDir is outside the Vite root; opt in explicitly
    target: "chrome148", // Electron 42 embeds Chrome 148
    modulePreload: { polyfill: false }, // native in Chrome 148
  },
});
