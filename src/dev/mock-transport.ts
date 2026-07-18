// Mock mode for the transport seam. installMockCloud() (mock-cloud.ts) fakes the SmartThings
// cloud at the fetch level, but the LAN transport speaks WebSocket/UDP, which fetch-patching
// can't touch. So in mock mode app.ts's buildTransport() returns this FakeTransport instead —
// an in-process TVTransport over the same FakeTVState the fake cloud uses, so both the cloud and
// local Settings UIs (and tests) drive one identical fake TV with identical log lines.

import { keyDelayMs } from "../api/local-tv.js";
import type { TVTransport } from "../api/transport.js";
import type { TVConfig } from "../config.js";
import type { STDevice, TVStatus } from "../domain/tv.js";
import { mainCapabilities, parseStatus } from "../domain/tv.js";
import { log } from "../log.js";
import { FakeTVState, isMockAuthorized } from "./mock-cloud.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A TVTransport backed by the shared in-memory device state. Latency is injectable so tests run
// at zero delay; the default mimics a LAN round-trip.
export class FakeTransport implements TVTransport {
  constructor(
    private readonly tvState: FakeTVState = new FakeTVState(),
    private readonly latencyMs: () => number = () => 20 + Math.random() * 40,
    // The active config, so mock key sequences honor the per-TV keyDelay like LocalTV.sendKeys
    // (without it, a configured delay silently doesn't apply in mock mode).
    private readonly config?: TVConfig,
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

  async sendKeys(deviceId: string, keys: string[]): Promise<void> {
    // No real remote here — log each key as it "goes out", mirroring LocalTV.sendKeys' one-at-a-time
    // send (a per-key delay), so `npm run electron:dev:mock` shows the sequence step-by-step.
    // The TV's keyDelay applies too, so the configured interval is observable in mock mode.
    const delayMs = keyDelayMs(this.config?.deviceConfigs?.[deviceId] ?? {});
    log(`Mock TV ${deviceId} received keys: ${keys.join(", ")}`);
    for (let i = 0; i < keys.length; i++) {
      await this.delay();
      log(`  → key ${i + 1}/${keys.length}: ${keys[i]}`);
      if (delayMs > 0 && i < keys.length - 1) {
        log(`  … waiting ${delayMs / 1000}s`);
        await sleep(delayMs);
      }
    }
    log(
      `  ✓ sequence sent (${keys.length} key${keys.length === 1 ? "" : "s"}, interval ${delayMs / 1000}s)`,
    );
  }

  async listDevices(): Promise<STDevice[]> {
    await this.delay();
    return (
      this.tvState.devices
        .map((d) => {
          // A fake device id starting with "local:" is a LAN-paired TV; anything else is a cloud
          // (SmartThings) device — so the mock exercises the same source badging as production.
          const source = d.deviceId.startsWith("local:") ? ("local" as const) : ("cloud" as const);
          return {
            deviceId: d.deviceId,
            label: d.label || d.name || d.deviceId,
            name: d.name ?? "",
            capabilities: mainCapabilities(d),
            source,
          };
        })
        // Mirror RoutingTransport: cloud TVs require a signed-in account, so they drop out on Sign
        // out; local (LAN) TVs are config-driven and always listed.
        .filter((d) => d.source === "local" || isMockAuthorized())
    );
  }
}

// Build the mock transport buildTransport() uses in mock mode. A fresh state each time would
// forget power/input between commands, so a single module-level state persists across the app's
// per-invocation transports (matching the fake cloud, whose FakeCloud is also long-lived).
let sharedState: FakeTVState | undefined;

export function makeMockTransport(config?: TVConfig): TVTransport {
  sharedState ??= new FakeTVState();
  return new FakeTransport(sharedState, undefined, config);
}
