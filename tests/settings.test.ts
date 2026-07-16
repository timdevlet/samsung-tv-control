import { describe, it, expect, beforeEach, vi } from "vitest";

// getSettings/saveSettings against an in-memory config — no disk, no Electron. Focused on the
// per-device config map semantics: whole-map replace, clearing-prunes, malformed payloads.

import type { TVConfig } from "../src/domain/config.js";

let store: TVConfig;

vi.mock("../src/config.js", () => ({
  loadConfig: async () => ({ ...store }),
  // Mirrors the real updateConfig: load → mutate → save, minus the write lock (tests are serial).
  updateConfig: async (mutate: (config: TVConfig) => TVConfig | void) => {
    const config = { ...store };
    store = mutate(config) ?? config;
    return store;
  },
}));

import { getSettings, saveSettings } from "../src/electron/settings.js";
import { defaultHotkeys } from "../src/domain/daemon.js";

const HOTKEY_DEFAULTS = defaultHotkeys(process.platform === "darwin" ? "mac" : "other");

beforeEach(() => {
  store = { pcInput: "HDMI2" };
});

describe("global hotkeys in getSettings", () => {
  it("shows the platform default combo when a hotkey was never configured", async () => {
    const settings = await getSettings();
    expect(settings.wakeHotkey).toBe(HOTKEY_DEFAULTS.wake);
    expect(settings.offHotkey).toBe(HOTKEY_DEFAULTS.off);
  });

  it("shows a configured combo as-is", async () => {
    store.wakeHotkey = "Command+Shift+P";
    const settings = await getSettings();
    expect(settings.wakeHotkey).toBe("Command+Shift+P");
    expect(settings.offHotkey).toBe(HOTKEY_DEFAULTS.off);
  });

  it("stays empty for an explicitly cleared hotkey (command disabled, no default fallback)", async () => {
    store.wakeHotkey = "";
    store.offHotkey = "  ";
    const settings = await getSettings();
    expect(settings.wakeHotkey).toBe("");
    expect(settings.offHotkey).toBe("");
  });
});

describe("deviceConfigs in getSettings", () => {
  it("fills missing fields with empty strings and prunes empty entries", async () => {
    store.deviceConfigs = { tv1: { wakeHotkey: "Command+Control+1", alias: "65 TV" }, tv2: {} };
    const settings = await getSettings();
    expect(settings.deviceConfigs).toEqual({
      tv1: {
        alias: "65 TV",
        description: "",
        pcInput: "",
        wakeHotkey: "Command+Control+1",
        offHotkey: "",
        host: "",
        mac: "",
        inputKeySeq: "",
        paired: false,
      },
    });
  });
});

describe("deviceConfigs in saveSettings", () => {
  it("replaces the whole map when one is supplied", async () => {
    store.deviceConfigs = { tv1: { wakeHotkey: "Command+Control+1" } };
    await saveSettings({
      deviceConfigs: {
        tv2: {
          alias: "65 TV",
          description: "living room tv",
          pcInput: "HDMI3",
          wakeHotkey: "Command+Control+2",
          offHotkey: "",
        },
      },
    });
    expect(store.deviceConfigs).toEqual({
      tv2: {
        alias: "65 TV",
        description: "living room tv",
        pcInput: "HDMI3",
        wakeHotkey: "Command+Control+2",
      },
    });
  });

  it("removes an entry when all of its fields are cleared", async () => {
    store.deviceConfigs = { tv1: { wakeHotkey: "Command+Control+1", alias: "65 TV" } };
    await saveSettings({
      deviceConfigs: {
        tv1: { alias: "", description: "", pcInput: "", wakeHotkey: "", offHotkey: "" },
      },
    });
    expect(store.deviceConfigs).toEqual({});
  });

  it("leaves the stored map untouched when deviceConfigs is absent or not an object", async () => {
    store.deviceConfigs = { tv1: { wakeHotkey: "Command+Control+1" } };
    await saveSettings({ pcInput: "HDMI3" });
    expect(store.deviceConfigs).toEqual({ tv1: { wakeHotkey: "Command+Control+1" } });
    await saveSettings({ deviceConfigs: "garbage" as never });
    expect(store.deviceConfigs).toEqual({ tv1: { wakeHotkey: "Command+Control+1" } });
  });

  it("normalizes a malformed map down to its valid entries", async () => {
    await saveSettings({
      deviceConfigs: {
        tv1: { wakeHotkey: 42, offHotkey: "  Command+Control+9 ", alias: ["nope"] },
        tv2: "garbage",
      } as never,
    });
    expect(store.deviceConfigs).toEqual({ tv1: { offHotkey: "Command+Control+9" } });
  });

  it("does not touch unrelated fields", async () => {
    store.wakeHotkey = "Command+Control+E";
    store.selectedDeviceIds = ["tv1"];
    await saveSettings({
      deviceConfigs: {
        tv9: { alias: "", description: "", pcInput: "", wakeHotkey: "Command+Control+9", offHotkey: "" },
      },
    });
    expect(store.wakeHotkey).toBe("Command+Control+E");
    expect(store.selectedDeviceIds).toEqual(["tv1"]);
  });
});

describe("LAN device fields", () => {
  it("canonicalizes the MAC and exposes host/mac/inputKeySeq, never wsToken", async () => {
    store.deviceConfigs = {
      "local:tv": { host: "1.2.3.4", mac: "A0-B1-C2-D3-E4-F5", inputKeySeq: "KEY_HDMI", wsToken: "secret" },
    };
    const settings = await getSettings();
    expect(settings.deviceConfigs["local:tv"]).toMatchObject({
      host: "1.2.3.4",
      mac: "a0:b1:c2:d3:e4:f5",
      inputKeySeq: "KEY_HDMI",
      paired: true,
    });
    // The token itself must never reach the renderer.
    expect(settings.deviceConfigs["local:tv"]).not.toHaveProperty("wsToken");
  });

  it("preserves the stored wsToken across a whole-map save that omits it", async () => {
    store.deviceConfigs = { "local:tv": { host: "1.2.3.4", wsToken: "secret" } };
    // The renderer never sends wsToken (only paired), yet the token must survive the save.
    await saveSettings({
      deviceConfigs: {
        "local:tv": {
          alias: "TV",
          description: "",
          pcInput: "",
          wakeHotkey: "",
          offHotkey: "",
          host: "1.2.3.4",
          mac: "",
          inputKeySeq: "",
          paired: true,
        },
      },
    });
    expect(store.deviceConfigs!["local:tv"].wsToken).toBe("secret");
    expect(store.deviceConfigs!["local:tv"].alias).toBe("TV");
  });
});
