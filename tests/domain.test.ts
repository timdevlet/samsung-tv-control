import { describe, it, expect } from "vitest";
import { pickInput, isOnInput, parseStatus, pickTV, isTV, mainCapabilities, type TVStatus } from "../src/domain/tv.js";
import { parseHdmiFlag } from "../src/domain/cli.js";
import { hasOAuthClient, authorizeUrl, isTokenFresh, applyTokens, EXPIRY_SKEW_MS } from "../src/domain/oauth.js";
import { mergeConfig, defaultConfig, resolveStaticToken, clearTokens, normalizeTheme, wsTokenForConnect, NO_TOKEN_PAIRED, type TVConfig } from "../src/domain/config.js";
import { hotkeyLabel, isWithinBootWindow, TriggerGate, WakeDetector, withRetry } from "../src/domain/daemon.js";

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
  it("isTV is true only for input-capable devices", () => {
    expect(isTV(dev(["mediaInputSource"]))).toBe(true);
    expect(isTV(dev(["samsungvd.mediaInputSource", "switch"]))).toBe(true);
    expect(isTV(dev(["switch"]))).toBe(false);
    expect(isTV(dev([]))).toBe(false);
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
    expect(mergeConfig({ clientId: "x" })).toEqual({ pcInput: "HDMI2", minimizeToTrayOnClose: true, clientId: "x" });
  });
  it("migrates legacy secret -> clientSecret", () => {
    expect(mergeConfig({ secret: "s" }).clientSecret).toBe("s");
  });
  it("does not override an explicit clientSecret", () => {
    expect(mergeConfig({ secret: "s", clientSecret: "real" }).clientSecret).toBe("real");
  });
  it("drops the retired hotkey keys (hotkeys live on commands now)", () => {
    const merged = mergeConfig({
      wakeHotkey: "Command+Control+E",
      offHotkey: "Command+Control+Q",
      hotkeyBindings: [{ hotkey: "Command+Shift+P", action: "wakePc" }],
    });
    expect(merged).not.toHaveProperty("wakeHotkey");
    expect(merged).not.toHaveProperty("offHotkey");
    expect(merged).not.toHaveProperty("hotkeyBindings");
  });
  it("defaultConfig is defaults only", () => {
    expect(defaultConfig()).toEqual({ pcInput: "HDMI2", minimizeToTrayOnClose: true });
  });
  it("resolveStaticToken prefers env over config", () => {
    expect(resolveStaticToken({ pcInput: "x", token: "cfg" }, "  env ")).toBe("env");
    expect(resolveStaticToken({ pcInput: "x", token: "cfg" }, undefined)).toBe("cfg");
  });
  it("normalizeTheme passes valid values through", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("system")).toBe("system");
  });
  it("normalizeTheme falls back to dark on unset or invalid values", () => {
    expect(normalizeTheme(undefined)).toBe("dark");
    expect(normalizeTheme("neon")).toBe("dark");
    expect(normalizeTheme(42)).toBe("dark");
  });
  it("clearTokens drops tokens but keeps the OAuth client and preferences", () => {
    const signedIn: TVConfig = {
      pcInput: "HDMI3",
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: "https://example.test/cb",
      scopes: "r:devices:*",
      token: "legacy-pat",
      refreshToken: "rt",
      accessToken: "at",
      accessTokenExpiresAt: 123,
      selectedDeviceIds: ["tv1"],
      theme: "light",
    };
    expect(clearTokens(signedIn)).toEqual({
      pcInput: "HDMI3",
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: "https://example.test/cb",
      scopes: "r:devices:*",
      selectedDeviceIds: ["tv1"],
      theme: "light",
    });
  });
  it("clearTokens does not mutate its input", () => {
    const before: TVConfig = { pcInput: "HDMI2", clientId: "cid", refreshToken: "rt" };
    clearTokens(before);
    expect(before.refreshToken).toBe("rt");
  });
  it("wsTokenForConnect passes a real token through and maps the sentinel/empty to undefined", () => {
    expect(wsTokenForConnect("real-token")).toBe("real-token");
    expect(wsTokenForConnect(NO_TOKEN_PAIRED)).toBeUndefined();
    expect(wsTokenForConnect(undefined)).toBeUndefined();
    expect(wsTokenForConnect("")).toBeUndefined();
  });
});

describe("hotkeyLabel", () => {
  it("renders mac modifier names in conventional order", () => {
    expect(hotkeyLabel("Command+Control+E", "mac")).toBe("Ctrl+Cmd+E");
  });
  it("renders non-mac modifier names", () => {
    expect(hotkeyLabel("Control+Alt+Q", "other")).toBe("Ctrl+Alt+Q");
  });
  it("accepts modifier aliases and is case-insensitive", () => {
    expect(hotkeyLabel("cmd+shift+f8", "mac")).toBe("Shift+Cmd+f8");
  });
  it("resolves CmdOrCtrl per platform", () => {
    expect(hotkeyLabel("CmdOrCtrl+E", "mac")).toBe("Cmd+E");
    expect(hotkeyLabel("CmdOrCtrl+E", "other")).toBe("Ctrl+E");
  });
  it("shows 'unset' for empty or modifier-only input", () => {
    expect(hotkeyLabel("", "mac")).toBe("unset");
    expect(hotkeyLabel(undefined, "mac")).toBe("unset");
    expect(hotkeyLabel("Command+Control", "mac")).toBe("unset");
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

describe("withRetry", () => {
  // A sleep that resolves instantly so the tests don't actually wait; it records each delay.
  const fakeSleep = (delays: number[]) => (ms: number) => { delays.push(ms); return Promise.resolve(); };

  it("returns after the first success without sleeping", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(async () => { calls++; }, 10, 3000, fakeSleep(delays));
    expect(calls).toBe(1);
    expect(delays).toEqual([]); // no retry, no wait
  });

  it("retries until an attempt succeeds, sleeping delayMs between tries", async () => {
    const delays: number[] = [];
    const onRetry: number[] = [];
    let calls = 0;
    await withRetry(
      async () => { if (++calls < 3) throw new Error(`fail ${calls}`); },
      10,
      3000,
      fakeSleep(delays),
      (attempt) => onRetry.push(attempt),
    );
    expect(calls).toBe(3); // failed twice, succeeded on the 3rd
    expect(delays).toEqual([3000, 3000]); // one wait after each failure
    expect(onRetry).toEqual([1, 2]); // onRetry fired for the two failures
  });

  it("rethrows the last error after exhausting all attempts (no sleep after the final try)", async () => {
    const delays: number[] = [];
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error(`fail ${calls}`); }, 3, 3000, fakeSleep(delays)),
    ).rejects.toThrow("fail 3");
    expect(calls).toBe(3); // exactly `attempts` tries
    expect(delays).toEqual([3000, 3000]); // waited only between tries, not after the last
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
