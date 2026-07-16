// Sync package.json's version FROM the latest semver git tag, making the tag the source of truth.
// Run before packaging (see the `dist*` scripts) so the app and its artifacts always carry the
// version you released by tagging. Pure Node — no toolchain beyond git.
//
// The repo also carries non-semver tags (e.g. `latest`), so we match only `v<num>...` tags and
// strip the leading `v` (v0.0.1 -> 0.0.1). If there's no matching tag we leave package.json alone.

import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");

let tag;
try {
  tag = execSync('git describe --tags --abbrev=0 --match "v[0-9]*"', {
    cwd: root,
    encoding: "utf8",
  }).trim();
} catch {
  console.warn("sync-version: no matching v* git tag found — leaving package.json unchanged.");
  process.exit(0);
}

const version = tag.replace(/^v/, "");
const text = await readFile(pkgPath, "utf8");
const pkg = JSON.parse(text);

if (pkg.version === version) {
  console.log(`sync-version: already at ${version} (tag ${tag}).`);
  process.exit(0);
}

const old = pkg.version;
pkg.version = version;
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`sync-version: ${old} -> ${version} (from tag ${tag}).`);
