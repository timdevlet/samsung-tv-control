import { describe, it, expect } from "vitest";
import { shortId } from "../src/electron/renderer/src/lib/id.js";

describe("shortId", () => {
  it("keeps only the last 6 characters, with an ellipsis marking the truncation", () => {
    expect(shortId("0613c3a1-6f18-4a3e-9a2b-59f7f0e2ab1c")).toBe("…e2ab1c");
  });

  it("returns ids at or under the limit unchanged", () => {
    expect(shortId("abcdef")).toBe("abcdef");
    expect(shortId("abc")).toBe("abc");
    expect(shortId("")).toBe("");
  });

  it("honors a custom tail length", () => {
    expect(shortId("abcdefgh", 4)).toBe("…efgh");
  });
});
