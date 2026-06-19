// I/O seams (ports) + the production wiring factory. Application code depends only on these
// interfaces and on domain.ts; concrete adapters live in the existing files. Tests substitute
// fakes via buildDeps(overrides).

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { STDevice, TVStatus, TVConfig, TokenResponse, KeyEvent, ModifierState } from "./domain.js";

// --- Ports ---

export type Handle = unknown;

export interface Clock {
  now(): number;
  setInterval(fn: () => void, ms: number): Handle;
  clearInterval(h: Handle): void;
  sleep(ms: number): Promise<void>;
}

export interface ConfigStore {
  load(): Promise<TVConfig>;
  save(config: TVConfig): Promise<void>;
  reset(): Promise<void>;
}

export interface TVApi {
  listDevices(): Promise<STDevice[]>;
  findTV(): Promise<STDevice | null>;
  getStatus(deviceId: string): Promise<TVStatus>;
  powerOn(deviceId: string): Promise<void>;
  powerOff(deviceId: string): Promise<void>;
  setInputSource(deviceId: string, capability: string, source: string): Promise<void>;
}

/** Token is resolved at runtime, then a client is constructed for it. */
export type TVApiFactory = (token: string) => TVApi;

export interface OAuthClient {
  exchangeCode(config: TVConfig, code: string): Promise<TokenResponse>;
  refresh(config: TVConfig, refreshToken: string): Promise<TokenResponse>;
}

export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
}

export interface KeyListener {
  start(onKey: (e: KeyEvent, mods: ModifierState) => void): Promise<void>;
  stop(): void;
}

export interface WakeNotifier {
  start(onResume: (sleptMs: number) => void): void;
  stop(): void;
}

export interface SystemControl {
  sleepPc(): Promise<void>;
  uptimeSeconds(): number;
}

export interface Prompter {
  question(prompt: string): Promise<string>;
}

export interface Deps {
  clock: Clock;
  config: ConfigStore;
  tvApi: TVApiFactory;
  oauth: OAuthClient;
  logger: Logger;
  keyListener: KeyListener;
  wakeNotifier: WakeNotifier;
  system: SystemControl;
  prompter: Prompter;
}

// --- Small inline production adapters ---

/** Real wall-clock + timers. Intervals are unref'd so they don't keep the process alive. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
};

const stamp = () => new Date().toLocaleTimeString();

/** Logger that writes to the console. `info` plain, `error` to stderr; both unstamped here. */
export const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

/** Logger that timestamps each line, as the daemon does. */
export const stampedConsoleLogger: Logger = {
  info: (msg) => console.log(`[${stamp()}] ${msg}`),
  error: (msg) => console.error(`[${stamp()}] ${msg}`),
};

/** Readline-backed prompt for the one-time OAuth login flow. */
export const readlinePrompter: Prompter = {
  async question(prompt: string) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question(prompt)).trim();
    } finally {
      rl.close();
    }
  },
};

// --- Composition root ---

/**
 * Build the production dependency set, letting callers override any port (tests pass fakes).
 * Adapters are imported lazily so a unit test overriding e.g. `keyListener` never loads the
 * native key-listener library.
 */
export async function buildDeps(overrides: Partial<Deps> = {}): Promise<Deps> {
  const { SmartThings } = await import("./smartthings.js");
  const { fileConfigStore } = await import("./config.js");
  const { httpOAuthClient } = await import("./oauth.js");
  const { osSystemControl } = await import("./pc-sleep.js");
  const { heartbeatWakeNotifier } = await import("./wake-watch.js");

  const clock = overrides.clock ?? systemClock;

  // The key listener pulls in the native node-global-key-listener library (and sudo-prompt on
  // macOS). Only the daemon needs it. Non-daemon callers (npm start / --devices / tests) don't
  // touch `keyListener`, so we only load that module when an override wasn't supplied AND it's
  // actually needed — see buildDaemonDeps. Here we leave a thrower so accidental use is loud.
  const keyListener: KeyListener =
    overrides.keyListener ?? {
      start() {
        throw new Error("keyListener not available in this dependency set (use buildDaemonDeps).");
      },
      stop() {},
    };

  return {
    clock,
    config: overrides.config ?? fileConfigStore,
    tvApi: overrides.tvApi ?? ((token: string) => new SmartThings(token)),
    oauth: overrides.oauth ?? httpOAuthClient,
    logger: overrides.logger ?? consoleLogger,
    system: overrides.system ?? osSystemControl,
    wakeNotifier: overrides.wakeNotifier ?? heartbeatWakeNotifier(clock),
    prompter: overrides.prompter ?? readlinePrompter,
    keyListener,
  };
}

/**
 * Like buildDeps, but also loads the real global key listener (the daemon's only extra need).
 * Kept separate so the native node-global-key-listener library is loaded only by the daemon —
 * after daemon.ts's node-compat import has run.
 */
export async function buildDaemonDeps(overrides: Partial<Deps> = {}): Promise<Deps> {
  if (overrides.keyListener) return buildDeps(overrides);
  const { globalKeyListener } = await import("./key-listener.js");
  return buildDeps({ ...overrides, keyListener: globalKeyListener() });
}
