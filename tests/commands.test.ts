import { describe, it, expect } from "vitest";

// The user-defined command list: normalization of untrusted payloads and the log/UI labels.

import {
  commandIsKeySeq,
  commandLabel,
  commandUsesHdmi,
  normalizeCommands,
} from "../src/domain/config.js";

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

  it("defaults an HDMI action's missing hdmi to HDMI1 and uppercases known HDMI inputs", () => {
    expect(normalizeCommands([{ id: "a", action: "switchHdmi" }])).toEqual([
      { id: "a", action: "switchHdmi", hdmi: "HDMI1" },
    ]);
    expect(normalizeCommands([{ id: "a", action: "switchHdmi", hdmi: "   " }])).toEqual([
      { id: "a", action: "switchHdmi", hdmi: "HDMI1" },
    ]);
    expect(normalizeCommands([{ id: "a", action: "tvOnHdmi", hdmi: " hdmi4 " }])).toEqual([
      { id: "a", action: "tvOnHdmi", hdmi: "HDMI4" },
    ]);
  });

  it("keeps a custom input alias (non-standard hdmi value) verbatim", () => {
    // A value that isn't one of HDMI1..HDMI5 is a user-typed input name (e.g. "pc") and is
    // preserved as-is — matched by label on the cloud path, mapped by the LAN transport.
    expect(normalizeCommands([{ id: "a", action: "switchHdmi", hdmi: "pc" }])).toEqual([
      { id: "a", action: "switchHdmi", hdmi: "pc" },
    ]);
    expect(normalizeCommands([{ id: "a", action: "tvOnHdmi", hdmi: " KEY_HDMI2 " }])).toEqual([
      { id: "a", action: "tvOnHdmi", hdmi: "KEY_HDMI2" },
    ]);
  });

  it("sheds a stray hdmi on non-HDMI actions and blank hotkeys", () => {
    expect(
      normalizeCommands([{ id: "a", action: "tvOff", hdmi: "HDMI2", hotkey: "   " }]),
    ).toEqual([{ id: "a", action: "tvOff" }]);
  });

  it("keeps keySeq (and drops hdmi) for a LAN-targeted command", () => {
    // A single local:<mac> target makes the command a key-sequence command — keySeq is kept, and
    // the HDMI field is irrelevant (the action isn't used over the LAN) so it's dropped.
    expect(
      normalizeCommands([
        { id: "a", action: "switchHdmi", deviceIds: ["local:tv"], hdmi: "HDMI2", keySeq: " HDMI, UP, LEFT " },
      ]),
    ).toEqual([{ id: "a", action: "switchHdmi", deviceIds: ["local:tv"], keySeq: "HDMI, UP, LEFT" }]);
  });

  it("sheds keySeq for a cloud / all-TVs command (keySeq only applies to a LAN target)", () => {
    // Cloud target → runs an action; a stray keySeq is dropped and hdmi kept as usual.
    expect(
      normalizeCommands([
        { id: "a", action: "switchHdmi", deviceIds: ["cloud-uuid"], hdmi: "HDMI2", keySeq: "UP" },
      ]),
    ).toEqual([{ id: "a", action: "switchHdmi", deviceIds: ["cloud-uuid"], hdmi: "HDMI2" }]);
    // No target (all enabled TVs) → also not a key-seq command.
    expect(normalizeCommands([{ id: "b", action: "tvOn", keySeq: "UP" }])).toEqual([
      { id: "b", action: "tvOn" },
    ]);
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

  it("keeps runOnWake only for a literal true, dropping it otherwise (default = don't run on wake)", () => {
    expect(normalizeCommands([{ id: "a", action: "tvOn", runOnWake: true }])).toEqual([
      { id: "a", action: "tvOn", runOnWake: true },
    ]);
    // Anything that isn't boolean true sheds the field — only runOnWake:true runs automatically.
    expect(
      normalizeCommands([
        { id: "a", action: "tvOn", runOnWake: false },
        { id: "b", action: "tvOff", runOnWake: "yes" },
        { id: "c", action: "tvOff" },
      ]),
    ).toEqual([
      { id: "a", action: "tvOn" },
      { id: "b", action: "tvOff" },
      { id: "c", action: "tvOff" },
    ]);
  });

  it("keeps sleepPc only for a literal true, dropping it otherwise (default = leave the PC alone)", () => {
    expect(normalizeCommands([{ id: "a", action: "tvOff", sleepPc: true }])).toEqual([
      { id: "a", action: "tvOff", sleepPc: true },
    ]);
    expect(
      normalizeCommands([
        { id: "a", action: "tvOff", sleepPc: false },
        { id: "b", action: "tvOff", sleepPc: "yes" },
      ]),
    ).toEqual([
      { id: "a", action: "tvOff" },
      { id: "b", action: "tvOff" },
    ]);
  });

  it("migrates the retired tvOffSleepPc action to tvOff + sleepPc, keeping hotkey/pin/target", () => {
    expect(
      normalizeCommands([
        { id: "a", action: "tvOffSleepPc", deviceIds: ["tv1"], hotkey: "Command+9", pinned: true },
      ]),
    ).toEqual([
      { id: "a", action: "tvOff", deviceIds: ["tv1"], hotkey: "Command+9", pinned: true, sleepPc: true },
    ]);
  });
});

describe("commandUsesHdmi", () => {
  it("is true only for the input-switching actions", () => {
    expect(commandUsesHdmi("tvOnHdmi")).toBe(true);
    expect(commandUsesHdmi("switchHdmi")).toBe(true);
    expect(commandUsesHdmi("tvOn")).toBe(false);
    expect(commandUsesHdmi("tvOff")).toBe(false);
  });
});

describe("commandIsKeySeq", () => {
  it("is true only when the single target is a LAN (local:) id", () => {
    expect(commandIsKeySeq({ id: "a", action: "tvOn", deviceIds: ["local:tv"] })).toBe(true);
    expect(commandIsKeySeq({ id: "a", action: "tvOn", deviceIds: ["cloud-uuid"] })).toBe(false);
    // No target = all enabled TVs = a cloud-style action command.
    expect(commandIsKeySeq({ id: "a", action: "tvOn" })).toBe(false);
  });
});

describe("commandLabel", () => {
  it("names each action, including the chosen HDMI input", () => {
    expect(commandLabel({ id: "a", action: "tvOn" })).toBe("TV on");
    expect(commandLabel({ id: "a", action: "tvOff" })).toBe("TV off");
    expect(commandLabel({ id: "a", action: "tvOnHdmi", hdmi: "HDMI3" })).toBe("TV on → HDMI3");
    expect(commandLabel({ id: "a", action: "switchHdmi", hdmi: "HDMI5" })).toBe("Switch to HDMI5");
  });

  it("labels a LAN key-sequence command by its sequence, not the action", () => {
    expect(
      commandLabel({ id: "a", action: "tvOn", deviceIds: ["local:tv"], keySeq: "HDMI, UP" }),
    ).toBe("Keys: HDMI, UP");
    // A LAN target with no sequence yet still reads as a key-sequence command.
    expect(commandLabel({ id: "a", action: "tvOn", deviceIds: ["local:tv"] })).toBe("Key sequence");
  });
});
