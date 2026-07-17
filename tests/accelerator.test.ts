import { describe, it, expect } from "vitest";
import {
  acceleratorKeyFromCode,
  acceleratorParts,
  captureFromEvent,
  modifiersFromEvent,
} from "../src/electron/renderer/src/lib/accelerator.js";

const event = (over: Partial<Parameters<typeof captureFromEvent>[0]>) => ({
  key: "",
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("acceleratorKeyFromCode", () => {
  it("maps letters, digits and function keys", () => {
    expect(acceleratorKeyFromCode("KeyE")).toBe("E");
    expect(acceleratorKeyFromCode("Digit1")).toBe("1");
    expect(acceleratorKeyFromCode("F1")).toBe("F1");
    expect(acceleratorKeyFromCode("F12")).toBe("F12");
  });

  it("maps named keys to Electron's tokens", () => {
    expect(acceleratorKeyFromCode("Enter")).toBe("Return");
    expect(acceleratorKeyFromCode("ArrowUp")).toBe("Up");
    expect(acceleratorKeyFromCode("Equal")).toBe("Plus");
    expect(acceleratorKeyFromCode("Minus")).toBe("-");
    expect(acceleratorKeyFromCode("Space")).toBe("Space");
  });

  it("returns null for bare modifiers and unknown codes", () => {
    expect(acceleratorKeyFromCode("ControlLeft")).toBeNull();
    expect(acceleratorKeyFromCode("MetaRight")).toBeNull();
    expect(acceleratorKeyFromCode("IntlBackslash")).toBeNull();
  });
});

describe("captureFromEvent", () => {
  it("cancels on Escape, keeping the previous value", () => {
    expect(captureFromEvent(event({ key: "Escape", code: "Escape" }))).toEqual({ kind: "cancel" });
  });

  it("stays pending on a modifier-only press", () => {
    expect(captureFromEvent(event({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toEqual(
      { kind: "pending" },
    );
  });

  it("rejects a bare key with no modifier", () => {
    const result = captureFromEvent(event({ key: "e", code: "KeyE" }));
    expect(result.kind).toBe("invalid");
  });

  it("builds the accelerator with modifiers in Command,Control,Alt,Shift order", () => {
    expect(
      captureFromEvent(event({ key: "e", code: "KeyE", metaKey: true, ctrlKey: true })),
    ).toEqual({ kind: "accelerator", accelerator: "Command+Control+E" });
    expect(
      captureFromEvent(event({ key: "Q", code: "KeyQ", shiftKey: true, altKey: true })),
    ).toEqual({ kind: "accelerator", accelerator: "Alt+Shift+Q" });
  });
});

describe("modifiersFromEvent", () => {
  it("lists held modifiers in stored order", () => {
    expect(modifiersFromEvent(event({ metaKey: true, shiftKey: true }))).toEqual([
      "Command",
      "Shift",
    ]);
    expect(modifiersFromEvent(event({}))).toEqual([]);
  });
});

describe("acceleratorParts", () => {
  const labels = (accelerator: string, isMac: boolean) =>
    acceleratorParts(accelerator, isMac).map((p) => p.label);

  it("maps mac modifiers to symbols, reordered to Ctrl,Alt,Shift,Cmd rank", () => {
    // Stored order is Command-first; display rank puts ⌘ last, like macOS menus.
    expect(labels("Command+Shift+K", true)).toEqual(["⇧", "⌘", "K"]);
    expect(labels("Command+Control+E", true)).toEqual(["⌃", "⌘", "E"]);
  });

  it("uses text names off mac", () => {
    expect(labels("Control+Alt+P", false)).toEqual(["Ctrl", "Alt", "P"]);
    expect(labels("Command+Shift+K", false)).toEqual(["Shift", "Win", "K"]);
  });

  it("compacts named keys to glyphs and passes the rest through", () => {
    expect(labels("Command+Up", true)).toEqual(["⌘", "↑"]);
    expect(labels("Control+Return", false)).toEqual(["Ctrl", "↩"]);
    expect(labels("Alt+F5", true)).toEqual(["⌥", "F5"]);
    expect(labels("Command+Space", true)).toEqual(["⌘", "Space"]);
  });

  it("tags parts as mod/key and returns [] for an empty accelerator", () => {
    expect(acceleratorParts("Command+K", true)).toEqual([
      { token: "Command", label: "⌘", kind: "mod" },
      { token: "K", label: "K", kind: "key" },
    ]);
    expect(acceleratorParts("", true)).toEqual([]);
  });
});
