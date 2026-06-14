const BASE = "https://api.smartthings.com/v1";

/** The two capability ids Samsung TVs expose for input switching. */
const INPUT_CAPABILITIES = ["samsungvd.mediaInputSource", "mediaInputSource"] as const;

export interface STDevice {
  deviceId: string;
  label: string;
  name: string;
  capabilities: string[];
}

export interface InputSource {
  id: string;
  name: string;
}

export interface TVStatus {
  /** "on" | "off" | undefined */
  power?: string;
  /** Which capability id this TV uses for input switching. */
  inputCapability?: string;
  currentInput?: string;
  sources: InputSource[];
}

/** Minimal SmartThings REST client (cloud control — no LAN access needed). */
export class SmartThings {
  constructor(private readonly token: string) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401) {
        throw new Error(
          "SmartThings rejected the token (401). It may be invalid or expired — " +
            "PATs created after Dec 2024 expire after 24h. Generate a new one.",
        );
      }
      throw new Error(`SmartThings API ${res.status} on ${path}: ${body.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** All devices on the account, flattened to id/label/name + main-component capabilities. */
  async listDevices(): Promise<STDevice[]> {
    const data = await this.req<{ items: RawDevice[] }>("/devices");
    return (data.items ?? []).map((d) => ({
      deviceId: d.deviceId,
      label: d.label || d.name || d.deviceId,
      name: d.name ?? "",
      capabilities: mainCapabilities(d),
    }));
  }

  /** Pick the most likely TV: a device whose main component can switch inputs. */
  async findTV(): Promise<STDevice | null> {
    const devices = await this.listDevices();
    const tvs = devices.filter((d) =>
      INPUT_CAPABILITIES.some((c) => d.capabilities.includes(c)),
    );
    // Prefer one that also exposes power switching.
    return tvs.find((d) => d.capabilities.includes("switch")) ?? tvs[0] ?? null;
  }

  /** Read power state, the input capability in use, current input, and the source list. */
  async getStatus(deviceId: string): Promise<TVStatus> {
    const data = await this.req<RawStatus>(`/devices/${deviceId}/status`);
    const main = data.components?.main ?? {};

    const power = main["switch"]?.["switch"]?.value as string | undefined;

    const inputCapability = INPUT_CAPABILITIES.find((c) => main[c] != null);
    const cap = inputCapability ? main[inputCapability] : undefined;

    const rawMap = (cap?.["supportedInputSourcesMap"]?.value ?? []) as RawSource[];
    const sources: InputSource[] = rawMap.map((s) => ({
      id: String(s.id),
      name: String(s.name ?? s.id),
    }));
    const currentInput = cap?.["inputSource"]?.value as string | undefined;

    return { power, inputCapability, currentInput, sources };
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

// --- Raw API response shapes (only the parts we read) ---

interface RawDevice {
  deviceId: string;
  label?: string;
  name?: string;
  components?: { id: string; capabilities: { id: string }[] }[];
}

interface RawSource {
  id: string;
  name?: string;
}

type RawAttr = { value?: unknown };
type RawCapability = Record<string, RawAttr>;
interface RawStatus {
  components?: Record<string, Record<string, RawCapability>>;
}

function mainCapabilities(d: RawDevice): string[] {
  const main = d.components?.find((c) => c.id === "main");
  return (main?.capabilities ?? []).map((c) => c.id);
}
