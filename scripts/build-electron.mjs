// Build the Electron app: generate icons, bundle the main + preload processes with esbuild, and
// copy the renderer into dist-electron/. Run via `npm run electron:build`. Pure Node + esbuild,
// so it works the same on macOS/Windows/Linux with no extra toolchain.
//
// Why a bundle: the source is ESM TypeScript run by tsx everywhere else, but Electron's main
// process loads a CommonJS file (.cjs) and the packaged app can't run tsx. esbuild compiles the
// whole import graph (app/daemon/domain/os) into two self-contained .cjs files. `electron` itself
// stays external (provided by the runtime, not inlined).

import esbuild from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drawAppIcon, drawTraySilhouette } from "./tv-icon.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist-electron");
const buildDir = path.join(root, "build");

// --- esbuild: rewrite NodeNext ".js" specifiers to their ".ts" source -----------------------
// The TS sources import sibling modules with a ".js" extension (required by NodeNext). esbuild
// resolves paths literally, so without this it would look for nonexistent .js files. Map them
// back to the .ts that actually exists.
const tsResolve = {
  name: "ts-resolve",
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === "entry-point" || !args.path.startsWith(".")) return;
      const tsPath = path.resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      if (existsSync(tsPath)) return { path: tsPath };
      return; // leave genuine .js imports to esbuild's default resolution
    });
  },
};

async function bundle(entry, outfile, { extraExternal = [], injectImportMeta = true } = {}) {
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(out, outfile),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    sourcemap: true,
    // electron is provided by the runtime and must remain require()d, not bundled.
    external: ["electron", ...extraExternal],
    plugins: [tsResolve],
    // The main/daemon sources compute __dirname from import.meta.url (valid ESM under tsx). In a
    // CJS bundle import.meta is empty, so map it to a real file URL derived from __filename. This
    // banner must NOT go into the preload bundle: preload runs in Electron's sandbox where Node
    // globals like __filename are undefined, so the banner would throw "__filename is not defined"
    // and the whole preload (and thus window.tvAPI) would fail to load.
    ...(injectImportMeta
      ? {
          banner: { js: "const import_meta_url = require('url').pathToFileURL(__filename).href;" },
          define: { "import.meta.url": "import_meta_url" },
        }
      : {}),
    logLevel: "info",
  });
}

// --- minimal PNG / ICO encoders (no image deps) ---------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines: one filter byte (0) per row
  const stride = size * 4;
  const raw = Buffer.alloc(size * (1 + stride));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + stride)] = 0;
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Wrap a PNG blob in a single-image .ico (Windows accepts PNG-compressed icons).
function encodeICO(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width  (0 means 256)
  entry[1] = size >= 256 ? 0 : size; // height
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);
  return Buffer.concat([header, entry, png]);
}

// --- area-average downscaler (no image deps) --------------------------------------------------
// Downscale an RGBA buffer with box (area-average) sampling — best quality for shrinking a large
// source to small icon sizes. Color is averaged premultiplied by alpha so transparent pixels
// don't bleed their (arbitrary) color into the result.
function resizeRGBA(src, sw, sh, size) {
  const dst = Buffer.alloc(size * size * 4);
  for (let dy = 0; dy < size; dy++) {
    const sy0 = Math.floor((dy * sh) / size);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * sh) / size));
    for (let dx = 0; dx < size; dx++) {
      const sx0 = Math.floor((dx * sw) / size);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * sw) / size));
      let r = 0, g = 0, b = 0, aSum = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * sw + sx) * 4;
          const af = src[i + 3];
          r += src[i] * af;
          g += src[i + 1] * af;
          b += src[i + 2] * af;
          aSum += af;
          n++;
        }
      }
      const di = (dy * size + dx) * 4;
      if (aSum > 0) {
        dst[di] = Math.round(r / aSum);
        dst[di + 1] = Math.round(g / aSum);
        dst[di + 2] = Math.round(b / aSum);
        dst[di + 3] = Math.round(aSum / n);
      }
    }
  }
  return dst;
}

async function generateIcons() {
  await mkdir(buildDir, { recursive: true });
  await mkdir(out, { recursive: true });

  // All icon artwork is drawn procedurally (see scripts/tv-icon.mjs): hard-edged shapes at a
  // large master size, downscaled here with the box filter so the edges come out anti-aliased.
  const APP_MASTER = 2048; // 4x/8x supersample for the 512/256 outputs
  const appSrc = drawAppIcon(APP_MASTER);
  const appIcon = (size) => encodePNG(size, resizeRGBA(appSrc, APP_MASTER, APP_MASTER, size));

  // One tray master serves every size: 480 divides evenly into 16/24/32/48, so the box filter
  // sees a uniform footprint at each scale.
  const TRAY_MASTER = 480;
  const trayBlack = drawTraySilhouette(TRAY_MASTER, [0, 0, 0, 255]);
  const trayWhite = drawTraySilhouette(TRAY_MASTER, [255, 255, 255, 255]);
  const tray = (src, size) => encodePNG(size, resizeRGBA(src, TRAY_MASTER, TRAY_MASTER, size));

  await writeFile(path.join(buildDir, "icon.png"), appIcon(512)); // electron-builder mac/linux (requires >= 512)
  await writeFile(path.join(buildDir, "icon.ico"), encodeICO(appIcon(256), 256)); // electron-builder win (256 max)
  await writeFile(path.join(out, "icon.png"), appIcon(256)); // BrowserWindow icon
  // macOS tray template (tray.png/@2x): black silhouette the OS recolors to match the menu bar.
  // 16pt base + 32px @2x retina; Electron auto-loads the @2x file by name.
  await writeFile(path.join(out, "tray.png"), tray(trayBlack, 16));
  await writeFile(path.join(out, "tray@2x.png"), tray(trayBlack, 32));
  // Windows tray variants: white silhouette at 16/24/32/48px covering 100/150/200/300% display
  // scaling. Electron auto-loads @2x/@3x by name, while main.ts attaches the 1.5x rep.
  await writeFile(path.join(out, "tray-white.png"), tray(trayWhite, 16));
  await writeFile(path.join(out, "tray-white@1.5x.png"), tray(trayWhite, 24));
  await writeFile(path.join(out, "tray-white@2x.png"), tray(trayWhite, 32));
  await writeFile(path.join(out, "tray-white@3x.png"), tray(trayWhite, 48));
}

// --- run -------------------------------------------------------------------------------------
// Exported so scripts/electron-dev.mjs can build main/preload/icons while serving the renderer
// from the Vite dev server instead of a production build.
export async function buildMainPreloadAndIcons() {
  await generateIcons();
  await bundle("src/electron/main.ts", "main.cjs");
  // Preload runs sandboxed — no __filename — so skip the import.meta.url banner. It only uses
  // electron's contextBridge/ipcRenderer and never references import.meta.url.
  await bundle("src/electron/preload.ts", "preload.cjs", { injectImportMeta: false });
}

// Full build when run directly (`npm run electron:build`): main + preload + icons, then the
// React renderer bundled by Vite into dist-electron/renderer/ — same output path the old build
// copied the static HTML to. The vite import stays lazy so importing this module doesn't pay
// for it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildMainPreloadAndIcons();
  const { build: viteBuild } = await import("vite");
  await viteBuild({ configFile: path.join(root, "vite.renderer.config.ts") });
  console.log("Electron build complete → dist-electron/");
}
