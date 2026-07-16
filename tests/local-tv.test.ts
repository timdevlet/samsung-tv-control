import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sendWakeOnLan,
  keyFrame,
  remoteUrl,
  connectRemote,
  localDeviceId,
  LocalTV,
  type MinimalWebSocket,
} from "../src/api/local-tv.js";
import { canonicalizeMac } from "../src/domain/config.js";
import type { TVConfig } from "../src/domain/config.js";

// A scriptable fake WebSocket: capture sent frames, and let the test drive open/message/close.
class FakeWS implements MinimalWebSocket {
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, ev?: unknown): void {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
  // Simulate the TV accepting the connection, optionally handing back a pairing token.
  accept(token?: string): void {
    this.emit("message", { data: JSON.stringify({ event: "ms.channel.connect", data: { token } }) });
  }
}

afterEach(() => vi.useRealTimers());

describe("canonicalizeMac", () => {
  it("normalizes separators and case to colon-lowercase", () => {
    expect(canonicalizeMac("A0-B1-C2-D3-E4-F5")).toBe("a0:b1:c2:d3:e4:f5");
    expect(canonicalizeMac("a0b1c2d3e4f5")).toBe("a0:b1:c2:d3:e4:f5");
  });
  it("returns '' for anything that isn't 12 hex digits", () => {
    expect(canonicalizeMac("not-a-mac")).toBe("");
    expect(canonicalizeMac("a0:b1:c2")).toBe("");
  });
});

describe("sendWakeOnLan", () => {
  it("builds a 102-byte magic packet: 6×0xFF then the MAC ×16, broadcast to port 9", async () => {
    let captured: { packet: Buffer; port: number; address: string } | undefined;
    await sendWakeOnLan("a0:b1:c2:d3:e4:f5", "255.255.255.255", 9, async (packet, port, address) => {
      captured = { packet, port, address };
    });
    expect(captured).toBeDefined();
    const { packet, port, address } = captured!;
    expect(packet.length).toBe(102);
    expect([...packet.subarray(0, 6)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    // First MAC repeat right after the 0xFF header.
    expect([...packet.subarray(6, 12)]).toEqual([0xa0, 0xb1, 0xc2, 0xd3, 0xe4, 0xf5]);
    // Last (16th) repeat lands at the end.
    expect([...packet.subarray(96, 102)]).toEqual([0xa0, 0xb1, 0xc2, 0xd3, 0xe4, 0xf5]);
    expect(port).toBe(9);
    expect(address).toBe("255.255.255.255");
  });
  it("rejects an invalid MAC without sending", async () => {
    const send = vi.fn();
    await expect(sendWakeOnLan("nope", "255.255.255.255", 9, send)).rejects.toThrow(/Invalid MAC/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("keyFrame / remoteUrl", () => {
  it("wraps a key as a SendRemoteKey Click frame", () => {
    expect(JSON.parse(keyFrame("KEY_POWER"))).toEqual({
      method: "ms.remote.control",
      params: { Cmd: "Click", DataOfCmd: "KEY_POWER", Option: "false", TypeOfRemote: "SendRemoteKey" },
    });
  });
  it("appends the token to the wss URL only when present", () => {
    expect(remoteUrl("1.2.3.4")).toMatch(/^wss:\/\/1\.2\.3\.4:8002\/api\/v2\/channels\/samsung\.remote\.control\?name=/);
    expect(remoteUrl("1.2.3.4")).not.toContain("token=");
    expect(remoteUrl("1.2.3.4", "tok en")).toContain("token=tok%20en");
  });
});

describe("connectRemote", () => {
  it("resolves with the handshake token and can send keys", async () => {
    const ws = new FakeWS();
    const p = connectRemote("1.2.3.4", undefined, () => ws);
    ws.accept("issued-token");
    const conn = await p;
    expect(conn.token).toBe("issued-token");
    await conn.send("KEY_HDMI");
    expect(ws.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_HDMI"]);
  });
  it("rejects when the TV denies the connection", async () => {
    const ws = new FakeWS();
    const p = connectRemote("1.2.3.4", undefined, () => ws);
    ws.emit("message", { data: JSON.stringify({ event: "ms.channel.unauthorized" }) });
    await expect(p).rejects.toThrow(/denied/);
  });
  it("times out when the popup is never accepted", async () => {
    vi.useFakeTimers();
    const ws = new FakeWS();
    const p = connectRemote("1.2.3.4", undefined, () => ws, 30_000);
    const assertion = expect(p).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});

describe("localDeviceId", () => {
  it("keys by canonical MAC, falling back to host", () => {
    expect(localDeviceId({ mac: "A0-B1-C2-D3-E4-F5" })).toBe("local:a0:b1:c2:d3:e4:f5");
    expect(localDeviceId({ host: "1.2.3.4" })).toBe("local:1.2.3.4");
  });
});

describe("LocalTV", () => {
  const config: TVConfig = {
    pcInput: "HDMI2",
    transportMode: "local",
    deviceConfigs: {
      "local:tv": { host: "1.2.3.4", mac: "a0:b1:c2:d3:e4:f5", wsToken: "stored-token" },
    },
  };

  it("powerOff sends KEY_POWER over an authorized WS", async () => {
    const ws = new FakeWS();
    const factory = (url: string) => {
      expect(url).toContain("token=stored-token");
      queueMicrotask(() => ws.accept());
      return ws;
    };
    await new LocalTV(config, factory).powerOff("local:tv");
    expect(ws.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_POWER"]);
    expect(ws.closed).toBe(true);
  });

  it("setInputSource replays a configured key sequence", async () => {
    const seqConfig: TVConfig = {
      ...config,
      deviceConfigs: { "local:tv": { ...config.deviceConfigs!["local:tv"], inputKeySeq: "KEY_HDMI,KEY_HDMI" } },
    };
    const ws = new FakeWS();
    await new LocalTV(seqConfig, () => {
      queueMicrotask(() => ws.accept());
      return ws;
    }).setInputSource("local:tv", "local.remoteKey", "HDMI2");
    expect(ws.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_HDMI", "KEY_HDMI"]);
  });

  it("getStatus reports on when the info endpoint answers, off when it doesn't", async () => {
    const localTv = new LocalTV(config);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    let status = await localTv.getStatus("local:tv");
    expect(status.power).toBe("on");
    expect(status.inputCapability).toBe("local.remoteKey");
    expect(status.sources).toEqual([]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    status = await localTv.getStatus("local:tv");
    expect(status.power).toBe("off");
    vi.unstubAllGlobals();
  });

  it("listTVs is config-driven and recognizes the LAN device as a TV", async () => {
    const tvs = await new LocalTV(config).listTVs();
    expect(tvs).toHaveLength(1);
    expect(tvs[0].deviceId).toBe("local:tv");
    expect(tvs[0].capabilities).toContain("local.remoteKey");
  });

  it("powerOn throws a clear error when no MAC is set", async () => {
    const noMac: TVConfig = { pcInput: "HDMI2", deviceConfigs: { "local:tv": { host: "1.2.3.4" } } };
    await expect(new LocalTV(noMac).powerOn("local:tv")).rejects.toThrow(/MAC/);
  });
});
