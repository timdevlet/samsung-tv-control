import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Integration test for the power-on retry loop and the trimmed API logging. It drives the real
// createApp().switch() end-to-end with a mocked SmartThings cloud (global fetch) and fake timers,
// so the 10 × 3s loop is exercised exactly as in production — without a real TV or real waiting.

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
    await p;

    expect(powerOnCount(calls)).toBe(2); // stopped as soon as the TV came on, not all 10
    expect(hasSetInputSource(calls)).toBe(false); // already on HDMI2
    expect(logs).toContain("TV is on.");
  });

  it("gives up after exactly 10 attempts when the TV never wakes — without throwing", async () => {
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
    await freshCreateApp().switch();

    expect(calls.length).toBe(0); // never even listed devices or sent a command
    expect(logs.some((l) => l.includes("No TVs selected"))).toBe(true);
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
