// Pure TV/SmartThings logic — input selection, status-JSON parsing, device picking.
// No I/O; the HTTP adapter lives in src/api/smartthings.ts.

export interface STDevice {
  deviceId: string;
  label: string;
  name: string;
  capabilities: string[];
  // Which transport surfaced this device: "cloud" (SmartThings account) or "local" (a LAN-paired
  // config entry). Optional so pure parsing helpers needn't set it; the transports tag it on their
  // list results so the UI can badge cloud TVs. Undefined = unknown/untagged.
  source?: "cloud" | "local";
}

export interface InputSource {
  id: string;
  name: string;
}

export interface TVStatus {
  // "on" | "off" | undefined
  power?: string;
  // Which capability id this TV uses for input switching.
  inputCapability?: string;
  currentInput?: string;
  sources: InputSource[];
}

// The two capability ids Samsung TVs expose for input switching.
export const INPUT_CAPABILITIES = ["samsungvd.mediaInputSource", "mediaInputSource"] as const;

// The synthetic input capability the LAN transport advertises (src/api/local-tv.ts). It's not a
// real SmartThings capability — it just marks a config-driven LAN device as input-capable so
// isTV()/switchOne() treat it like a TV.
export const LOCAL_INPUT_CAPABILITY = "local.remoteKey";

// Input selection

// Pick the source id to switch to: match pcInput by id, then by label, else raw value.
export function pickInput(status: TVStatus, pcInput: string): string {
  const want = pcInput.toLowerCase();
  const byId = status.sources.find((s) => s.id.toLowerCase() === want);
  if (byId) return byId.id;
  const byName = status.sources.find((s) => s.name.toLowerCase() === want);
  if (byName) return byName.id;
  // Nothing matched the configured value — fall back to the raw value and let the TV try.
  return pcInput;
}

// True when the TV's current input equals `target` (case-insensitive).
export function isOnInput(status: TVStatus, target: string): boolean {
  return Boolean(status.currentInput && status.currentInput.toLowerCase() === target.toLowerCase());
}

// SmartThings status JSON parsing

// Raw shape of a `/devices/{id}/status` response. Nested attribute values are unknown
// until we read the specific fields parseStatus cares about.
export interface RawStatus {
  components?: Record<string, Record<string, Record<string, { value?: unknown }>>>;
}

// Parse a raw `/devices/{id}/status` response into a TVStatus.
export function parseStatus(data: RawStatus): TVStatus {
  const main = data.components?.main ?? {};

  const power = main["switch"]?.["switch"]?.value as string | undefined;

  const inputCapability = INPUT_CAPABILITIES.find((c) => main[c] != null);
  const cap = inputCapability ? main[inputCapability] : undefined;

  const rawMap = (cap?.["supportedInputSourcesMap"]?.value ?? []) as {
    id: string;
    name?: string;
  }[];
  const sources: InputSource[] = rawMap.map((s) => ({
    id: String(s.id),
    name: String(s.name ?? s.id),
  }));
  const currentInput = cap?.["inputSource"]?.value as string | undefined;

  return { power, inputCapability, currentInput, sources };
}

// Device list parsing

// Raw shape of a `/devices` list entry.
export interface RawDevice {
  deviceId: string;
  label?: string;
  name?: string;
  components?: { id: string; capabilities: { id: string }[] }[];
}

// Capability ids on a device's "main" component.
export function mainCapabilities(d: RawDevice): string[] {
  const main = d.components?.find((c) => c.id === "main");
  return (main?.capabilities ?? []).map((c) => c.id);
}

// True when a device looks like a TV: its main component exposes an input-switching capability
// (either a real SmartThings one, or the LAN transport's synthetic marker).
export function isTV(d: STDevice): boolean {
  return (
    d.capabilities.includes(LOCAL_INPUT_CAPABILITY) ||
    INPUT_CAPABILITIES.some((c) => d.capabilities.includes(c))
  );
}

// Pick the most likely TV from a device list: input-capable, preferring a power switch.
export function pickTV(devices: STDevice[]): STDevice | null {
  const tvs = devices.filter(isTV);
  return tvs.find((d) => d.capabilities.includes("switch")) ?? tvs[0] ?? null;
}
