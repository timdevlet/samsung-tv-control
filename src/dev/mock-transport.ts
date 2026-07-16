// Mock mode for the transport seam. installMockCloud() (mock-cloud.ts) fakes the SmartThings
// cloud at the fetch level, but the LAN transport speaks WebSocket/UDP, which fetch-patching
// can't touch. So in mock mode app.ts's buildTransport() returns this FakeTransport instead —
// an in-process TVTransport over the same FakeTVState the fake cloud uses, so both the cloud and
// local Settings UIs (and tests) drive one identical fake TV with identical log lines.

import { parseStatus, mainCapabilities, isTV, pickTV } from "../domain/tv.js";
import type { STDevice, TVStatus } from "../domain/tv.js";
import type { TVTransport } from "../api/transport.js";
import { FakeTVState } from "./mock-cloud.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A TVTransport backed by the shared in-memory device state. Latency is injectable so tests run
// at zero delay; the default mimics a LAN round-trip.
export class FakeTransport implements TVTransport {
  constructor(
    private readonly tvState: FakeTVState = new FakeTVState(),
    private readonly latencyMs: () => number = () => 20 + Math.random() * 40,
  ) {}

  private async delay(): Promise<void> {
    await sleep(this.latencyMs());
  }

  async getStatus(deviceId: string): Promise<TVStatus> {
    await this.delay();
    const body = this.tvState.statusBody(deviceId);
    if (!body) throw new Error(`Mock TV ${deviceId} not found.`);
    return parseStatus(body);
  }

  async powerOn(deviceId: string): Promise<void> {
    await this.delay();
    this.tvState.setPower(deviceId, "on");
  }

  async powerOff(deviceId: string): Promise<void> {
    await this.delay();
    this.tvState.setPower(deviceId, "off");
  }

  async setInputSource(deviceId: string, _capability: string, source: string): Promise<void> {
    await this.delay();
    this.tvState.setInput(deviceId, source);
  }

  async listDevices(): Promise<STDevice[]> {
    await this.delay();
    return this.tvState.devices.map((d) => ({
      deviceId: d.deviceId,
      label: d.label || d.name || d.deviceId,
      name: d.name ?? "",
      capabilities: mainCapabilities(d),
    }));
  }

  async listTVs(): Promise<STDevice[]> {
    return (await this.listDevices()).filter(isTV);
  }

  async findTV(): Promise<STDevice | null> {
    return pickTV(await this.listDevices());
  }
}

// Build the mock transport buildTransport() uses in mock mode. A fresh state each time would
// forget power/input between commands, so a single module-level state persists across the app's
// per-invocation transports (matching the fake cloud, whose FakeCloud is also long-lived).
let sharedState: FakeTVState | undefined;

export function makeMockTransport(): TVTransport {
  sharedState ??= new FakeTVState();
  return new FakeTransport(sharedState);
}
