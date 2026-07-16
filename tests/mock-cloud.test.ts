import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests for dev mode (src/dev/mock-cloud.ts): the FakeCloud's stateful routing on its own, and
// installMockCloud() driving the real createApp() end-to-end — the same integration shape as
// power-on.test.ts, but with the fake cloud instead of a hand-rolled fetch stub.

// Deterministic config, same pattern as power-on.test.ts. mock-cloud.ts imports CONFIG_PATH from
// config.js too, so the mock must export it. A single selected TV keeps log lines untagged.
vi.mock("../src/config.js", () => ({
  loadConfig: async () => ({ pcInput: "HDMI2", selectedDeviceIds: ["mock-tv-1"] }),
  resolveToken: () => undefined,
  saveConfig: async () => {},
  resetConfig: async () => {},
  CONFIG_PATH: "test-config.json",
}));

// auth.ts imports BrowserWindow (main-process Electron); a stub class is enough since the
// mock-mode auth paths under test never open a window.
vi.mock("electron", () => ({ BrowserWindow: class {} }));

import { FakeCloud, installMockCloud } from "../src/dev/mock-cloud.js";
import { makeMockTransport } from "../src/dev/mock-transport.js";
import { MOCK_DEVICES, MOCK_LOCAL_DEVICE_ID } from "../src/dev/fixtures.js";
import { parseStatus, type RawStatus } from "../src/domain/tv.js";
import { createApp } from "../src/app.js";
import { getAuthStatus, login, logout } from "../src/electron/auth.js";

const BASE = "https://api.smartthings.com/v1";

const commandBody = (capability: string, command: string, args: unknown[] = []) =>
  JSON.stringify({ commands: [{ component: "main", capability, command, arguments: args }] });

describe("FakeCloud", () => {
  // Zero latency so unit tests run on real timers without waiting.
  let cloud: FakeCloud;

  beforeEach(() => {
    cloud = new FakeCloud(MOCK_DEVICES, () => 0);
  });

  const getStatus = async (id: string) => {
    const res = await cloud.handle(`${BASE}/devices/${id}/status`);
    expect(res.status).toBe(200);
    return parseStatus((await res.json()) as RawStatus);
  };

  it("lists the mock devices", async () => {
    const res = await cloud.handle(`${BASE}/devices`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { deviceId: string }[] };
    expect(body.items.map((d) => d.deviceId)).toEqual(["mock-tv-1", "mock-tv-2"]);
  });

  it("starts powered off with no input-source map, like a real TV", async () => {
    const status = await getStatus("mock-tv-1");
    expect(status.power).toBe("off");
    expect(status.inputCapability).toBeUndefined();
    expect(status.sources).toEqual([]);
  });

  it("switch:on persists and exposes each TV's own input capability", async () => {
    for (const [id, capability] of [
      ["mock-tv-1", "samsungvd.mediaInputSource"],
      ["mock-tv-2", "mediaInputSource"],
    ] as const) {
      const res = await cloud.handle(`${BASE}/devices/${id}/commands`, {
        method: "POST",
        body: commandBody("switch", "on"),
      });
      expect(res.status).toBe(200);
      const status = await getStatus(id);
      expect(status.power).toBe("on");
      expect(status.inputCapability).toBe(capability);
      expect(status.currentInput).toBe("dtv");
      expect(status.sources.some((s) => s.id === "HDMI2" && s.name === "PC")).toBe(true);
    }
  });

  it("setInputSource persists across status reads", async () => {
    await cloud.handle(`${BASE}/devices/mock-tv-1/commands`, {
      method: "POST",
      body: commandBody("switch", "on"),
    });
    await cloud.handle(`${BASE}/devices/mock-tv-1/commands`, {
      method: "POST",
      body: commandBody("samsungvd.mediaInputSource", "setInputSource", ["HDMI2"]),
    });
    expect((await getStatus("mock-tv-1")).currentInput).toBe("HDMI2");
  });

  it("404s on unknown devices and unknown routes", async () => {
    expect((await cloud.handle(`${BASE}/devices/nope/status`)).status).toBe(404);
    expect(
      (await cloud.handle(`${BASE}/devices/nope/commands`, { method: "POST", body: commandBody("switch", "on") }))
        .status,
    ).toBe(404);
    expect((await cloud.handle(`${BASE}/scenes`)).status).toBe(404);
  });
});

describe("mock-mode auth", () => {
  beforeEach(() => {
    process.env.SMARTTHINGS_MOCK = "1";
  });

  afterEach(() => {
    delete process.env.SMARTTHINGS_MOCK;
  });

  // The auth flag is module-level (dev/mock-cloud.ts) and persists across tests in the process, so
  // always leave it signed back in.
  afterEach(async () => {
    await login(null);
  });

  it("starts signed in; Sign out and Sign in flip the fake state without real OAuth", async () => {
    expect(await getAuthStatus()).toEqual({ hasClient: true, authorized: true });

    await logout();
    expect((await getAuthStatus()).authorized).toBe(false);

    // login(null) must not reach the OAuth window path (the stub BrowserWindow would throw on use).
    await expect(login(null)).resolves.toBeUndefined();
    expect((await getAuthStatus()).authorized).toBe(true);
  });

  it("hides cloud TVs when signed out; the LAN TV stays listed", async () => {
    // Signed in: both cloud TVs + the LAN TV list (mirrors RoutingTransport merging both sources).
    const signedIn = await makeMockTransport().listDevices();
    expect(signedIn.map((t) => t.deviceId)).toEqual([
      "mock-tv-1",
      "mock-tv-2",
      MOCK_LOCAL_DEVICE_ID,
    ]);

    await logout();
    // Signed out: only the local TV remains — cloud TVs need a signed-in account.
    const signedOut = await makeMockTransport().listDevices();
    expect(signedOut.map((t) => t.deviceId)).toEqual([MOCK_LOCAL_DEVICE_ID]);
    expect(signedOut.every((t) => t.source === "local")).toBe(true);
  });
});

describe("installMockCloud + createApp integration", () => {
  const realFetch = globalThis.fetch;
  let tmpDir: string;
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = mkdtempSync(join(tmpdir(), "mock-cloud-test-"));
    process.env.SMARTTHINGS_MOCK = "1";
    process.env.SMARTTHINGS_CONFIG_PATH = join(tmpDir, "smartthings-config.mock.json");
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = realFetch;
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SMARTTHINGS_MOCK;
    delete process.env.SMARTTHINGS_TOKEN;
    delete process.env.SMARTTHINGS_CONFIG_PATH;
  });

  it("fakes the token and seeds a turnkey mock config file", () => {
    installMockCloud();
    expect(process.env.SMARTTHINGS_TOKEN).toBe("mock-token");
    const configPath = process.env.SMARTTHINGS_CONFIG_PATH!;
    expect(existsSync(configPath)).toBe(true);
    const seed = JSON.parse(readFileSync(configPath, "utf8")) as {
      pcInput: string;
      selectedDeviceIds: string[];
      deviceConfigs: Record<string, { host?: string; wsToken?: string }>;
    };
    expect(seed.pcInput).toBe("HDMI2");
    // Two cloud TVs + the LAN TV are all preselected out of the box.
    expect(seed.selectedDeviceIds).toEqual([
      "mock-tv-1",
      "mock-tv-2",
      "local:aa:bb:cc:dd:ee:ff",
    ]);
    // The LAN TV is seeded as a paired local device (host + wsToken) so its per-TV tab works.
    expect(seed.deviceConfigs["local:aa:bb:cc:dd:ee:ff"]).toMatchObject({
      host: "10.0.0.42",
      wsToken: "mock-ws-token",
    });
  });

  it("drives the real wake + input-switch flow, with state persisting between actions", async () => {
    installMockCloud();
    const app = createApp();

    // TV starts off on "dtv": the full flow runs — power-on retry, re-read, input switch.
    const first = app.switch();
    await vi.runAllTimersAsync();
    await expect(first).resolves.toBe(true);
    expect(logs).toContain("TV is on.");
    expect(logs).toContain("Switching input to HDMI2 (PC)...");
    expect(logs).toContain("Done — TV is on and switched to PC.");

    // The fake cloud kept the state: a second switch finds the TV already on the PC input.
    const second = app.switch();
    await vi.runAllTimersAsync();
    await expect(second).resolves.toBe(true);
    expect(logs).toContain("Input is already on HDMI2.");

    // And off() sees it on the PC input, so it actually powers the TV off.
    const off = app.off();
    await vi.runAllTimersAsync();
    await expect(off).resolves.toBe(true);
    expect(logs).toContain("Done — TV turned off.");
  });
});
