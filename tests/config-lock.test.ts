import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// updateConfig against a real temp file: concurrent read-modify-writes must serialize so no
// writer's fields are lost — the exact race between the Settings autosave and an OAuth token
// refresh (both rewrite the whole config file).

import { updateConfig, loadConfig } from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tvconfig-"));
  process.env.SMARTTHINGS_CONFIG_PATH = join(dir, "smartthings-config.json");
});

afterEach(() => {
  delete process.env.SMARTTHINGS_CONFIG_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("updateConfig", () => {
  it("persists a mutation and returns the saved config", async () => {
    const saved = await updateConfig((config) => {
      config.pcInput = "HDMI3";
    });
    expect(saved.pcInput).toBe("HDMI3");
    expect((await loadConfig()).pcInput).toBe("HDMI3");
  });

  it("serializes concurrent writers so neither mutation is lost", async () => {
    // Unserialized, both would load the same base config and the last save would drop the other
    // writer's field (accessToken clobbers pcInput or vice versa).
    await Promise.all([
      updateConfig((config) => {
        config.pcInput = "HDMI4";
      }),
      updateConfig((config) => {
        config.accessToken = "tok-123";
      }),
    ]);
    const config = await loadConfig();
    expect(config.pcInput).toBe("HDMI4");
    expect(config.accessToken).toBe("tok-123");
  });

  it("keeps working after a writer throws", async () => {
    await expect(
      updateConfig(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const saved = await updateConfig((config) => {
      config.pcInput = "HDMI2";
    });
    expect(saved.pcInput).toBe("HDMI2");
  });

  it("drops the retired transportMode key from old configs", async () => {
    await updateConfig((config) => {
      config.pcInput = "HDMI2";
    });
    // Simulate an old config file carrying the retired key.
    const path = process.env.SMARTTHINGS_CONFIG_PATH!;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ pcInput: "HDMI2", transportMode: "cloud" }), "utf8");
    await updateConfig((config) => {
      config.theme = "dark";
    });
    expect(readFileSync(path, "utf8")).not.toContain("transportMode");
  });
});
