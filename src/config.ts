import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mergeConfig, defaultConfig, resolveStaticToken, type TVConfig } from "./domain/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Persisted next to the project root so it survives across runs.
export const CONFIG_PATH = join(__dirname, "..", "smartthings-config.json");

// Re-export the type from its new home so existing importers keep working.
export type { TVConfig } from "./domain/config.js";

export async function loadConfig(): Promise<TVConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<TVConfig> & { secret?: string };
    return mergeConfig(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw err;
  }
}

export async function saveConfig(config: TVConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export async function resetConfig(): Promise<void> {
  try {
    await unlink(CONFIG_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// Token from the environment takes precedence over the config file.
export function resolveToken(config: TVConfig): string | undefined {
  return resolveStaticToken(config, process.env.SMARTTHINGS_TOKEN);
}
