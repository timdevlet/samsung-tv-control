import { parseStatus, mainCapabilities } from "../domain/tv.js";
import type { STDevice, TVStatus, RawStatus, RawDevice } from "../domain/tv.js";
import type { TVTransport } from "./transport.js";
import { log } from "../log.js";

const BASE = "https://api.smartthings.com/v1";

// A short human-readable reason for a rejected fetch. Undici wraps DNS/connect errors in a
// generic "fetch failed" TypeError with the real code on `cause` (ENOTFOUND, ECONNREFUSED,
// ENETUNREACH, ...); an AbortSignal timeout surfaces as a TimeoutError.
export function fetchErrorDetail(err: unknown): string {
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code) return cause.code;
  if (err instanceof Error) return err.name === "Error" ? err.message : `${err.name}: ${err.message}`;
  return String(err);
}

// Minimal SmartThings REST client (cloud control — no LAN access needed). Conforms to TVTransport
// so app.ts can swap in a LAN transport without knowing which one it holds.
export class SmartThings implements TVTransport {
  constructor(private readonly token: string) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const method = init?.method ?? "GET";
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // fetch rejects without ever producing an HTTP status when the request can't complete —
      // DNS/connect errors while the network is still down right after resume, or the 15s
      // timeout. Log it in the same "SmartThings API ..." shape as responses so a failed call
      // is visible in the logs, and rethrow with the request context attached.
      const detail = fetchErrorDetail(err);
      log(`SmartThings API ${method} ${path} → network error (${detail})`);
      throw new Error(`SmartThings API ${method} ${path} failed: ${detail}`);
    }
    // Read the body once (a Response can only be consumed a single time) — reused for both logging
    // and parsing below. Log only the outcome: the HTTP status plus "ok", since a status response
    // is multiple KB of JSON we don't want dumped on every call. On failure we include a short slice
    // of the body, which is where the error message lives.
    const body = await res.text().catch(() => "");
    log(`SmartThings API ${method} ${path} → ${res.status} ${res.ok ? "ok" : body.slice(0, 200) || "(empty)"}`);
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error(
          "SmartThings rejected the token (401). It may be invalid or expired — " +
            "PATs created after Dec 2024 expire after 24h. Generate a new one.",
        );
      }
      throw new Error(`SmartThings API ${res.status} on ${path}: ${body.slice(0, 300)}`);
    }
    if (res.status === 204 || body === "") return undefined as T;
    return JSON.parse(body) as T;
  }

  // All devices on the account, flattened to id/label/name + main-component capabilities.
  async listDevices(): Promise<STDevice[]> {
    const data = await this.req<{ items: RawDevice[] }>("/devices");
    return (data.items ?? []).map((d) => ({
      deviceId: d.deviceId,
      label: d.label || d.name || d.deviceId,
      name: d.name ?? "",
      capabilities: mainCapabilities(d),
      source: "cloud" as const,
    }));
  }

  // Read power state, the input capability in use, current input, and the source list.
  async getStatus(deviceId: string): Promise<TVStatus> {
    const data = await this.req<RawStatus>(`/devices/${deviceId}/status`);
    return parseStatus(data);
  }

  async powerOn(deviceId: string): Promise<void> {
    await this.command(deviceId, "switch", "on");
  }

  async powerOff(deviceId: string): Promise<void> {
    await this.command(deviceId, "switch", "off");
  }

  async setInputSource(deviceId: string, capability: string, source: string): Promise<void> {
    await this.command(deviceId, capability, "setInputSource", [source]);
  }

  // The SmartThings cloud API exposes named capabilities (power, input source), not raw remote
  // keys — there's no way to send an arbitrary KEY_* sequence. This capability is LAN-only.
  async sendKeys(_deviceId: string, _keys: string[]): Promise<void> {
    throw new Error("Sending a raw key sequence isn't supported for cloud (SmartThings) TVs.");
  }

  private async command(
    deviceId: string,
    capability: string,
    command: string,
    args: unknown[] = [],
  ): Promise<void> {
    await this.req(`/devices/${deviceId}/commands`, {
      method: "POST",
      body: JSON.stringify({
        commands: [{ component: "main", capability, command, arguments: args }],
      }),
    });
  }
}
