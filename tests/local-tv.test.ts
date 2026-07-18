import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sendWakeOnLan,
  keyFrame,
  remoteUrl,
  connectRemote,
  localDeviceId,
  pairWithTV,
  normalizeRemoteKey,
  parseKeySequence,
  keyDelayMs,
  LocalTV,
  closeAllRemoteConnections,
  type MinimalWebSocket,
} from "../src/api/local-tv.js";
import { canonicalizeMac, NO_TOKEN_PAIRED } from "../src/domain/config.js";
import type { TVConfig } from "../src/domain/config.js";
import { isTV } from "../src/domain/tv.js";

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

afterEach(() => {
  vi.useRealTimers();
  // Connections are pooled process-wide (keyed by host+token); drop them so each case starts fresh.
  closeAllRemoteConnections();
});

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

describe("pairWithTV", () => {
  it("returns the token the TV issues", async () => {
    const ws = new FakeWS();
    const p = pairWithTV("1.2.3.4", () => ws);
    ws.accept("issued-token");
    expect(await p).toBe("issued-token");
    expect(ws.closed).toBe(true);
  });
  it("returns the NO_TOKEN_PAIRED sentinel when the TV accepts but sends no token", async () => {
    // Some Samsung models authorize by name/IP and never hand back a token — still a valid pair.
    const ws = new FakeWS();
    const p = pairWithTV("1.2.3.4", () => ws);
    ws.accept(); // no token in the handshake
    expect(await p).toBe(NO_TOKEN_PAIRED);
  });
});

describe("localDeviceId", () => {
  it("keys by canonical MAC, falling back to host", () => {
    expect(localDeviceId({ mac: "A0-B1-C2-D3-E4-F5" })).toBe("local:a0:b1:c2:d3:e4:f5");
    expect(localDeviceId({ host: "1.2.3.4" })).toBe("local:1.2.3.4");
  });
});

describe("normalizeRemoteKey", () => {
  it("passes an explicit KEY_ through, upper-cased", () => {
    expect(normalizeRemoteKey("key_enter")).toBe("KEY_ENTER");
    expect(normalizeRemoteKey("KEY_HDMI2")).toBe("KEY_HDMI2");
  });
  it("maps numbered/bare HDMI and the 'pc' alias like an input name", () => {
    expect(normalizeRemoteKey("hdmi2")).toBe("KEY_HDMI2");
    expect(normalizeRemoteKey("HDMI")).toBe("KEY_HDMI");
    expect(normalizeRemoteKey("pc")).toBe("KEY_HDMI2");
  });
  it("turns a bare directional/name token into its KEY_ form (unlike defaultInputKey)", () => {
    expect(normalizeRemoteKey("UP")).toBe("KEY_UP");
    expect(normalizeRemoteKey("left")).toBe("KEY_LEFT");
    expect(normalizeRemoteKey("volup")).toBe("KEY_VOLUP");
  });
  it("returns '' for a blank token", () => {
    expect(normalizeRemoteKey("   ")).toBe("");
  });
});

describe("parseKeySequence", () => {
  it("splits, trims, normalizes, and drops blanks", () => {
    expect(parseKeySequence("HDMI, UP, UP, UP, LEFT, DOWN")).toEqual([
      "KEY_HDMI",
      "KEY_UP",
      "KEY_UP",
      "KEY_UP",
      "KEY_LEFT",
      "KEY_DOWN",
    ]);
    // Trailing/empty segments and stray whitespace are dropped.
    expect(parseKeySequence("KEY_ENTER, , ,")).toEqual(["KEY_ENTER"]);
    expect(parseKeySequence("")).toEqual([]);
  });
});

describe("keyDelayMs", () => {
  it("converts seconds to ms, clamping to the 5s cap", () => {
    expect(keyDelayMs({ keyDelay: 2 })).toBe(2000);
    expect(keyDelayMs({ keyDelay: 0.5 })).toBe(500);
    expect(keyDelayMs({ keyDelay: 99 })).toBe(5000);
  });
  it("returns 0 for unset/zero/negative/junk raw-config values", () => {
    // The daemon consumes raw loadConfig() output, so hand-edited junk must fall back safely.
    expect(keyDelayMs({})).toBe(0);
    expect(keyDelayMs({ keyDelay: 0 })).toBe(0);
    expect(keyDelayMs({ keyDelay: -1 })).toBe(0);
    expect(keyDelayMs({ keyDelay: "abc" as unknown as number })).toBe(0);
  });
});

describe("LocalTV", () => {
  const config: TVConfig = {
    pcInput: "HDMI2",
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
    // The socket is pooled for reuse now, not closed after the send.
    expect(ws.closed).toBe(false);
  });

  it("connects without a token when the stored wsToken is the NO_TOKEN_PAIRED sentinel", async () => {
    const sentinelConfig: TVConfig = {
      ...config,
      deviceConfigs: { "local:tv": { ...config.deviceConfigs!["local:tv"], wsToken: NO_TOKEN_PAIRED } },
    };
    const ws = new FakeWS();
    const factory = (url: string) => {
      expect(url).not.toContain("token=");
      queueMicrotask(() => ws.accept());
      return ws;
    };
    await new LocalTV(sentinelConfig, factory).powerOff("local:tv");
    expect(ws.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_POWER"]);
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

  it("setInputSource without a configured sequence sends the direct HDMI key for a numbered input", async () => {
    const ws = new FakeWS();
    await new LocalTV(config, () => {
      queueMicrotask(() => ws.accept());
      return ws;
    }).setInputSource("local:tv", "local.remoteKey", "HDMI2");
    // Direct key jumps straight to HDMI2 instead of cycling with a single KEY_HDMI.
    expect(ws.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_HDMI2"]);
  });

  it("setInputSource falls back to KEY_SOURCE for a non-HDMI input", async () => {
    const ws = new FakeWS();
    await new LocalTV(config, () => {
      queueMicrotask(() => ws.accept());
      return ws;
    }).setInputSource("local:tv", "local.remoteKey", "TV");
    expect(ws.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_SOURCE"]);
  });

  it("setInputSource maps the friendly 'pc' alias to its HDMI key", async () => {
    const ws = new FakeWS();
    await new LocalTV(config, () => {
      queueMicrotask(() => ws.accept());
      return ws;
    }).setInputSource("local:tv", "local.remoteKey", "pc");
    // "PC" has no direct KEY_ and no LAN source map to resolve it, so it aliases to the
    // conventional PC port (HDMI2) instead of just opening the source menu.
    expect(ws.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_HDMI2"]);
  });

  it("setInputSource sends a custom KEY_ value through unchanged", async () => {
    const ws = new FakeWS();
    await new LocalTV(config, () => {
      queueMicrotask(() => ws.accept());
      return ws;
    }).setInputSource("local:tv", "local.remoteKey", "key_hdmi3");
    // A custom input typed as a raw remote key is normalized to upper case and sent as-is.
    expect(ws.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_HDMI3"]);
  });

  it("sendKeys sends an explicit key list in order over one authorized WS, kept open for reuse", async () => {
    const ws = new FakeWS();
    const factory = (url: string) => {
      expect(url).toContain("token=stored-token");
      queueMicrotask(() => ws.accept());
      return ws;
    };
    await new LocalTV(config, factory).sendKeys("local:tv", ["KEY_HDMI", "KEY_UP", "KEY_LEFT"]);
    expect(ws.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_HDMI", "KEY_UP", "KEY_LEFT"]);
    // Not closed — the connection is pooled so the next press skips the handshake.
    expect(ws.closed).toBe(false);
  });

  it("sendKeys reuses one pooled connection across presses (no reconnect per key)", async () => {
    const ws = new FakeWS();
    let opens = 0;
    const factory = () => {
      opens++;
      queueMicrotask(() => ws.accept());
      return ws;
    };
    const tv = new LocalTV(config, factory);
    await tv.sendKeys("local:tv", ["KEY_VOLUP"]);
    await tv.sendKeys("local:tv", ["KEY_VOLUP"]);
    await tv.sendKeys("local:tv", ["KEY_VOLUP"]);
    // One handshake total; every subsequent press is just a frame on the same socket.
    expect(opens).toBe(1);
    expect(ws.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_VOLUP", "KEY_VOLUP", "KEY_VOLUP"]);
  });

  it("sendKeys reconnects when the pooled socket has dropped", async () => {
    const first = new FakeWS();
    const second = new FakeWS();
    const sockets = [first, second];
    let opens = 0;
    const factory = () => {
      const ws = sockets[opens++];
      queueMicrotask(() => ws.accept());
      return ws;
    };
    const tv = new LocalTV(config, factory);
    await tv.sendKeys("local:tv", ["KEY_UP"]);
    // The TV slept — the socket closes and the pool evicts it.
    first.emit("close");
    await tv.sendKeys("local:tv", ["KEY_DOWN"]);
    expect(opens).toBe(2);
    expect(first.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_UP"]);
    expect(second.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_DOWN"]);
  });

  it("sendKeys waits the TV's keyDelay between keys, but not after the last", async () => {
    const delayedConfig: TVConfig = {
      ...config,
      deviceConfigs: { "local:tv": { ...config.deviceConfigs!["local:tv"], keyDelay: 2 } },
    };
    const ws = new FakeWS();
    const delays: number[] = [];
    const fakeSleep = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    await new LocalTV(delayedConfig, () => {
      queueMicrotask(() => ws.accept());
      return ws;
    }, fakeSleep).sendKeys("local:tv", ["KEY_HDMI", "KEY_UP", "KEY_LEFT"]);
    expect(ws.sent.map((s) => JSON.parse(s).params.DataOfCmd)).toEqual(["KEY_HDMI", "KEY_UP", "KEY_LEFT"]);
    expect(delays).toEqual([2000, 2000]);
  });

  it("sendKeys adds no extra wait when keyDelay is unset", async () => {
    const ws = new FakeWS();
    const delays: number[] = [];
    const fakeSleep = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    await new LocalTV(config, () => {
      queueMicrotask(() => ws.accept());
      return ws;
    }, fakeSleep).sendKeys("local:tv", ["KEY_HDMI", "KEY_UP"]);
    expect(delays).toEqual([]);
  });

  it("sendKeys clamps a hand-edited out-of-range keyDelay to 5s", async () => {
    const delayedConfig: TVConfig = {
      ...config,
      deviceConfigs: { "local:tv": { ...config.deviceConfigs!["local:tv"], keyDelay: 99 } },
    };
    const ws = new FakeWS();
    const delays: number[] = [];
    const fakeSleep = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    await new LocalTV(delayedConfig, () => {
      queueMicrotask(() => ws.accept());
      return ws;
    }, fakeSleep).sendKeys("local:tv", ["KEY_HDMI", "KEY_UP"]);
    expect(delays).toEqual([5000]);
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

  it("listDevices is config-driven and the LAN device passes the isTV filter", async () => {
    const tvs = (await new LocalTV(config).listDevices()).filter(isTV);
    expect(tvs).toHaveLength(1);
    expect(tvs[0].deviceId).toBe("local:tv");
    expect(tvs[0].capabilities).toContain("local.remoteKey");
  });

  it("powerOn throws a clear error when no MAC is set", async () => {
    const noMac: TVConfig = { pcInput: "HDMI2", deviceConfigs: { "local:tv": { host: "1.2.3.4" } } };
    await expect(new LocalTV(noMac).powerOn("local:tv")).rejects.toThrow(/MAC/);
  });
});
