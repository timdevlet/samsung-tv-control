import { describe, it, expect } from "vitest";
import { pickInput, isOnInput, parseStatus, pickTV, mainCapabilities, type TVStatus } from "../src/domain/tv.js";
import { parseHdmiFlag } from "../src/domain/cli.js";
import { hasOAuthClient, authorizeUrl, isTokenFresh, applyTokens, EXPIRY_SKEW_MS } from "../src/domain/oauth.js";
import { mergeConfig, defaultConfig, resolveStaticToken, type TVConfig } from "../src/domain/config.js";
import { matchHotkey, isWithinBootWindow, TriggerGate, WakeDetector } from "../src/domain/daemon.js";

const status = (over: Partial<TVStatus> = {}): TVStatus => ({ sources: [], ...over });

describe("pickInput", () => {
  it("matches by id (case-insensitive)", () => {
    const s = status({ sources: [{ id: "HDMI2", name: "PC" }] });
    expect(pickInput(s, "hdmi2")).toBe("HDMI2");
  });
  it("matches by label when id doesn't match", () => {
    const s = status({ sources: [{ id: "HDMI3", name: "PC" }] });
    expect(pickInput(s, "pc")).toBe("HDMI3");
  });
  it("prefers an id match over a label match", () => {
    // "PC" matches source A's id and source B's label; the id match must win.
    const s = status({ sources: [{ id: "PC", name: "Living Room" }, { id: "HDMI1", name: "PC" }] });
    expect(pickInput(s, "pc")).toBe("PC");
  });
  it("falls back to the raw value when nothing matches", () => {
    expect(pickInput(status(), "HDMI4")).toBe("HDMI4");
  });
});

describe("isOnInput", () => {
  it("is true on a case-insensitive match", () => {
    expect(isOnInput(status({ currentInput: "HDMI2" }), "hdmi2")).toBe(true);
  });
  it("is false when no current input", () => {
    expect(isOnInput(status(), "HDMI2")).toBe(false);
  });
});

describe("parseHdmiFlag", () => {
  it("parses --hdmi N", () => expect(parseHdmiFlag(["--hdmi", "3"])).toBe("HDMI3"));
  it("parses --hdmi=N", () => expect(parseHdmiFlag(["--hdmi=2"])).toBe("HDMI2"));
  it("parses --hdmiN", () => expect(parseHdmiFlag(["--hdmi4"])).toBe("HDMI4"));
  it("returns undefined when absent", () => expect(parseHdmiFlag(["--other"])).toBeUndefined());
  it("throws on out-of-range", () => expect(() => parseHdmiFlag(["--hdmi", "9"])).toThrow(/Invalid/));
  it("throws on missing value", () => expect(() => parseHdmiFlag(["--hdmi"])).toThrow(/Invalid/));
});

describe("parseStatus", () => {
  it("extracts power, capability, current input, and sources", () => {
    const raw = {
      components: {
        main: {
          switch: { switch: { value: "on" } },
          mediaInputSource: {
            inputSource: { value: "HDMI2" },
            supportedInputSourcesMap: { value: [{ id: "HDMI2", name: "PC" }, { id: "HDMI1" }] },
          },
        },
      },
    };
    const s = parseStatus(raw);
    expect(s.power).toBe("on");
    expect(s.inputCapability).toBe("mediaInputSource");
    expect(s.currentInput).toBe("HDMI2");
    expect(s.sources).toEqual([{ id: "HDMI2", name: "PC" }, { id: "HDMI1", name: "HDMI1" }]);
  });
  it("prefers the samsungvd capability", () => {
    const raw = { components: { main: { "samsungvd.mediaInputSource": { inputSource: { value: "HDMI3" } } } } };
    expect(parseStatus(raw).inputCapability).toBe("samsungvd.mediaInputSource");
  });
  it("handles a device with no input capability", () => {
    const s = parseStatus({ components: { main: {} } });
    expect(s.inputCapability).toBeUndefined();
    expect(s.sources).toEqual([]);
  });
});

describe("pickTV / mainCapabilities", () => {
  const dev = (caps: string[], deviceId = "d"): any => ({
    deviceId,
    label: deviceId,
    name: deviceId,
    capabilities: caps,
  });
  it("prefers a device that also has switch capability", () => {
    const a = dev(["mediaInputSource"], "a");
    const b = dev(["mediaInputSource", "switch"], "b");
    expect(pickTV([a, b])?.deviceId).toBe("b");
  });
  it("returns null when nothing is input-capable", () => {
    expect(pickTV([dev(["switch"])])).toBeNull();
  });
  it("reads main-component capabilities", () => {
    expect(mainCapabilities({ deviceId: "d", components: [{ id: "main", capabilities: [{ id: "switch" }] }] })).toEqual(["switch"]);
  });
});

describe("OAuth decisions", () => {
  const cfg = (o: Partial<TVConfig> = {}): TVConfig => ({ pcInput: "HDMI2", ...o });

  it("hasOAuthClient requires both id and secret", () => {
    expect(hasOAuthClient(cfg({ clientId: "x" }))).toBe(false);
    expect(hasOAuthClient(cfg({ clientId: "x", clientSecret: "y" }))).toBe(true);
  });
  it("authorizeUrl includes client id and scopes", () => {
    const url = authorizeUrl(cfg({ clientId: "abc", scopes: "r:devices:*" }));
    expect(url).toContain("client_id=abc");
    expect(url).toContain("response_type=code");
    expect(url).toContain("r%3Adevices%3A*");
  });
  it("isTokenFresh respects the skew window", () => {
    const expiresAt = 1_000_000;
    const c = cfg({ accessToken: "t", accessTokenExpiresAt: expiresAt });
    expect(isTokenFresh(c, expiresAt - EXPIRY_SKEW_MS - 1)).toBe(true);
    expect(isTokenFresh(c, expiresAt - EXPIRY_SKEW_MS + 1)).toBe(false);
  });
  it("isTokenFresh is false without a cached token", () => {
    expect(isTokenFresh(cfg({ accessTokenExpiresAt: 9e15 }), 0)).toBe(false);
  });
  it("applyTokens sets token fields and computes expiry from now", () => {
    const c = cfg();
    applyTokens(c, { access_token: "a", refresh_token: "r", expires_in: 100 }, 5_000);
    expect(c.accessToken).toBe("a");
    expect(c.refreshToken).toBe("r");
    expect(c.accessTokenExpiresAt).toBe(5_000 + 100_000);
  });
});

describe("config policy", () => {
  it("merges over defaults", () => {
    expect(mergeConfig({ clientId: "x" })).toEqual({ pcInput: "HDMI2", clientId: "x" });
  });
  it("migrates legacy secret -> clientSecret", () => {
    expect(mergeConfig({ secret: "s" }).clientSecret).toBe("s");
  });
  it("does not override an explicit clientSecret", () => {
    expect(mergeConfig({ secret: "s", clientSecret: "real" }).clientSecret).toBe("real");
  });
  it("defaultConfig is defaults only", () => {
    expect(defaultConfig()).toEqual({ pcInput: "HDMI2" });
  });
  it("resolveStaticToken prefers env over config", () => {
    expect(resolveStaticToken({ pcInput: "x", token: "cfg" }, "  env ")).toBe("env");
    expect(resolveStaticToken({ pcInput: "x", token: "cfg" }, undefined)).toBe("cfg");
  });
});

describe("matchHotkey", () => {
  const downE = { state: "DOWN", name: "E" };
  it("matches meta+ctrl on mac", () => {
    expect(matchHotkey(downE, { ctrl: true, alt: false, meta: true }, "E", "mac")).toBe(true);
  });
  it("matches ctrl+alt on other", () => {
    expect(matchHotkey(downE, { ctrl: true, alt: true, meta: false }, "E", "other")).toBe(true);
  });
  it("rejects the wrong key", () => {
    expect(matchHotkey({ state: "DOWN", name: "Q" }, { ctrl: true, alt: true, meta: false }, "E", "other")).toBe(false);
  });
  it("rejects key-up events", () => {
    expect(matchHotkey({ state: "UP", name: "E" }, { ctrl: true, alt: true, meta: false }, "E", "other")).toBe(false);
  });
  it("rejects when modifiers aren't held", () => {
    expect(matchHotkey(downE, { ctrl: true, alt: false, meta: false }, "E", "other")).toBe(false);
  });
});

describe("isWithinBootWindow", () => {
  it("is true just under the window and false at/after it", () => {
    expect(isWithinBootWindow(119, 120)).toBe(true);
    expect(isWithinBootWindow(120, 120)).toBe(false);
  });
});

describe("TriggerGate", () => {
  it("rejects re-entry while busy", () => {
    const g = new TriggerGate(2000);
    expect(g.tryAcquire(0)).toBe(true);
    expect(g.tryAcquire(0)).toBe(false); // still busy
  });
  it("enforces the cooldown window after release", () => {
    const g = new TriggerGate(2000);
    g.tryAcquire(0);
    g.release(0);
    expect(g.tryAcquire(1999)).toBe(false); // inside cooldown
    expect(g.tryAcquire(2000)).toBe(true); // window elapsed
  });
});

describe("WakeDetector", () => {
  it("ignores gaps below the threshold", () => {
    const d = new WakeDetector(10_000, 300_000, 0);
    expect(d.tick(3000)).toBeNull();
  });
  it("detects a gap at/above the threshold and returns sleptMs", () => {
    const d = new WakeDetector(10_000, 300_000, 0);
    expect(d.tick(15_000)).toBe(15_000);
  });
  it("suppresses further detections during the pause window", () => {
    const d = new WakeDetector(10_000, 300_000, 0);
    expect(d.tick(15_000)).toBe(15_000);
    expect(d.tick(30_000)).toBeNull(); // within 300s pause
  });
});
