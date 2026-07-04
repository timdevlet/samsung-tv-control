import { describe, it, expect } from "vitest";
import {
  tokenize,
  hasLeadingNewline,
  stripLeadingNewlines,
  type Token,
} from "../src/electron/renderer/src/lib/highlight.js";

// Reassemble tokens to prove tokenize never loses or reorders characters.
const joined = (tokens: Token[]) => tokens.map((t) => t.text).join("");

describe("tokenize", () => {
  it("splits a leading timestamp into a ts token", () => {
    const tokens = tokenize("[12:34:56] hello");
    expect(tokens[0]).toEqual({ kind: "ts", text: "[12:34:56]" });
    expect(joined(tokens)).toBe("[12:34:56] hello");
  });

  it("accepts 12-hour timestamps with an AM/PM suffix", () => {
    const tokens = tokenize("[1:02:03 PM] ok");
    expect(tokens[0]).toEqual({ kind: "ts", text: "[1:02:03 PM]" });
  });

  it("does not treat a mid-line bracket time as a timestamp", () => {
    const tokens = tokenize("at [12:34:56] later");
    expect(tokens.some((t) => t.kind === "ts")).toBe(false);
  });

  it("colors quoted and backquoted strings as var-string", () => {
    const tokens = tokenize('switching "Living Room TV" via `HDMI2`');
    expect(tokens.filter((t) => t.kind === "var-string").map((t) => t.text)).toEqual([
      '"Living Room TV"',
      "`HDMI2`",
    ]);
  });

  it("colors numbers, ratios and units as var-num", () => {
    const tokens = tokenize("attempt 1/3 after 2s then 40min wait 1.5 ms");
    expect(tokens.filter((t) => t.kind === "var-num").map((t) => t.text)).toEqual([
      "1/3",
      "2s",
      "40min",
      "1.5 ms",
    ]);
  });

  it("colors → and ✅ markers as var-string", () => {
    const tokens = tokenize("TV → PC ✅");
    expect(tokens.filter((t) => t.kind === "var-string").map((t) => t.text)).toEqual(["→", "✅"]);
  });

  it("keeps plain text runs untouched and lossless", () => {
    const message = '[9:00:01 AM] Wake "TV" 2/3 → done ✅ in 3s';
    expect(joined(tokenize(message))).toBe(message);
  });

  it("returns a single text token for an unstyled line", () => {
    expect(tokenize("plain line with no tokens")).toEqual([
      { kind: "text", text: "plain line with no tokens" },
    ]);
  });
});

describe("leading newlines", () => {
  it("detects the daemon's blank-line separators", () => {
    expect(hasLeadingNewline("\n✅ Signed in")).toBe(true);
    expect(hasLeadingNewline("✅ Signed in")).toBe(false);
  });

  it("strips all leading newlines before rendering", () => {
    expect(stripLeadingNewlines("\n\nhello")).toBe("hello");
    expect(stripLeadingNewlines("hello")).toBe("hello");
  });
});
