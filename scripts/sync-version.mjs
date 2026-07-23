// Sync package.json's (and package-lock.json's) version FROM the released git tag, making the
// tag the source of truth. Run before packaging (see the `dist*` scripts) so the app and its
// artifacts always carry the version you released by tagging. Pure Node — no toolchain beyond git.
//
// Tag resolution order:
//   1. In GitHub Actions tag builds, GITHUB_REF points at the tag — use it directly, because
//      actions/checkout doesn't fetch tags and `git describe` would come up empty.
//   2. Locally, describe the latest semver tag. The repo also carries non-semver tags (e.g.
//      `latest`), so we match only `v<num>...` / `<num>...` tags.
// Both `v0.0.2` and bare `0.0.2` tag styles are accepted; a leading `v` is stripped.

import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tagFromEnv() {
  const ref = process.env.GITHUB_REF ?? "";
  if (!ref.startsWith("refs/tags/")) return undefined;
  const name = ref.slice("refs/tags/".length);
  return /^v?\d+\.\d+\.\d+/.test(name) ? name : undefined;
}

function tagFromGit() {
  try {
    return execSync('git describe --tags --abbrev=0 --match "v[0-9]*" --match "[0-9]*"', {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

const tag = tagFromEnv() ?? tagFromGit();
if (!tag) {
  console.warn("sync-version: no semver git tag found — leaving package.json unchanged.");
  process.exit(0);
}

const version = tag.replace(/^v/, "");

async function syncFile(file, apply) {
  const filePath = path.join(root, file);
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return; // package-lock.json may legitimately be absent
  }
  const json = JSON.parse(text);
  const old = json.version;
  apply(json);
  const updated = `${JSON.stringify(json, null, 2)}\n`;
  if (updated === text) {
    console.log(`sync-version: ${file} already at ${version} (tag ${tag}).`);
    return;
  }
  await writeFile(filePath, updated);
  console.log(`sync-version: ${file} ${old} -> ${version} (from tag ${tag}).`);
}

await syncFile("package.json", (pkg) => {
  pkg.version = version;
});

await syncFile("package-lock.json", (lock) => {
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
});
