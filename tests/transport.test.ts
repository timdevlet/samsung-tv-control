import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TVConfig } from "../src/domain/config.js";

// Drive createApp() against a mocked config to prove the routing transport seam. Cloud and local
// run side by side: RoutingTransport dispatches per deviceId (`local:<mac>` → LAN, a SmartThings
// UUID → cloud) and merges both device lists. The local path is config-driven and never resolves a
// token, so with no SMARTTHINGS_TOKEN / cloud credentials it works while the cloud half degrades
// gracefully rather than throwing.

let store: TVConfig;

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...actual,
    loadConfig: async () => ({ ...store }),
    saveConfig: async (config: TVConfig) => {
      store = config;
    },
  };
});

import { createApp } from "../src/app.js";

beforeEach(() => {
  // No token in the environment — the cloud path would fail; the local path must not need one.
  delete process.env.SMARTTHINGS_TOKEN;
  delete process.env.SMARTTHINGS_MOCK;
});

afterEach(() => vi.unstubAllGlobals());

describe("routing transport", () => {
  it("lists LAN TVs from config without resolving any cloud token", async () => {
    store = {
      pcInput: "HDMI2",
      deviceConfigs: { "local:tv": { host: "1.2.3.4", mac: "a0:b1:c2:d3:e4:f5", alias: "Living Room" } },
    };
    // A spy on fetch proves no cloud/token HTTP happens for the config-driven list — the cloud
    // half is only built when it can resolve a token, which it can't here.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const tvs = await createApp().listTVs();
    expect(tvs.map((t) => t.deviceId)).toEqual(["local:tv"]);
    expect(tvs.map((t) => t.source)).toEqual(["local"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("degrades to local-only when the cloud has no credentials (no longer throws)", async () => {
    // With cloud and local side by side, an unresolvable cloud client must not empty the list —
    // the local TVs still come back (this is the behavior the guard test used to forbid).
    store = {
      pcInput: "HDMI2",
      deviceConfigs: { "local:tv": { host: "1.2.3.4", mac: "a0:b1:c2:d3:e4:f5" } },
    };
    const tvs = await createApp().listTVs();
    expect(tvs.map((t) => t.deviceId)).toEqual(["local:tv"]);
  });

  it("returns an empty list (not an error) when there are no local TVs and no cloud creds", async () => {
    store = { pcInput: "HDMI2" };
    await expect(createApp().listTVs()).resolves.toEqual([]);
  });

  it("routes a command to a local:<id> TV over the LAN, never the cloud", async () => {
    store = {
      pcInput: "HDMI2",
      selectedDeviceIds: ["local:tv"],
      deviceConfigs: { "local:tv": { host: "1.2.3.4", mac: "a0:b1:c2:d3:e4:f5" } },
    };
    // fetch is used by both the cloud client AND LocalTV's power probe (http://host:8001). Stub it
    // so the LAN probe reports "off" and no request ever hits the SmartThings API base.
    const fetchSpy = vi.fn(async () => new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    // WoL would send a real UDP packet; powerOn throws before that only if mac is missing. Here we
    // just assert the off() flow (which reads status via the LAN probe) resolves and never calls
    // the SmartThings API — proving the local id routed to LocalTV.
    await createApp().off();
    const calledCloud = fetchSpy.mock.calls.some(([url]) =>
      String(url).startsWith("https://api.smartthings.com"),
    );
    expect(calledCloud).toBe(false);
  });

  it("leaves the input alone when a LAN TV is already on (blind keys would cycle it away)", async () => {
    store = {
      pcInput: "HDMI2",
      selectedDeviceIds: ["local:tv"],
      deviceConfigs: { "local:tv": { host: "1.2.3.4", mac: "a0:b1:c2:d3:e4:f5", wsToken: "tok" } },
    };
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    // The LAN power probe answers → the TV reports "on". Its input is unreadable over LAN, so
    // switch() must NOT open the remote WebSocket and send source keys (they move relative to the
    // current input — on the auto-wake path that cycles a TV already on PC away from it). If the
    // guard regressed, sendKeys would attempt a real wss:// connection here and time out.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(createApp().switch()).resolves.toBe(true);
    logSpy.mockRestore();
    expect(logs.some((l) => l.includes("leaving the input unchanged"))).toBe(true);
  });
});
