import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Integration test for the power-on retry loop and the trimmed API logging. It drives the real
// createApp().switch() end-to-end with a mocked SmartThings cloud (global fetch) and fake timers,
// so the 5 × 3s loop is exercised exactly as in production — without a real TV or real waiting.

// Deterministic config so the test never depends on a real smartthings-config.json on disk.
// selectedDeviceIds targets the mocked TV ("tv1") so switch()/off() act on it — without a
// selection commands now no-op, matching the "require selection" behavior.
vi.mock("../src/config.js", () => ({
  loadConfig: async () => ({ pcInput: "HDMI2", selectedDeviceIds: ["tv1"] }),
  resolveToken: () => undefined,
  saveConfig: async () => {},
  resetConfig: async () => {},
  CONFIG_PATH: "test-config.json",
}));

import { createApp } from "../src/app.js";
import { withRetry } from "../src/domain/daemon.js";

const TV = {
  deviceId: "tv1",
  label: "Living Room TV",
  name: "tv",
  components: [{ id: "main", capabilities: [{ id: "switch" }, { id: "mediaInputSource" }] }],
};

// A /status body. When `on`, includes the input-source map (a real TV only exposes it once on);
// currentInput is HDMI2 so the PC input is already selected and no setInputSource is sent.
function statusBody(power: "on" | "off") {
  const main: Record<string, unknown> = { switch: { switch: { value: power } } };
  if (power === "on") {
    main.mediaInputSource = {
      inputSource: { value: "HDMI2" },
      supportedInputSourcesMap: { value: [{ id: "HDMI2", name: "PC" }] },
    };
  }
  return { components: { main } };
}

// Build a fetch mock whose /status returns "off" for the first `offReads` reads, then "on".
// `offReads = Infinity` simulates a TV that never wakes (deep standby).
function makeFetch(offReads: number) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let statusReads = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.endsWith("/devices")) return new Response(JSON.stringify({ items: [TV] }), { status: 200 });
    if (u.includes("/status")) {
      statusReads++;
      return new Response(JSON.stringify(statusBody(statusReads <= offReads ? "off" : "on")), { status: 200 });
    }
    if (u.endsWith("/commands")) return new Response(JSON.stringify({ results: [{ status: "ACCEPTED" }] }), { status: 200 });
    throw new Error(`unexpected request: ${method} ${u}`);
  });
  return { fetchMock, calls };
}

const powerOnCount = (calls: { body: unknown }[]) =>
  calls.filter((c) => {
    const cmd = (c.body as { commands?: { capability: string; command: string }[] })?.commands?.[0];
    return cmd?.capability === "switch" && cmd?.command === "on";
  }).length;

const hasSetInputSource = (calls: { body: unknown }[]) =>
  calls.some((c) => (c.body as { commands?: { command: string }[] })?.commands?.[0]?.command === "setInputSource");

describe("power-on retry loop", () => {
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.SMARTTHINGS_TOKEN = "test-token";
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SMARTTHINGS_TOKEN;
  });

  it("resends switch:on until the TV reports on, then stops", async () => {
    // off on the initial read + the read after attempt 1 → on from the read after attempt 2.
    const { fetchMock, calls } = makeFetch(2);
    vi.stubGlobal("fetch", fetchMock);

    const p = createApp().switch();
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(true); // acted on the selection — daemon reports success

    expect(powerOnCount(calls)).toBe(2); // stopped as soon as the TV came on, not all 10
    expect(hasSetInputSource(calls)).toBe(false); // already on HDMI2
    expect(logs).toContain("TV is on.");
  });

  it("gives up after exactly 5 attempts when the TV never wakes — without throwing", async () => {
    const { fetchMock, calls } = makeFetch(Infinity); // always off
    vi.stubGlobal("fetch", fetchMock);

    let err: unknown;
    const p = createApp().switch().catch((e) => { err = e; });
    await vi.runAllTimersAsync();
    await p;

    expect(powerOnCount(calls)).toBe(5); // POWER_ON_ATTEMPTS
    expect(logs.some((l) => l.includes("after 5 attempts"))).toBe(true);
    // A TV that never wakes is a give-up, not an error: switch() resolves so the daemon's wake
    // retry doesn't pointlessly re-run the whole (already-connected) operation.
    expect(err).toBeUndefined();
    expect(hasSetInputSource(calls)).toBe(false); // never reached the input switch
  });

  it("waits ~3s between attempts (does not busy-loop)", async () => {
    const { fetchMock } = makeFetch(Infinity);
    vi.stubGlobal("fetch", fetchMock);

    const p = createApp().switch().catch(() => {});
    // Let the initial status read + first switch:on happen, then assert no second send before 3s.
    await vi.advanceTimersByTimeAsync(0);
    const afterFirst = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock.mock.calls.length).toBe(afterFirst); // still waiting out the 3s
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst); // 3s elapsed → next round fires
    await vi.runAllTimersAsync();
    await p;
  });
});

describe("device selection gating", () => {
  let logs: string[];

  beforeEach(() => {
    process.env.SMARTTHINGS_TOKEN = "test-token";
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SMARTTHINGS_TOKEN;
  });

  it("no-ops without sending any command when no TVs are selected", async () => {
    // Re-mock loadConfig for this test to return an empty selection. resetModules so the
    // fresh createApp() import picks up the new mock.
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      loadConfig: async () => ({ pcInput: "HDMI2", selectedDeviceIds: [] }),
      resolveToken: () => undefined,
      saveConfig: async () => {},
      resetConfig: async () => {},
      CONFIG_PATH: "test-config.json",
    }));
    const { fetchMock, calls } = makeFetch(0);
    vi.stubGlobal("fetch", fetchMock);

    const { createApp: freshCreateApp } = await import("../src/app.js");
    await expect(freshCreateApp().switch()).resolves.toBe(false); // daemon reports "no TVs selected"

    expect(calls.length).toBe(0); // never even listed devices or sent a command
    expect(logs.some((l) => l.includes("No TVs selected"))).toBe(true);
    vi.doUnmock("../src/config.js");
  });
});

// Per-device hotkeys pass explicit device ids that must win over the Settings selection —
// the mocked config selects tv1, but the override targets tv2 only.
describe("explicit device targeting", () => {
  let logs: string[];

  beforeEach(() => {
    process.env.SMARTTHINGS_TOKEN = "test-token";
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SMARTTHINGS_TOKEN;
  });

  it("switch(undefined, ['tv2']) acts on tv2 and never touches the selected tv1", async () => {
    const { fetchMock, calls } = makeFetch(0); // on immediately — no retry timers needed
    vi.stubGlobal("fetch", fetchMock);

    await createApp().switch(undefined, ["tv2"]);

    expect(calls.some((c) => c.url.includes("/devices/tv2/"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/devices/tv1/"))).toBe(false);
  });

  it("off(['tv2']) turns tv2 off and never touches the selected tv1", async () => {
    const { fetchMock, calls } = makeFetch(0); // on + PC input → off proceeds
    vi.stubGlobal("fetch", fetchMock);

    await createApp().off(["tv2"]);

    const powerOffs = calls.filter((c) => {
      const cmd = (c.body as { commands?: { capability: string; command: string }[] })?.commands?.[0];
      return cmd?.capability === "switch" && cmd?.command === "off";
    });
    expect(powerOffs).toHaveLength(1);
    expect(powerOffs[0].url).toContain("/devices/tv2/commands");
    expect(calls.some((c) => c.url.includes("/devices/tv1/"))).toBe(false);
  });

  it("no-override calls still act on the Settings selection", async () => {
    const { fetchMock, calls } = makeFetch(0);
    vi.stubGlobal("fetch", fetchMock);

    await createApp().switch();

    expect(calls.some((c) => c.url.includes("/devices/tv1/"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/devices/tv2/"))).toBe(false);
  });
});

// A TV's own pcInput (deviceConfigs[id].pcInput) must win over the shared pcInput. The mocked
// TV is on HDMI2; the shared input is set to HDMI4 so only the per-device override matches.
describe("per-device PC input override", () => {
  let logs: string[];

  const mockConfigWith = (deviceConfigs: object) => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      loadConfig: async () => ({
        pcInput: "HDMI4", // shared input — does NOT match the TV's current HDMI2
        selectedDeviceIds: ["tv1"],
        deviceConfigs,
      }),
      resolveToken: () => undefined,
      saveConfig: async () => {},
      resetConfig: async () => {},
      CONFIG_PATH: "test-config.json",
    }));
  };

  beforeEach(() => {
    process.env.SMARTTHINGS_TOKEN = "test-token";
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
  });

  afterEach(() => {
    vi.doUnmock("../src/config.js");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SMARTTHINGS_TOKEN;
  });

  it("off() powers the TV off when its own input override matches the current input", async () => {
    mockConfigWith({ tv1: { pcInput: "HDMI2" } });
    const { fetchMock, calls } = makeFetch(0); // on, currentInput HDMI2
    vi.stubGlobal("fetch", fetchMock);

    const { createApp: freshCreateApp } = await import("../src/app.js");
    await expect(freshCreateApp().off()).resolves.toBe(true);

    const powerOffs = calls.filter((c) => {
      const cmd = (c.body as { commands?: { capability: string; command: string }[] })?.commands?.[0];
      return cmd?.capability === "switch" && cmd?.command === "off";
    });
    expect(powerOffs).toHaveLength(1);
  });

  it("off() leaves the TV on when only the non-matching shared input applies", async () => {
    mockConfigWith({}); // no override → shared HDMI4 decides
    const { fetchMock, calls } = makeFetch(0);
    vi.stubGlobal("fetch", fetchMock);

    const { createApp: freshCreateApp } = await import("../src/app.js");
    await freshCreateApp().off();

    expect(calls.some((c) => c.url.endsWith("/commands"))).toBe(false);
    expect(logs.some((l) => l.includes("leaving it on"))).toBe(true);
  });

  it("switch() targets the TV's own input, skipping the switch when already there", async () => {
    mockConfigWith({ tv1: { pcInput: "HDMI2" } });
    const { fetchMock, calls } = makeFetch(0);
    vi.stubGlobal("fetch", fetchMock);

    const { createApp: freshCreateApp } = await import("../src/app.js");
    await freshCreateApp().switch();

    expect(hasSetInputSource(calls)).toBe(false); // already on the per-device input
    expect(logs.some((l) => l.includes("already on HDMI2"))).toBe(true);
  });
});

// The wake-path bug this guards against: right after the PC resumes, WiFi can still be down, so
// every SmartThings/token call rejects before any HTTP status exists. switch() must throw (so the
// daemon's withRetry loop re-runs it after its delay) and the failure must be visible in the logs.
describe("wake-path failure propagation", () => {
  let logs: string[];
  let errors: string[];

  const networkError = (code: string) =>
    Object.assign(new TypeError("fetch failed"), { cause: { code } });

  beforeEach(() => {
    process.env.SMARTTHINGS_TOKEN = "test-token";
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SMARTTHINGS_TOKEN;
  });

  it("switch() rejects when every selected TV fails, and the failed call is logged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw networkError("ENETUNREACH"); }));

    await expect(createApp().switch()).rejects.toThrow(/failed: ENETUNREACH/);

    // The rejected fetch has no HTTP status to log, but must still leave an API trace.
    expect(logs).toContain("SmartThings API GET /devices/tv1/status → network error (ENETUNREACH)");
    expect(errors.some((l) => l.includes("TV tv1 failed"))).toBe(true);
  });

  it("switch() still resolves when only one of two selected TVs fails", async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      loadConfig: async () => ({ pcInput: "HDMI2", selectedDeviceIds: ["tv1", "tv2"] }),
      resolveToken: () => undefined,
      saveConfig: async () => {},
      resetConfig: async () => {},
      CONFIG_PATH: "test-config.json",
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/devices/tv2/")) throw networkError("ECONNREFUSED");
      if (u.includes("/status")) return new Response(JSON.stringify(statusBody("on")), { status: 200 });
      throw new Error(`unexpected request: ${u}`);
    }));

    const { createApp: freshCreateApp } = await import("../src/app.js");
    await freshCreateApp().switch(); // resolves: one TV still worked

    expect(errors.some((l) => l.includes("TV tv2 failed"))).toBe(true);
    vi.doUnmock("../src/config.js");
  });

  it("the wake retry spans a network outage: fails, waits, then succeeds", async () => {
    // The injected sleep stands in for the 3s wait during which WiFi finishes reconnecting.
    let networkUp = false;
    const { fetchMock } = makeFetch(0); // once the network is up: TV already on
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (!networkUp) throw networkError("ENETUNREACH");
      return fetchMock(url, init);
    }));

    const attempts: number[] = [];
    const app = createApp();
    await withRetry(
      () => app.switch(),
      10,
      3000,
      async () => { networkUp = true; },
      (attempt) => attempts.push(attempt),
    );

    expect(attempts).toEqual([1]); // one failed attempt, then success on the retry
    expect(logs.some((l) => l.includes("network error (ENETUNREACH)"))).toBe(true);
    expect(logs).toContain("Done — TV is on and on the target input.");
  });

  it("a token-refresh network failure is logged without leaking secrets", async () => {
    delete process.env.SMARTTHINGS_TOKEN; // force the OAuth refresh path
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      loadConfig: async () => ({
        pcInput: "HDMI2",
        selectedDeviceIds: ["tv1"],
        clientId: "client-id",
        clientSecret: "super-secret-value",
        refreshToken: "refresh-token-value",
        accessToken: "stale-access-token",
        accessTokenExpiresAt: 0, // long expired → refresh required
      }),
      resolveToken: () => undefined,
      saveConfig: async () => {},
      resetConfig: async () => {},
      CONFIG_PATH: "test-config.json",
    }));
    vi.stubGlobal("fetch", vi.fn(async () => { throw networkError("ENOTFOUND"); }));

    const { createApp: freshCreateApp } = await import("../src/app.js");
    await expect(freshCreateApp().switch()).rejects.toThrow(/token request failed: ENOTFOUND/);

    expect(logs).toContain("SmartThings token refresh_token → network error (ENOTFOUND)");
    for (const line of [...logs, ...errors]) {
      expect(line).not.toContain("super-secret-value");
      expect(line).not.toContain("refresh-token-value");
    }
    vi.doUnmock("../src/config.js");
  });
});

describe("API logging is concise", () => {
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.SMARTTHINGS_TOKEN = "test-token";
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SMARTTHINGS_TOKEN;
  });

  it("logs the outcome only — never dumps the raw status JSON", async () => {
    const { fetchMock } = makeFetch(0); // on immediately
    vi.stubGlobal("fetch", fetchMock);

    const p = createApp().switch();
    await vi.runAllTimersAsync();
    await p;

    const apiLines = logs.filter((l) => l.startsWith("SmartThings API"));
    expect(apiLines.length).toBeGreaterThan(0);
    // Successful calls end in "ok"; the multi-KB status payload is never logged.
    for (const line of apiLines) {
      expect(line).toMatch(/→ 200 ok$/);
      expect(line).not.toContain("supportedInputSourcesMap");
      expect(line).not.toContain("components");
    }
  });
});

// The daemon's automatic power-on (resume/boot) passes auto: true and must honor each TV's
// autoWake opt-out; user-initiated calls never filter. The boot path is the identical
// switch(..., { auto: true }) call, so these cover both automatic triggers.
describe("automatic power-on opt-out (autoWake)", () => {
  let logs: string[];

  const mockConfigWith = (selectedDeviceIds: string[], deviceConfigs: object) => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      loadConfig: async () => ({ pcInput: "HDMI2", selectedDeviceIds, deviceConfigs }),
      resolveToken: () => undefined,
      saveConfig: async () => {},
      resetConfig: async () => {},
      CONFIG_PATH: "test-config.json",
    }));
  };

  beforeEach(() => {
    process.env.SMARTTHINGS_TOKEN = "test-token";
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
  });

  afterEach(() => {
    vi.doUnmock("../src/config.js");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SMARTTHINGS_TOKEN;
  });

  it("an automatic switch skips an opted-out TV but still acts on the rest", async () => {
    mockConfigWith(["tv1", "tv2"], { tv1: { alias: "Bedroom", autoWake: false } });
    const { fetchMock, calls } = makeFetch(0); // on immediately — no retry timers needed
    vi.stubGlobal("fetch", fetchMock);

    const { createApp: freshCreateApp } = await import("../src/app.js");
    await expect(freshCreateApp().switch(undefined, undefined, { auto: true })).resolves.toBe(true);

    expect(calls.some((c) => c.url.includes("/devices/tv2/"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/devices/tv1/"))).toBe(false);
    expect(logs.some((l) => l.includes("[Bedroom] Automatic power-on is off"))).toBe(true);
  });

  it("a user-initiated switch ignores the opt-out", async () => {
    mockConfigWith(["tv1", "tv2"], { tv1: { autoWake: false } });
    const { fetchMock, calls } = makeFetch(0);
    vi.stubGlobal("fetch", fetchMock);

    const { createApp: freshCreateApp } = await import("../src/app.js");
    await freshCreateApp().switch();

    expect(calls.some((c) => c.url.includes("/devices/tv1/"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/devices/tv2/"))).toBe(true);
  });

  it("resolves true with zero cloud traffic when every selected TV opts out", async () => {
    mockConfigWith(["tv1"], { tv1: { autoWake: false } });
    const { fetchMock, calls } = makeFetch(0);
    vi.stubGlobal("fetch", fetchMock);

    const { createApp: freshCreateApp } = await import("../src/app.js");
    // Resolving (not throwing) matters: a throw would make the daemon's wake retry loop churn.
    await expect(freshCreateApp().switch(undefined, undefined, { auto: true })).resolves.toBe(true);

    expect(calls.length).toBe(0);
    expect(logs.some((l) => l.includes("Automatic power-on is off for every selected TV"))).toBe(true);
  });

  it("explicit device ids combined with auto still filter", async () => {
    mockConfigWith(["tv1"], { tv2: { autoWake: false } });
    const { fetchMock, calls } = makeFetch(0);
    vi.stubGlobal("fetch", fetchMock);

    const { createApp: freshCreateApp } = await import("../src/app.js");
    await freshCreateApp().switch(undefined, ["tv1", "tv2"], { auto: true });

    expect(calls.some((c) => c.url.includes("/devices/tv1/"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/devices/tv2/"))).toBe(false);
  });
});
