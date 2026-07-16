import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TVConfig } from "../src/domain/config.js";

// Drive createApp() against a mocked config to prove the transport seam: in "local" mode the app
// builds a LAN transport and never touches the OAuth/token path (no SMARTTHINGS_TOKEN, no cloud
// credentials — a cloud build would throw "No SmartThings credentials"). listTVs is config-driven
// there, so it resolves without any network or token work.

let store: TVConfig;

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...actual,
    loadConfig: async () => ({ ...store }),
    saveConfig: async (config: TVConfig) => {
      store = config;
    },
  };
});

import { createApp } from "../src/app.js";

beforeEach(() => {
  // No token in the environment — the cloud path would fail; the local path must not need one.
  delete process.env.SMARTTHINGS_TOKEN;
  delete process.env.SMARTTHINGS_MOCK;
});

afterEach(() => vi.unstubAllGlobals());

describe("local transport selection", () => {
  it("lists LAN TVs from config without resolving any cloud token", async () => {
    store = {
      pcInput: "HDMI2",
      transportMode: "local",
      deviceConfigs: { "local:tv": { host: "1.2.3.4", mac: "a0:b1:c2:d3:e4:f5", alias: "Living Room" } },
    };
    // A spy on fetch proves no cloud/token HTTP happens for the config-driven list.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const tvs = await createApp().listTVs();
    expect(tvs.map((t) => t.deviceId)).toEqual(["local:tv"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cloud mode with no credentials still throws (guards the test above is meaningful)", async () => {
    store = { pcInput: "HDMI2", transportMode: "cloud" };
    await expect(createApp().listTVs()).rejects.toThrow(/credentials/i);
  });
});
