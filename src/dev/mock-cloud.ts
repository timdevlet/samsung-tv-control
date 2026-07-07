// Dev mode: a stateful in-process fake of the SmartThings cloud, installed by replacing
// globalThis.fetch with a URL router. The real SmartThings client (src/api/smartthings.ts)
// runs unmodified — its logging, error handling, and status parsing are exercised for real;
// only the wire is faked. Enabled with SMARTTHINGS_MOCK=1 (npm run electron:dev:mock /
// start:mock); Electron additionally gates on !app.isPackaged.

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_PATH } from "../config.js";
import { INPUT_CAPABILITIES, mainCapabilities } from "../domain/tv.js";
import type { RawDevice } from "../domain/tv.js";
import { MOCK_DEVICES, statusBody } from "./fixtures.js";

const API_BASE = "https://api.smartthings.com/v1";

// Lives next to the real config's default location so the repo's .gitignore covers it.
export const MOCK_CONFIG_PATH = join(dirname(CONFIG_PATH), "smartthings-config.mock.json");

export function isMockMode(): boolean {
  return process.env.SMARTTHINGS_MOCK?.trim() === "1";
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

// In-memory SmartThings cloud: two TVs whose power/input state persists across calls, so
// /status reflects prior commands. TVs start off (and on a non-PC input) so a demo walks the
// full wake → retry → input-switch flow. Latency is injectable so tests can run at zero delay.
export class FakeCloud {
  private readonly state = new Map<string, DeviceState>();

  constructor(
    private readonly devices: RawDevice[] = MOCK_DEVICES,
    private readonly latencyMs: () => number = () => 150 + Math.random() * 200,
  ) {
    for (const d of devices) this.state.set(d.deviceId, { power: "off", currentInput: "dtv" });
  }

  // Route a request the way the real cloud would. Only the three paths the SmartThings client
  // uses exist; anything else 404s (and the client's error path surfaces the body).
  async handle(url: string, init?: RequestInit): Promise<Response> {
    await sleep(this.latencyMs());
    const path = url.slice(API_BASE.length).split("?")[0];
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && path === "/devices") return json({ items: this.devices });

    const status = path.match(/^\/devices\/([^/]+)\/status$/);
    if (method === "GET" && status) return this.status(status[1]);

    const commands = path.match(/^\/devices\/([^/]+)\/commands$/);
    if (method === "POST" && commands) return this.command(commands[1], init?.body);

    return notFound(`mock cloud has no route for ${method} ${path}`);
  }

  private status(deviceId: string): Response {
    const device = this.devices.find((d) => d.deviceId === deviceId);
    const state = this.state.get(deviceId);
    if (!device || !state) return notFound(`Device ${deviceId} not found.`);
    const capability =
      INPUT_CAPABILITIES.find((c) => mainCapabilities(device).includes(c)) ?? INPUT_CAPABILITIES[1];
    return json(statusBody(state.power, state.currentInput, capability));
  }

  private command(deviceId: string, rawBody: RequestInit["body"]): Response {
    const state = this.state.get(deviceId);
    if (!state) return notFound(`Device ${deviceId} not found.`);
    const body = JSON.parse(String(rawBody ?? "{}")) as CommandBody;
    for (const cmd of body.commands ?? []) {
      if (cmd.capability === "switch" && (cmd.command === "on" || cmd.command === "off")) {
        state.power = cmd.command;
      } else if (cmd.command === "setInputSource") {
        state.currentInput = String(cmd.arguments?.[0] ?? state.currentInput);
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
//     with both fake TVs preselected so the demo works out of the box;
//  3. globalThis.fetch routes SmartThings API traffic into a FakeCloud, everything else through.
export function installMockCloud(): void {
  process.env.SMARTTHINGS_TOKEN ||= "mock-token";
  process.env.SMARTTHINGS_CONFIG_PATH ||= MOCK_CONFIG_PATH;
  const configPath = process.env.SMARTTHINGS_CONFIG_PATH;
  if (!existsSync(configPath)) {
    const seed = { pcInput: "HDMI2", selectedDeviceIds: MOCK_DEVICES.map((d) => d.deviceId) };
    writeFileSync(configPath, JSON.stringify(seed, null, 2) + "\n", "utf8");
  }

  const realFetch = globalThis.fetch;
  const cloud = new FakeCloud();
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.startsWith(API_BASE) ? cloud.handle(url, init) : realFetch(input, init);
  }) as typeof fetch;
}
