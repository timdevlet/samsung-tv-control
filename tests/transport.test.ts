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

// Fake the `ws` package so LocalTV's remote WebSocket never dials a real TV. Each construction
// records itself in `wsFakes.instances`, accepts the connection on the next microtask (after
// connectRemote has attached its listeners), and records every key frame sent.
const wsFakes = vi.hoisted(() => ({
  instances: [] as { url: string; sent: string[]; closed: boolean }[],
}));

vi.mock("ws", () => {
  class FakeWS {
    sent: string[] = [];
    closed = false;
    private listeners: Record<string, ((ev: unknown) => void)[]> = {};
    constructor(readonly url: string) {
      wsFakes.instances.push(this);
      queueMicrotask(() => {
        for (const fn of this.listeners["message"] ?? []) {
          fn({ data: JSON.stringify({ event: "ms.channel.connect", data: {} }) });
        }
      });
    }
    addEventListener(type: string, fn: (ev: unknown) => void): void {
      (this.listeners[type] ??= []).push(fn);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.closed = true;
    }
  }
  return { default: FakeWS };
});

import { createApp } from "../src/app.js";
import { closeAllRemoteConnections } from "../src/api/local-tv.js";

// The remote keys a fake WS received, in order.
const sentKeys = (ws: { sent: string[] }): string[] =>
  ws.sent.map((s) => (JSON.parse(s) as { params: { DataOfCmd: string } }).params.DataOfCmd);

beforeEach(() => {
  // No token in the environment — the cloud path would fail; the local path must not need one.
  delete process.env.SMARTTHINGS_TOKEN;
  delete process.env.SMARTTHINGS_MOCK;
  wsFakes.instances.length = 0;
  // Remote connections are pooled process-wide and kept open for reuse — drop any a prior case left
  // behind so each test opens (and counts) its own fresh WebSocket.
  closeAllRemoteConnections();
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

  it("auto trigger leaves an already-on LAN TV's input alone (blind keys would cycle it away)", async () => {
    store = {
      pcInput: "HDMI2",
      selectedDeviceIds: ["local:tv"],
      deviceConfigs: { "local:tv": { host: "1.2.3.4", mac: "a0:b1:c2:d3:e4:f5", wsToken: "tok" } },
    };
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    // The LAN power probe answers → the TV reports "on". Its input is unreadable over LAN, so an
    // AUTOMATIC switch (wake-on-resume/boot) must NOT open the remote WebSocket and send source
    // keys — they move relative to the current input, and on the auto-wake path the TV is almost
    // certainly already on the PC input, so blind keys would cycle it away.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(createApp().switch(undefined, undefined, { auto: true })).resolves.toBe(true);
    logSpy.mockRestore();
    expect(logs.some((l) => l.includes("leaving the input unchanged"))).toBe(true);
    expect(wsFakes.instances).toHaveLength(0);
  });

  it("manual trigger sends the input keys to an already-on LAN TV (its input can't be read)", async () => {
    store = {
      pcInput: "HDMI2",
      selectedDeviceIds: ["local:tv"],
      deviceConfigs: { "local:tv": { host: "1.2.3.4", mac: "a0:b1:c2:d3:e4:f5", wsToken: "tok" } },
    };
    // TV reports "on" via the LAN probe. A user-initiated switch (hotkey/tray/button — the
    // default, no `auto`) is an explicit ask to reach the PC input, so the keys must go out even
    // though the current input is unreadable over LAN.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(createApp().switch()).resolves.toBe(true);
    expect(wsFakes.instances).toHaveLength(1);
    // pcInput "HDMI2" maps to the direct key (jumps straight there) rather than a cycling KEY_HDMI.
    expect(sentKeys(wsFakes.instances[0])).toEqual(["KEY_HDMI2"]);
    // The connection is pooled for reuse now, not closed after the send.
    expect(wsFakes.instances[0].closed).toBe(false);
  });

  it("sendKeys routes a normalized sequence to a local:<id> TV over the LAN, never the cloud", async () => {
    store = {
      pcInput: "HDMI2",
      deviceConfigs: { "local:tv": { host: "1.2.3.4", mac: "a0:b1:c2:d3:e4:f5", wsToken: "tok" } },
    };
    const fetchSpy = vi.fn(async () => new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    // Raw tokens (as the IPC layer forwards them) are normalized to KEY_* by app.sendKeys and sent
    // in order over one LAN WebSocket.
    await expect(createApp().sendKeys("local:tv", ["HDMI", "UP", "LEFT"])).resolves.toBe(true);
    expect(wsFakes.instances).toHaveLength(1);
    expect(sentKeys(wsFakes.instances[0])).toEqual(["KEY_HDMI", "KEY_UP", "KEY_LEFT"]);
    // Pooled for reuse — not closed after the send.
    expect(wsFakes.instances[0].closed).toBe(false);
    const calledCloud = fetchSpy.mock.calls.some(([url]) =>
      String(url).startsWith("https://api.smartthings.com"),
    );
    expect(calledCloud).toBe(false);
  });

  it("sendKeys no-ops (false, no WS) when the sequence is empty or all blank", async () => {
    store = { pcInput: "HDMI2", deviceConfigs: { "local:tv": { host: "1.2.3.4", wsToken: "tok" } } };
    await expect(createApp().sendKeys("local:tv", ["  ", ""])).resolves.toBe(false);
    expect(wsFakes.instances).toHaveLength(0);
  });

  it("sendKeys to a cloud (SmartThings UUID) id rejects — no raw-key channel over the cloud", async () => {
    // A signed-in cloud client so the id routes to SmartThings (which throws for sendKeys) rather
    // than failing on token resolution.
    store = {
      pcInput: "HDMI2",
      clientId: "cid",
      clientSecret: "secret",
      refreshToken: "rt",
      accessToken: "at",
      accessTokenExpiresAt: Date.now() + 3_600_000,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(
      createApp().sendKeys("11111111-2222-3333-4444-555555555555", ["KEY_UP"]),
    ).rejects.toThrow(/cloud|SmartThings|isn't supported/i);
    expect(wsFakes.instances).toHaveLength(0);
  });

  it("a manual switch reaches EVERY selected TV, not just one", async () => {
    // Two LAN TVs, both already on. Each must get its own remote connection and its own keys —
    // TV b's recorded key sequence, TV a's direct-HDMI key (from pcInput "HDMI2").
    store = {
      pcInput: "HDMI2",
      selectedDeviceIds: ["local:a", "local:b"],
      deviceConfigs: {
        "local:a": { host: "1.1.1.1", wsToken: "tok-a" },
        "local:b": { host: "2.2.2.2", wsToken: "tok-b", inputKeySeq: "KEY_SOURCE,KEY_ENTER" },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(createApp().switch()).resolves.toBe(true);
    const byHost = new Map(wsFakes.instances.map((w) => [new URL(w.url).hostname, w]));
    expect([...byHost.keys()].sort()).toEqual(["1.1.1.1", "2.2.2.2"]);
    expect(sentKeys(byHost.get("1.1.1.1")!)).toEqual(["KEY_HDMI2"]);
    expect(sentKeys(byHost.get("2.2.2.2")!)).toEqual(["KEY_SOURCE", "KEY_ENTER"]);
  });
});
