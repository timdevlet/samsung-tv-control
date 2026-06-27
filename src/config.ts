import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mergeConfig, defaultConfig, resolveStaticToken, type TVConfig } from "./domain/config.js";

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
  await writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
}

export async function resetConfig(): Promise<void> {
  try {
    await unlink(configPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// Token from the environment takes precedence over the config file.
export function resolveToken(config: TVConfig): string | undefined {
  return resolveStaticToken(config, process.env.SMARTTHINGS_TOKEN);
}
