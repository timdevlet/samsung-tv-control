import { describe, it, expect } from "vitest";

// The user-defined command list: normalization of untrusted payloads and the log/UI labels.

import { commandLabel, commandUsesHdmi, normalizeCommands } from "../src/domain/config.js";

describe("normalizeCommands", () => {
  it("returns [] for non-arrays", () => {
    expect(normalizeCommands(undefined)).toEqual([]);
    expect(normalizeCommands("garbage")).toEqual([]);
    expect(normalizeCommands({ 0: {} })).toEqual([]);
  });

  it("keeps valid entries as-is", () => {
    expect(
      normalizeCommands([
        { id: "a", action: "tvOn" },
        { id: "b", action: "tvOnHdmi", deviceIds: ["tv1", "tv2"], hdmi: "HDMI3", hotkey: "Command+Control+3" },
      ]),
    ).toEqual([
      { id: "a", action: "tvOn" },
      { id: "b", action: "tvOnHdmi", deviceIds: ["tv1", "tv2"], hdmi: "HDMI3", hotkey: "Command+Control+3" },
    ]);
  });

  it("trims/dedupes deviceIds and drops an empty set (empty = all enabled TVs)", () => {
    expect(
      normalizeCommands([
        { id: "a", action: "tvOn", deviceIds: [" tv1 ", "tv1", "", 42, "tv2"] },
        { id: "b", action: "tvOff", deviceIds: ["  "] },
        { id: "c", action: "tvOff", deviceIds: "garbage" },
      ]),
    ).toEqual([
      { id: "a", action: "tvOn", deviceIds: ["tv1", "tv2"] },
      { id: "b", action: "tvOff" },
      { id: "c", action: "tvOff" },
    ]);
  });

  it("migrates the legacy single deviceId string into deviceIds", () => {
    expect(normalizeCommands([{ id: "a", action: "tvOn", deviceId: "tv1" }])).toEqual([
      { id: "a", action: "tvOn", deviceIds: ["tv1"] },
    ]);
    expect(normalizeCommands([{ id: "b", action: "tvOff", deviceId: "  " }])).toEqual([
      { id: "b", action: "tvOff" },
    ]);
  });

  it("drops entries with an unknown action or non-object shape", () => {
    expect(
      normalizeCommands([{ id: "a", action: "explode" }, "garbage", null, { id: "b", action: "tvOff" }]),
    ).toEqual([{ id: "b", action: "tvOff" }]);
  });

  it("defaults an HDMI action's missing/invalid hdmi to HDMI1 and uppercases valid ones", () => {
    expect(normalizeCommands([{ id: "a", action: "switchHdmi" }])).toEqual([
      { id: "a", action: "switchHdmi", hdmi: "HDMI1" },
    ]);
    expect(normalizeCommands([{ id: "a", action: "switchHdmi", hdmi: "HDMI9" }])).toEqual([
      { id: "a", action: "switchHdmi", hdmi: "HDMI1" },
    ]);
    expect(normalizeCommands([{ id: "a", action: "tvOnHdmi", hdmi: " hdmi4 " }])).toEqual([
      { id: "a", action: "tvOnHdmi", hdmi: "HDMI4" },
    ]);
  });

  it("sheds a stray hdmi on non-HDMI actions and blank hotkeys", () => {
    expect(
      normalizeCommands([{ id: "a", action: "tvOff", hdmi: "HDMI2", hotkey: "   " }]),
    ).toEqual([{ id: "a", action: "tvOff" }]);
  });

  it("fills a missing id with a positional fallback", () => {
    expect(normalizeCommands([{ action: "tvOn" }, { action: "tvOff", id: "  " }])).toEqual([
      { id: "cmd-1", action: "tvOn" },
      { id: "cmd-2", action: "tvOff" },
    ]);
  });

  it("keeps pinned only for a literal true, dropping it otherwise (default = not pinned)", () => {
    expect(normalizeCommands([{ id: "a", action: "tvOn", pinned: true }])).toEqual([
      { id: "a", action: "tvOn", pinned: true },
    ]);
    // Anything that isn't the boolean true sheds the field — the Main screen shows only pinned:true.
    expect(
      normalizeCommands([
        { id: "a", action: "tvOn", pinned: false },
        { id: "b", action: "tvOff", pinned: "yes" },
        { id: "c", action: "tvOff" },
      ]),
    ).toEqual([
      { id: "a", action: "tvOn" },
      { id: "b", action: "tvOff" },
      { id: "c", action: "tvOff" },
    ]);
  });
});

describe("commandUsesHdmi", () => {
  it("is true only for the input-switching actions", () => {
    expect(commandUsesHdmi("tvOnHdmi")).toBe(true);
    expect(commandUsesHdmi("switchHdmi")).toBe(true);
    expect(commandUsesHdmi("tvOn")).toBe(false);
    expect(commandUsesHdmi("tvOff")).toBe(false);
    expect(commandUsesHdmi("tvOffSleepPc")).toBe(false);
  });
});

describe("commandLabel", () => {
  it("names each action, including the chosen HDMI input", () => {
    expect(commandLabel({ id: "a", action: "tvOn" })).toBe("TV on");
    expect(commandLabel({ id: "a", action: "tvOff" })).toBe("TV off");
    expect(commandLabel({ id: "a", action: "tvOffSleepPc" })).toBe("TV off + sleep PC");
    expect(commandLabel({ id: "a", action: "tvOnHdmi", hdmi: "HDMI3" })).toBe("TV on → HDMI3");
    expect(commandLabel({ id: "a", action: "switchHdmi", hdmi: "HDMI5" })).toBe("Switch to HDMI5");
  });
});
