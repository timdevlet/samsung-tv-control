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

beforeEach(() => {
  store = { pcInput: "HDMI2" };
});

describe("deviceConfigs in getSettings", () => {
  it("fills missing fields with empty strings and prunes empty entries", async () => {
    store.deviceConfigs = { tv1: { alias: "65 TV", description: "living room" }, tv2: {} };
    const settings = await getSettings();
    expect(settings.deviceConfigs).toEqual({
      tv1: {
        alias: "65 TV",
        description: "living room",
        host: "",
        mac: "",
        inputKeySeq: "",
        keyDelay: "",
        paired: false,
      },
    });
  });
});

describe("deviceConfigs in saveSettings", () => {
  it("replaces the whole map when one is supplied", async () => {
    store.deviceConfigs = { tv1: { alias: "Old TV" } };
    await saveSettings({
      deviceConfigs: {
        tv2: {
          alias: "65 TV",
          description: "living room tv",
          host: "",
          mac: "",
          inputKeySeq: "",
          paired: false,
        },
      },
    });
    expect(store.deviceConfigs).toEqual({
      tv2: {
        alias: "65 TV",
        description: "living room tv",
      },
    });
  });

  it("removes an entry when all of its fields are cleared", async () => {
    store.deviceConfigs = { tv1: { alias: "65 TV", description: "old" } };
    await saveSettings({
      deviceConfigs: {
        tv1: { alias: "", description: "", host: "", mac: "", inputKeySeq: "", paired: false },
      },
    });
    expect(store.deviceConfigs).toEqual({});
  });

  it("leaves the stored map untouched when deviceConfigs is absent or not an object", async () => {
    store.deviceConfigs = { tv1: { alias: "65 TV" } };
    await saveSettings({ minimizeToTrayOnClose: false });
    expect(store.deviceConfigs).toEqual({ tv1: { alias: "65 TV" } });
    await saveSettings({ deviceConfigs: "garbage" as never });
    expect(store.deviceConfigs).toEqual({ tv1: { alias: "65 TV" } });
  });

  it("normalizes a malformed map down to its valid entries", async () => {
    await saveSettings({
      deviceConfigs: {
        tv1: { alias: 42, description: "  living room ", host: ["nope"] },
        tv2: "garbage",
      } as never,
    });
    expect(store.deviceConfigs).toEqual({ tv1: { description: "living room" } });
  });

  it("does not touch unrelated fields", async () => {
    store.selectedDeviceIds = ["tv1"];
    store.pcInput = "HDMI4";
    await saveSettings({
      deviceConfigs: {
        tv9: { alias: "Bedroom", description: "", host: "", mac: "", inputKeySeq: "", paired: false },
      },
    });
    expect(store.selectedDeviceIds).toEqual(["tv1"]);
    expect(store.pcInput).toBe("HDMI4");
  });

  it("carries the stored per-TV pcInput forward across a whole-map save (no UI edits it)", async () => {
    store.deviceConfigs = { tv1: { alias: "65 TV", pcInput: "HDMI3" } };
    await saveSettings({
      deviceConfigs: {
        tv1: { alias: "Renamed", description: "", host: "", mac: "", inputKeySeq: "", paired: false },
      },
    });
    expect(store.deviceConfigs).toEqual({ tv1: { alias: "Renamed", pcInput: "HDMI3" } });
  });

  it("carries a stored autoWake opt-out forward across a save (the UI no longer edits it)", async () => {
    // autoWake is retired from the UI but kept in the schema; a stored opt-out must survive the
    // renderer's whole-map save, which never sends it.
    store.deviceConfigs = { tv1: { alias: "TV", autoWake: false } };
    await saveSettings({
      deviceConfigs: {
        tv1: { alias: "Renamed", description: "", host: "", mac: "", inputKeySeq: "", paired: false },
      },
    });
    expect(store.deviceConfigs).toEqual({ tv1: { alias: "Renamed", autoWake: false } });
  });

  it("keeps an entry alive when a carried-forward opt-out is its only remaining setting", async () => {
    store.deviceConfigs = { tv1: { autoWake: false } };
    await saveSettings({
      deviceConfigs: {
        tv1: { alias: "", description: "", host: "", mac: "", inputKeySeq: "", paired: false },
      },
    });
    expect(store.deviceConfigs).toEqual({ tv1: { autoWake: false } });
  });
});

describe("commands in getSettings/saveSettings", () => {
  it("exposes stored commands with every field filled", async () => {
    store.commands = [
      { id: "a", action: "tvOnHdmi", deviceIds: ["tv1", "tv2"], hdmi: "HDMI3", hotkey: "Command+Control+3", pinned: true, runOnWake: true },
      { id: "b", action: "tvOff", sleepPc: true },
    ];
    const settings = await getSettings();
    expect(settings.commands).toEqual([
      { id: "a", action: "tvOnHdmi", deviceIds: ["tv1", "tv2"], hdmi: "HDMI3", keySeq: "", hotkey: "Command+Control+3", pinned: true, runOnWake: true, sleepPc: false },
      { id: "b", action: "tvOff", deviceIds: [], hdmi: "", keySeq: "", hotkey: "", pinned: false, runOnWake: false, sleepPc: true },
    ]);
  });

  it("replaces the whole list on save, dropping malformed entries", async () => {
    store.commands = [{ id: "a", action: "tvOn" }];
    await saveSettings({
      commands: [
        { id: "b", action: "switchHdmi", deviceIds: ["tv2"], hdmi: "HDMI2", hotkey: "" },
        { id: "c", action: "nonsense", deviceIds: [], hdmi: "", hotkey: "" },
      ] as never,
    });
    expect(store.commands).toEqual([
      { id: "b", action: "switchHdmi", deviceIds: ["tv2"], hdmi: "HDMI2" },
    ]);
  });

  it("persists an emptied list (all commands deleted) but ignores a missing field", async () => {
    store.commands = [{ id: "a", action: "tvOn" }];
    await saveSettings({ minimizeToTrayOnClose: true });
    expect(store.commands).toEqual([{ id: "a", action: "tvOn" }]);
    await saveSettings({ commands: [] });
    expect(store.commands).toEqual([]);
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

  it("round-trips keyDelay: form string in, clamped number stored, string back out", async () => {
    await saveSettings({
      deviceConfigs: {
        "local:tv": {
          alias: "", description: "", host: "1.2.3.4", mac: "", inputKeySeq: "",
          keyDelay: "2.5", paired: false,
        },
      },
    });
    expect(store.deviceConfigs).toEqual({ "local:tv": { host: "1.2.3.4", keyDelay: 2.5 } });
    expect((await getSettings()).deviceConfigs["local:tv"].keyDelay).toBe("2.5");

    // Out-of-range entry clamps to the 5s cap; clearing the field removes the stored value.
    await saveSettings({
      deviceConfigs: {
        "local:tv": {
          alias: "", description: "", host: "1.2.3.4", mac: "", inputKeySeq: "",
          keyDelay: "7", paired: false,
        },
      },
    });
    expect(store.deviceConfigs!["local:tv"].keyDelay).toBe(5);
    await saveSettings({
      deviceConfigs: {
        "local:tv": {
          alias: "", description: "", host: "1.2.3.4", mac: "", inputKeySeq: "",
          keyDelay: "", paired: false,
        },
      },
    });
    expect(store.deviceConfigs).toEqual({ "local:tv": { host: "1.2.3.4" } });
  });

  it("preserves the stored wsToken across a whole-map save that omits it", async () => {
    store.deviceConfigs = { "local:tv": { host: "1.2.3.4", wsToken: "secret" } };
    // The renderer never sends wsToken (only paired), yet the token must survive the save.
    await saveSettings({
      deviceConfigs: {
        "local:tv": {
          alias: "TV",
          description: "",
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
