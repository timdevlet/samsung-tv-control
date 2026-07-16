// Local (LAN) transport: control the TV directly over the network — no Samsung account, no
// SmartThings cloud, works offline. Conforms to TVTransport so app.ts can use it interchangeably
// with the cloud client.
//
// Two protocols, both Samsung-native and account-free:
//   • Power ON  — Wake-on-LAN: a UDP "magic packet" (6×0xFF + the MAC ×16) broadcast on the LAN.
//                 The TV's NIC wakes the set. Requires the MAC and the TV's network-standby /
//                 "wake on wireless" setting enabled; deep-standby wake over WiFi is best-effort.
//   • Everything else — the Tizen remote WebSocket at wss://<host>:8002/... : send remote-key
//                 "Click" frames (KEY_POWER to power off, KEY_HDMI / a recorded key sequence to
//                 switch input). The first connection without a token pops an on-screen "Allow"
//                 on the TV and returns a token we persist (see pairTV()); later connections send
//                 it. The cert is self-signed, so TLS verification is disabled for this host.
//
// Honest limitations vs the cloud: the local protocol can report power only coarsely (the TV's
// info endpoint answering ⇒ on) and can't reliably read the current input — getStatus() returns
// a synthetic input capability so app.ts's switch flow proceeds, and offOne()'s best-effort path
// (src/app.ts) powers off when the input is unknowable.

import { createSocket } from "node:dgram";
import WebSocket from "ws";
import { canonicalizeMac, type DeviceConfig, type TVConfig } from "../domain/config.js";
import { isTV, pickTV, LOCAL_INPUT_CAPABILITY, type STDevice, type TVStatus } from "../domain/tv.js";
import type { TVTransport } from "./transport.js";
import { log } from "../log.js";

// A stable synthetic deviceId for a LAN TV (there is no cloud UUID). Keyed by MAC so it survives
// a DHCP address change; falls back to host when no MAC is set yet.
export function localDeviceId(cfg: Pick<DeviceConfig, "mac" | "host">): string {
  const mac = cfg.mac ? canonicalizeMac(cfg.mac) : "";
  return `local:${mac || cfg.host || "unknown"}`;
}

// Minimal structural WebSocket type — the runtime global (Node 22 / Electron) provides the impl,
// but our tsconfig doesn't include the DOM lib, so we declare only what we use and inject the
// constructor (real global in prod, a fake in tests).
export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (ev: unknown) => void): void;
}
export type WebSocketFactory = (url: string) => MinimalWebSocket;

// Send a Wake-on-LAN magic packet for `mac`, broadcast to port 9. `send` is injectable for tests.
export async function sendWakeOnLan(
  mac: string,
  broadcast = "255.255.255.255",
  port = 9,
  send: (packet: Buffer, port: number, address: string) => Promise<void> = defaultUdpSend,
): Promise<void> {
  const canonical = canonicalizeMac(mac);
  if (!canonical) throw new Error(`Invalid MAC address "${mac}" — can't send Wake-on-LAN.`);
  const bytes = canonical.split(":").map((h) => parseInt(h, 16));
  // 6 bytes of 0xFF, then the 6-byte MAC repeated 16 times = 102 bytes.
  const packet = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) packet.set(bytes, 6 + i * 6);
  await send(packet, port, broadcast);
}

// Default UDP sender: a one-shot broadcast socket.
function defaultUdpSend(packet: Buffer, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, port, address, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// The remote-control WebSocket URL. `name` is a base64 app name the TV shows in its device list;
// `token` (once paired) authorizes without re-prompting.
export function remoteUrl(host: string, token?: string): string {
  const name = Buffer.from("Samsung TV PC Control").toString("base64");
  const base = `wss://${host}:8002/api/v2/channels/samsung.remote.control?name=${name}`;
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

// A single remote-key "Click" frame.
export function keyFrame(key: string): string {
  return JSON.stringify({
    method: "ms.remote.control",
    params: { Cmd: "Click", DataOfCmd: key, Option: "false", TypeOfRemote: "SendRemoteKey" },
  });
}

interface ConnectResult {
  send(key: string): Promise<void>;
  close(): void;
  // The token the TV returns on the ms.channel.connect handshake (present on first pair).
  token?: string;
}

// Open the remote WebSocket and resolve once the TV accepts the connection (ms.channel.connect).
// Rejects on error or if the handshake doesn't arrive within `timeoutMs` (the user hasn't tapped
// "Allow"). `wsFactory` is injectable for tests.
export function connectRemote(
  host: string,
  token: string | undefined,
  wsFactory: WebSocketFactory = defaultWsFactory,
  timeoutMs = 30_000,
): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const ws = wsFactory(remoteUrl(host, token));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error("Timed out waiting for the TV — accept the on-screen “Allow” prompt and retry."));
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    ws.addEventListener("message", (ev) => {
      const data = (ev as { data?: unknown }).data;
      let msg: { event?: string; data?: { token?: string } };
      try {
        msg = JSON.parse(String(data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.event === "ms.channel.connect") {
        const newToken = msg.data?.token;
        finish(() =>
          resolve({
            token: newToken,
            send: (key: string) =>
              new Promise<void>((res) => {
                ws.send(keyFrame(key));
                // The remote channel doesn't ack key clicks; give the TV a beat to act.
                setTimeout(res, 200);
              }),
            close: () => ws.close(),
          }),
        );
      } else if (msg.event === "ms.channel.unauthorized") {
        finish(() => {
          ws.close();
          reject(new Error("The TV denied the connection — re-pair from Settings."));
        });
      } else if (msg.event === "ms.channel.timeOut") {
        // The TV showed the Allow prompt but it wasn't accepted in time (it sends this instead of
        // waiting the full client timeout). Fail fast with the actionable message.
        finish(() => {
          ws.close();
          reject(new Error("The TV's “Allow” prompt wasn't accepted in time — turn the TV on, click Pair, and accept it on screen."));
        });
      }
    });
    ws.addEventListener("error", () => finish(() => reject(new Error(`Couldn't reach the TV at ${host}.`))));
    ws.addEventListener("close", () => finish(() => reject(new Error(`Connection to ${host} closed before it was ready.`))));
  });
}

// One-time pairing: connect without a token (pops the on-screen Allow), return the token the TV
// issues. Used by the tv:pair IPC (src/electron/main.ts), not by command handling.
export async function pairWithTV(
  host: string,
  wsFactory: WebSocketFactory = defaultWsFactory,
  timeoutMs = 30_000,
): Promise<string> {
  const conn = await connectRemote(host, undefined, wsFactory, timeoutMs);
  conn.close();
  if (!conn.token) throw new Error("The TV accepted the connection but returned no token — try re-pairing.");
  return conn.token;
}

// The real WebSocket, via the `ws` package. The Samsung TV serves the remote channel over TLS
// with a self-signed cert, so verification must be disabled per-connection — and Node's *global*
// (undici) WebSocket silently ignores any options argument, so it can't skip the cert check
// (connecting to wss://…:8002 there fails with a bare "network error"). The `ws` package honors
// { rejectUnauthorized: false } and implements the same addEventListener interface we use.
function defaultWsFactory(url: string): MinimalWebSocket {
  return new WebSocket(url, { rejectUnauthorized: false }) as unknown as MinimalWebSocket;
}

// Probe the TV's info endpoint to infer power/reachability. Answers ⇒ on; refused/timeout ⇒ off.
async function probePower(host: string): Promise<"on" | "off"> {
  try {
    const res = await fetch(`http://${host}:8001/api/v2/`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? "on" : "off";
  } catch {
    return "off";
  }
}

export class LocalTV implements TVTransport {
  constructor(
    private readonly config: TVConfig,
    private readonly wsFactory: WebSocketFactory = defaultWsFactory,
  ) {}

  private deviceConfig(deviceId: string): DeviceConfig {
    const cfg = this.config.deviceConfigs?.[deviceId];
    if (!cfg?.host) throw new Error(`TV ${deviceId} has no LAN address configured — set its host in Settings.`);
    return cfg;
  }

  async getStatus(deviceId: string): Promise<TVStatus> {
    const cfg = this.deviceConfig(deviceId);
    const power = await probePower(cfg.host!);
    // Synthetic capability so app.ts's switchOne() proceeds; input isn't readable over LAN, so
    // currentInput/sources stay empty and offOne()'s best-effort path handles the off case.
    return { power, inputCapability: LOCAL_INPUT_CAPABILITY, currentInput: undefined, sources: [] };
  }

  async powerOn(deviceId: string): Promise<void> {
    const cfg = this.deviceConfig(deviceId);
    if (!cfg.mac) throw new Error(`TV ${deviceId} has no MAC address — Wake-on-LAN can't power it on.`);
    log(`Sending Wake-on-LAN to ${cfg.mac}...`);
    await sendWakeOnLan(cfg.mac);
  }

  async powerOff(deviceId: string): Promise<void> {
    await this.sendKeys(deviceId, ["KEY_POWER"]);
  }

  async setInputSource(deviceId: string, _capability: string, source: string): Promise<void> {
    const cfg = this.deviceConfig(deviceId);
    // Prefer a recorded key sequence when the user configured one (there's no authoritative
    // "set HDMI2" over the remote protocol); otherwise send a single source key.
    const keys = cfg.inputKeySeq
      ? cfg.inputKeySeq.split(",").map((k) => k.trim()).filter(Boolean)
      : [defaultInputKey(source)];
    await this.sendKeys(deviceId, keys);
  }

  // Open one WS, send the keys in order, close it.
  private async sendKeys(deviceId: string, keys: string[]): Promise<void> {
    const cfg = this.deviceConfig(deviceId);
    const conn = await connectRemote(cfg.host!, cfg.wsToken, this.wsFactory);
    try {
      for (const key of keys) await conn.send(key);
    } finally {
      conn.close();
    }
  }

  // A LAN "device list" is config-driven — there's no account to enumerate. Each deviceConfigs
  // entry with a host becomes a TV. capabilities include the synthetic input cap so isTV()
  // recognizes it and app.ts treats it like an input-capable device.
  async listDevices(): Promise<STDevice[]> {
    const entries = Object.entries(this.config.deviceConfigs ?? {}).filter(([, c]) => c.host);
    return entries.map(([deviceId, cfg]) => ({
      deviceId,
      label: cfg.alias || cfg.host || deviceId,
      name: cfg.host ?? "",
      capabilities: ["switch", LOCAL_INPUT_CAPABILITY],
    }));
  }

  async listTVs(): Promise<STDevice[]> {
    return (await this.listDevices()).filter(isTV);
  }

  async findTV(): Promise<STDevice | null> {
    return pickTV(await this.listDevices());
  }
}

// Map a resolved input id to the single remote key that best reaches it. HDMI inputs share
// KEY_HDMI (cycles); anything else falls back to the generic source key. A user who needs a
// specific HDMI configures inputKeySeq instead.
function defaultInputKey(source: string): string {
  return /^hdmi/i.test(source) ? "KEY_HDMI" : "KEY_SOURCE";
}
