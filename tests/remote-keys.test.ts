import { describe, it, expect } from "vitest";
import { REMOTE_KEY_GROUPS, appendKeyToken } from "../src/electron/renderer/src/lib/remoteKeys.js";
import { normalizeRemoteKey } from "../src/api/local-tv.js";

describe("appendKeyToken", () => {
  it("starts an empty sequence without a separator", () => {
    expect(appendKeyToken("", "DOWN")).toBe("DOWN");
    expect(appendKeyToken("   ", "DOWN")).toBe("DOWN");
  });

  it("appends with a comma-space separator", () => {
    expect(appendKeyToken("HDMI, UP", "DOWN")).toBe("HDMI, UP, DOWN");
  });

  it("absorbs a trailing comma instead of doubling it", () => {
    expect(appendKeyToken("HDMI, UP,", "DOWN")).toBe("HDMI, UP, DOWN");
    expect(appendKeyToken("HDMI, UP, ", "DOWN")).toBe("HDMI, UP, DOWN");
  });
});

describe("REMOTE_KEY_GROUPS", () => {
  it("every picker value normalizes to its literal KEY_* id", () => {
    for (const group of REMOTE_KEY_GROUPS) {
      for (const opt of group.options) {
        // Values are bare tokens (no aliasing), so each must become KEY_<token> exactly —
        // e.g. "HDMI2" → "KEY_HDMI2", "CH_LIST" → "KEY_CH_LIST".
        expect(normalizeRemoteKey(opt.value)).toBe(`KEY_${opt.value.toUpperCase()}`);
      }
    }
  });
});
