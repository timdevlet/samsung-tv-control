import { describe, it, expect } from "vitest";

// Pure per-device config logic: the config sanitizer and the accelerator grouping that
// daemon-core feeds into globalShortcut registration. No Electron, no I/O.

import { normalizeDeviceConfigs } from "../src/domain/config.js";
import { groupHotkeyBindings } from "../src/domain/daemon.js";

describe("normalizeDeviceConfigs", () => {
  it("returns an empty map for non-object input", () => {
    expect(normalizeDeviceConfigs(undefined)).toEqual({});
    expect(normalizeDeviceConfigs(null)).toEqual({});
    expect(normalizeDeviceConfigs("Command+E")).toEqual({});
    expect(normalizeDeviceConfigs(42)).toEqual({});
  });

  it("keeps trimmed string fields and drops non-string values", () => {
    expect(
      normalizeDeviceConfigs({
        tv1: { wakeHotkey: "  Command+Control+1  ", offHotkey: 42, alias: " 65 TV " },
        tv2: { wakeHotkey: null, offHotkey: "Command+Control+2", description: "living room tv" },
        tv3: { pcInput: "HDMI3", unknownField: "dropped" },
      }),
    ).toEqual({
      tv1: { wakeHotkey: "Command+Control+1", alias: "65 TV" },
      tv2: { offHotkey: "Command+Control+2", description: "living room tv" },
      tv3: { pcInput: "HDMI3" },
    });
  });

  it("prunes entries where every field is empty (clearing all fields deletes the entry)", () => {
    expect(
      normalizeDeviceConfigs({
        tv1: { wakeHotkey: "", offHotkey: "  ", alias: "", description: "", pcInput: "" },
        tv2: {},
        tv3: "garbage",
        tv4: { wakeHotkey: "Command+Control+4" },
      }),
    ).toEqual({ tv4: { wakeHotkey: "Command+Control+4" } });
  });
});

describe("groupHotkeyBindings", () => {
  it("maps the global pair to includeSelected targets with no explicit ids", () => {
    const groups = groupHotkeyBindings("Command+Control+E", "Command+Control+Q", {});
    expect(groups.get("Command+Control+E")).toEqual({
      wake: { includeSelected: true, deviceIds: [] },
    });
    expect(groups.get("Command+Control+Q")).toEqual({
      off: { includeSelected: true, deviceIds: [] },
    });
  });

  it("skips empty accelerators (cleared bindings register nothing)", () => {
    const groups = groupHotkeyBindings("", "  ", { tv1: { wakeHotkey: "", offHotkey: "" } });
    expect(groups.size).toBe(0);
  });

  it("ignores non-hotkey device fields (alias/description/pcInput bind nothing)", () => {
    const groups = groupHotkeyBindings("", "", {
      tv1: { alias: "65 TV", description: "living room tv", pcInput: "HDMI3" },
    });
    expect(groups.size).toBe(0);
  });

  it("binds a per-device hotkey to only that device", () => {
    const groups = groupHotkeyBindings("Command+Control+E", "", {
      tv1: { wakeHotkey: "Command+Control+1" },
    });
    expect(groups.get("Command+Control+1")).toEqual({
      wake: { includeSelected: false, deviceIds: ["tv1"] },
    });
  });

  it("unions devices sharing one accelerator into a single target", () => {
    const groups = groupHotkeyBindings("", "", {
      tv1: { wakeHotkey: "Command+Control+1" },
      tv2: { wakeHotkey: "Command+Control+1" },
    });
    expect(groups.size).toBe(1);
    expect(groups.get("Command+Control+1")).toEqual({
      wake: { includeSelected: false, deviceIds: ["tv1", "tv2"] },
    });
  });

  it("merges a global and a per-device binding on the same accelerator", () => {
    const groups = groupHotkeyBindings("Command+Control+E", "", {
      tv1: { wakeHotkey: "Command+Control+E" },
    });
    expect(groups.get("Command+Control+E")).toEqual({
      wake: { includeSelected: true, deviceIds: ["tv1"] },
    });
  });

  it("keeps a wake+off conflict on one accelerator observable (caller arms wake and warns)", () => {
    const groups = groupHotkeyBindings("", "", {
      tv1: { wakeHotkey: "Command+Control+X" },
      tv2: { offHotkey: "Command+Control+X" },
    });
    expect(groups.get("Command+Control+X")).toEqual({
      wake: { includeSelected: false, deviceIds: ["tv1"] },
      off: { includeSelected: false, deviceIds: ["tv2"] },
    });
  });
});
