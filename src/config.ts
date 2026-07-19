import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearTokens,
  defaultConfig,
  mergeConfig,
  resolveStaticToken,
  type TVConfig,
} from "./domain/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default location: next to the project root so it survives across runs.
const DEFAULT_CONFIG_PATH = join(__dirname, "..", "smartthings-config.json");

// Resolved lazily so the Electron app can redirect it to a writable location (its userData /
// portable folder) before the first read — a packaged app's source dir lives in a read-only
// asar archive. SMARTTHINGS_CONFIG_PATH overrides the default when set.
function configPath(): string {
  return process.env.SMARTTHINGS_CONFIG_PATH?.trim() || DEFAULT_CONFIG_PATH;
}

// Back-compat export of the default path (no env override applied).
export const CONFIG_PATH = DEFAULT_CONFIG_PATH;

// Re-export the type from its new home so existing importers keep working.
export type { TVConfig } from "./domain/config.js";

export async function loadConfig(): Promise<TVConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TVConfig> & { secret?: string };
    return mergeConfig(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw err;
  }
}

export async function saveConfig(config: TVConfig): Promise<void> {
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// All config mutations go through here. Several writers run concurrently in the Electron app —
// the Settings autosave, the OAuth token refresh inside any TV action, and the pairing IPC — and
// each is a load→modify→save of the whole file, so unserialized they silently drop each other's
// changes (worst case: a token refresh persists its pre-edit copy, or an autosave clobbers a
// freshly rotated refresh token and every later refresh fails with invalid_grant). A single
// promise chain makes each read-modify-write atomic relative to the others.
let writeLock: Promise<unknown> = Promise.resolve();

export function updateConfig(
  // `| void` lets a mutate callback either return a new config or mutate in place and return
  // nothing; `| undefined` would reject void-returning callers, so this stays void deliberately.
  // biome-ignore lint/suspicious/noConfusingVoidType: intentional — see above.
  mutate: (config: TVConfig) => TVConfig | void,
): Promise<TVConfig> {
  const run = writeLock.then(async () => {
    const config = await loadConfig();
    const next = mutate(config) ?? config;
    await saveConfig(next);
    return next;
  });
  // Keep the chain usable after a failed write; the failure still rejects `run` for its caller.
  writeLock = run.catch(() => undefined);
  return run;
}

export async function resetConfig(): Promise<void> {
  try {
    await unlink(configPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// Sign out without forgetting the OAuth client: clear tokens but keep clientId/clientSecret/
// redirectUri (and all preferences), then rewrite the file. If no config file exists yet there
// is nothing signed in, so this is a no-op rather than writing a defaults-only file.
export async function signOut(): Promise<void> {
  try {
    await readFile(configPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  await updateConfig((config) => clearTokens(config));
}

// Token from the environment takes precedence over the config file.
export function resolveToken(config: TVConfig): string | undefined {
  return resolveStaticToken(config, process.env.SMARTTHINGS_TOKEN);
}
