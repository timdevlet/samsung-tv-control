// Dev mode: a stateful in-process fake of the SmartThings cloud, installed by replacing
// globalThis.fetch with a URL router. The real SmartThings client (src/api/smartthings.ts)
// runs unmodified — its logging, error handling, and status parsing are exercised for real;
// only the wire is faked. Enabled with SMARTTHINGS_MOCK=1 (npm run electron:dev:mock /
// start:mock); Electron additionally gates on !app.isPackaged.

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_PATH } from "../config.js";
import type { RawDevice, RawStatus } from "../domain/tv.js";
import { INPUT_CAPABILITIES, mainCapabilities } from "../domain/tv.js";
import {
  MOCK_DEVICES,
  MOCK_LOCAL_DEVICE_ID,
  MOCK_LOCAL_HOST,
  MOCK_LOCAL_MAC,
  statusBody,
} from "./fixtures.js";

const API_BASE = "https://api.smartthings.com/v1";

// Lives next to the real config's default location so the repo's .gitignore covers it.
export const MOCK_CONFIG_PATH = join(dirname(CONFIG_PATH), "smartthings-config.mock.json");

export function isMockMode(): boolean {
  return process.env.SMARTTHINGS_MOCK?.trim() === "1";
}

// Mock cloud auth state. Real mode tracks this via the OAuth refresh token in the config; mock mode
// has no real tokens, so this flag stands in — starts signed in (the fake cloud TVs load right
// away) and Sign out / Sign in flip it. It lives here (not in electron/auth.ts, which imports
// Electron) so the pure FakeTransport can read it to mirror RoutingTransport: cloud TVs disappear
// when signed out, local TVs stay. auth.ts delegates its mock flag to these.
let mockAuthorized = true;
export function isMockAuthorized(): boolean {
  return mockAuthorized;
}
export function setMockAuthorized(value: boolean): void {
  mockAuthorized = value;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const notFound = (message: string): Response =>
  json({ error: { code: "NotFoundError", message } }, 404);

interface DeviceState {
  power: "on" | "off";
  currentInput: string;
}

// The command envelope POSTed to /devices/{id}/commands by SmartThings.command().
interface CommandBody {
  commands?: { capability?: string; command?: string; arguments?: unknown[] }[];
}

// The in-memory device state machine, shared by both fakes: FakeCloud (fetch-level, used by the
// cloud transport + the fetch-based tests) and FakeTransport (src/dev/mock-transport.ts, used
// when a TVTransport is built directly). Two TVs whose power/input persist across calls, so a
// demo walks the full wake → retry → input-switch flow. Starts off + on a non-PC input.
export class FakeTVState {
  private readonly state = new Map<string, DeviceState>();

  constructor(readonly devices: RawDevice[] = MOCK_DEVICES) {
    for (const d of devices) this.state.set(d.deviceId, { power: "off", currentInput: "dtv" });
  }

  has(deviceId: string): boolean {
    return this.state.has(deviceId);
  }

  // The input capability this device advertises (mirrors the real device's main-component caps).
  capabilityOf(deviceId: string): string {
    const device = this.devices.find((d) => d.deviceId === deviceId);
    const caps = device ? mainCapabilities(device) : [];
    return INPUT_CAPABILITIES.find((c) => caps.includes(c)) ?? INPUT_CAPABILITIES[1];
  }

  // A raw /status body for this device, reflecting all prior commands.
  statusBody(deviceId: string): RawStatus | null {
    const state = this.state.get(deviceId);
    if (!state) return null;
    return statusBody(state.power, state.currentInput, this.capabilityOf(deviceId));
  }

  setPower(deviceId: string, power: "on" | "off"): void {
    const state = this.state.get(deviceId);
    if (state) state.power = power;
  }

  setInput(deviceId: string, input: string): void {
    const state = this.state.get(deviceId);
    if (state) state.currentInput = input;
  }
}

// In-memory SmartThings cloud: routes the three REST paths the SmartThings client uses into a
// shared FakeTVState. Latency is injectable so tests can run at zero delay.
export class FakeCloud {
  private readonly tvState: FakeTVState;

  constructor(
    devicesOrState: RawDevice[] | FakeTVState = MOCK_DEVICES,
    private readonly latencyMs: () => number = () => 150 + Math.random() * 200,
  ) {
    this.tvState =
      devicesOrState instanceof FakeTVState ? devicesOrState : new FakeTVState(devicesOrState);
  }

  // Route a request the way the real cloud would. Only the three paths the SmartThings client
  // uses exist; anything else 404s (and the client's error path surfaces the body).
  async handle(url: string, init?: RequestInit): Promise<Response> {
    await sleep(this.latencyMs());
    const path = url.slice(API_BASE.length).split("?")[0];
    const method = (init?.method ?? "GET").toUpperCase();

    // The fake SmartThings cloud only knows CLOUD devices — a `local:` id is a LAN-only TV the
    // account has never seen, so it's excluded from the account's device list (and its status /
    // command routes 404, exactly as the real cloud would for an unknown id).
    if (method === "GET" && path === "/devices") {
      return json({ items: this.tvState.devices.filter((d) => !d.deviceId.startsWith("local:")) });
    }

    const status = path.match(/^\/devices\/([^/]+)\/status$/);
    if (method === "GET" && status) return this.status(status[1]);

    const commands = path.match(/^\/devices\/([^/]+)\/commands$/);
    if (method === "POST" && commands) return this.command(commands[1], init?.body);

    return notFound(`mock cloud has no route for ${method} ${path}`);
  }

  private status(deviceId: string): Response {
    const body = this.tvState.statusBody(deviceId);
    if (!body) return notFound(`Device ${deviceId} not found.`);
    return json(body);
  }

  private command(deviceId: string, rawBody: RequestInit["body"]): Response {
    if (!this.tvState.has(deviceId)) return notFound(`Device ${deviceId} not found.`);
    const body = JSON.parse(String(rawBody ?? "{}")) as CommandBody;
    for (const cmd of body.commands ?? []) {
      if (cmd.capability === "switch" && (cmd.command === "on" || cmd.command === "off")) {
        this.tvState.setPower(deviceId, cmd.command);
      } else if (cmd.command === "setInputSource") {
        this.tvState.setInput(deviceId, String(cmd.arguments?.[0] ?? ""));
      }
    }
    return json({ results: (body.commands ?? []).map(() => ({ status: "ACCEPTED" })) });
  }
}

// Turn this process into mock mode:
//  1. a fake token short-circuits resolveAccessToken() (env precedence rule #1) — the OAuth
//     code paths are never reached;
//  2. the config file is redirected to MOCK_CONFIG_PATH so mock device selections (and a mock
//     "Sign out" → resetConfig) can never touch the real smartthings-config.json, and seeded
//     with the fake TVs preselected (plus the LAN TV's paired config) so the demo works out of the
//     box;
//  3. globalThis.fetch routes SmartThings API traffic into a FakeCloud, everything else through.
export function installMockCloud(): void {
  process.env.SMARTTHINGS_TOKEN ||= "mock-token";
  process.env.SMARTTHINGS_CONFIG_PATH ||= MOCK_CONFIG_PATH;
  const configPath = process.env.SMARTTHINGS_CONFIG_PATH;
  if (!existsSync(configPath)) {
    const seed = {
      pcInput: "HDMI2",
      selectedDeviceIds: MOCK_DEVICES.map((d) => d.deviceId),
      // The LAN TV (MOCK_LOCAL_DEVICE_ID) shows as a paired local device: host/mac + a fake
      // wsToken so its per-TV tab renders the LAN fields and a "Paired ✓" state.
      deviceConfigs: {
        [MOCK_LOCAL_DEVICE_ID]: {
          host: MOCK_LOCAL_HOST,
          mac: MOCK_LOCAL_MAC,
          wsToken: "mock-ws-token",
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(seed, null, 2) + "\n", "utf8");
  }

  const realFetch = globalThis.fetch;
  const cloud = new FakeCloud();
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.startsWith(API_BASE) ? cloud.handle(url, init) : realFetch(input, init);
  }) as typeof fetch;
}
