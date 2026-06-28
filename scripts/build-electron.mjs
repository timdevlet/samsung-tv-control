// Build the Electron app: generate icons, bundle the main + preload processes with esbuild, and
// copy the renderer into dist-electron/. Run via `npm run electron:build`. Pure Node + esbuild,
// so it works the same on macOS/Windows/Linux with no extra toolchain.
//
// Why a bundle: the source is ESM TypeScript run by tsx everywhere else, but Electron's main
// process loads a CommonJS file (.cjs) and the packaged app can't run tsx. esbuild compiles the
// whole import graph (app/daemon/domain/os) into two self-contained .cjs files. The native addon
// `uiohook-napi` and `electron` itself stay external (required at runtime, not inlined).

import esbuild from "esbuild";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    // electron is provided by the runtime; uiohook-napi is a native .node addon that can't be
    // bundled — both must remain require()d at runtime.
    external: ["electron", "uiohook-napi", ...extraExternal],
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

// --- minimal PNG decoder + area-average downscaler (no image deps) ---------------------------
// Decode an 8-bit, non-interlaced PNG (color types 0/2/3/4/6) to a flat RGBA buffer. Enough to
// read the hand-authored source icon; not a general-purpose decoder.
function decodePNG(buf) {
  let pos = 8; // skip the 8-byte signature
  let width, height, bitDepth, colorType, interlace;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len; // 4 len + 4 type + len data + 4 crc
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth: ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG not supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG color type: ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, y * stride + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0; // byte to the left
      const b = prev[i]; // byte above
      const c = i >= channels ? prev[i - channels] : 0; // byte above-left
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG filter: ${filter}`);
      cur[i] = v & 0xff;
    }
    prev = cur;
  }

  // expand whatever color type we got into straight RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    let r, g, b, a = 255;
    if (colorType === 2) [r, g, b] = [out[p * 3], out[p * 3 + 1], out[p * 3 + 2]];
    else if (colorType === 6)
      [r, g, b, a] = [out[p * 4], out[p * 4 + 1], out[p * 4 + 2], out[p * 4 + 3]];
    else if (colorType === 0) r = g = b = out[p];
    else if (colorType === 4) [r, g, b, a] = [out[p * 2], out[p * 2], out[p * 2], out[p * 2 + 1]];
    else {
      const idx = out[p]; // palette index
      [r, g, b] = [palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2]];
      if (trns && idx < trns.length) a = trns[idx];
    }
    rgba.set([r, g, b, a], p * 4);
  }
  return { width, height, rgba };
}

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

// Draw a gray gamepad on a transparent background (used for the tray icon): a horizontal pill
// body with a D-pad on the left and a diamond of four buttons on the right, in a darker gray.
function drawGamepad(size) {
  const px = Buffer.alloc(size * size * 4); // transparent
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };
  const s = (f) => f * size;
  const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || y < y0 || x > x1 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

  const BODY = [156, 163, 175]; // gray
  const DETAIL = [55, 65, 81]; // darker gray for the controls
  const rB = s(0.05); // button radius

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // controller body: a horizontal pill
      if (inRoundRect(x, y, s(0.08), s(0.32), s(0.92), s(0.68), s(0.18))) set(x, y, ...BODY);
      // D-pad (left): a plus made of two crossing bars
      const vBar = x >= s(0.22) && x <= s(0.30) && y >= s(0.4) && y <= s(0.6);
      const hBar = x >= s(0.16) && x <= s(0.36) && y >= s(0.46) && y <= s(0.54);
      if (vBar || hBar) set(x, y, ...DETAIL);
      // buttons (right): a diamond of four dots around (0.72, 0.50)
      if (
        inCircle(x, y, s(0.72), s(0.42), rB) ||
        inCircle(x, y, s(0.72), s(0.58), rB) ||
        inCircle(x, y, s(0.64), s(0.5), rB) ||
        inCircle(x, y, s(0.8), s(0.5), rB)
      )
        set(x, y, ...DETAIL);
    }
  }
  return px;
}

async function generateIcons() {
  await mkdir(buildDir, { recursive: true });
  await mkdir(out, { recursive: true });

  // App icon: resample the hand-authored source image down to each required size.
  const src = decodePNG(await readFile(path.join(buildDir, "icon-source.png")));
  const appIcon = (size) => encodePNG(size, resizeRGBA(src.rgba, src.width, src.height, size));

  const png512 = appIcon(512); // electron-builder requires mac/linux icon >= 512x512
  const png256 = appIcon(256);
  const tray32 = encodePNG(32, drawGamepad(32)); // gray gamepad for the tray

  await writeFile(path.join(buildDir, "icon.png"), png512); // electron-builder mac/linux
  await writeFile(path.join(buildDir, "icon.ico"), encodeICO(png256, 256)); // electron-builder win (256 max)
  await writeFile(path.join(out, "icon.png"), png256); // BrowserWindow icon
  await writeFile(path.join(out, "tray.png"), tray32); // tray icon
}

// --- run -------------------------------------------------------------------------------------
await generateIcons();
await bundle("src/electron/main.ts", "main.cjs");
// Preload runs sandboxed — no __filename — so skip the import.meta.url banner. It only uses
// electron's contextBridge/ipcRenderer and never references import.meta.url.
await bundle("src/electron/preload.ts", "preload.cjs", { injectImportMeta: false });
await mkdir(path.join(out, "renderer"), { recursive: true });
await copyFile(
  path.join(root, "src/electron/renderer/index.html"),
  path.join(out, "renderer/index.html"),
);

console.log("Electron build complete → dist-electron/");
