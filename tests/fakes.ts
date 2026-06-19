// Test doubles for the I/O ports. Kept deliberately small and explicit.

import type {
  Clock,
  ConfigStore,
  TVApi,
  OAuthClient,
  Logger,
  KeyListener,
  WakeNotifier,
  SystemControl,
  Prompter,
  Handle,
  Deps,
} from "../src/interfaces.js";
import type { TVConfig, TVStatus, STDevice, KeyEvent, ModifierState, TokenResponse } from "../src/domain.js";

/** A controllable clock. `now()` returns the current virtual time; advance() moves it. */
export class FakeClock implements Clock {
  private t: number;
  private intervals = new Map<Handle, { fn: () => void; ms: number; next: number }>();
  private nextId = 1;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setInterval(fn: () => void, ms: number): Handle {
    const id = this.nextId++;
    this.intervals.set(id, { fn, ms, next: this.t + ms });
    return id;
  }

  clearInterval(h: Handle): void {
    this.intervals.delete(h);
  }

  /** Resolves immediately but moves virtual time forward by `ms` (no real waiting). */
  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }

  /** Advance virtual time by `ms`, firing any due intervals along the way. */
  advance(ms: number): void {
    const target = this.t + ms;
    // Fire intervals in time order until we reach the target.
    for (;;) {
      let soonest: { handle: Handle; entry: { fn: () => void; ms: number; next: number } } | undefined;
      for (const [handle, entry] of this.intervals) {
        if (entry.next <= target && (!soonest || entry.next < soonest.entry.next)) {
          soonest = { handle, entry };
        }
      }
      if (!soonest) break;
      this.t = soonest.entry.next;
      soonest.entry.next += soonest.entry.ms;
      soonest.entry.fn();
    }
    this.t = target;
  }
}

/** In-memory ConfigStore. `saved` records the last persisted config. */
export class InMemoryConfigStore implements ConfigStore {
  saved: TVConfig[] = [];

  constructor(public current: TVConfig) {}

  async load(): Promise<TVConfig> {
    return { ...this.current };
  }
  async save(config: TVConfig): Promise<void> {
    this.current = { ...config };
    this.saved.push({ ...config });
  }
  async reset(): Promise<void> {
    this.current = { pcInput: "HDMI2" };
  }
}

/** Scriptable TVApi: hand it a queue of statuses and inspect recorded calls. */
export class FakeTVApi implements TVApi {
  calls: string[] = [];
  setInputCalls: Array<{ deviceId: string; capability: string; source: string }> = [];

  constructor(
    private statuses: TVStatus[],
    private devices: STDevice[] = [],
    private tv: STDevice | null = null,
  ) {}

  async listDevices(): Promise<STDevice[]> {
    this.calls.push("listDevices");
    return this.devices;
  }
  async findTV(): Promise<STDevice | null> {
    this.calls.push("findTV");
    return this.tv;
  }
  async getStatus(): Promise<TVStatus> {
    this.calls.push("getStatus");
    // Return successive statuses; repeat the last one once exhausted.
    return this.statuses.length > 1 ? this.statuses.shift()! : this.statuses[0];
  }
  async powerOn(): Promise<void> {
    this.calls.push("powerOn");
  }
  async powerOff(): Promise<void> {
    this.calls.push("powerOff");
  }
  async setInputSource(deviceId: string, capability: string, source: string): Promise<void> {
    this.calls.push("setInputSource");
    this.setInputCalls.push({ deviceId, capability, source });
  }
}

/** OAuthClient that returns canned tokens, or throws a tagged invalid_grant error. */
export class FakeOAuthClient implements OAuthClient {
  refreshCalls = 0;
  constructor(
    private token: TokenResponse = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 86400 },
    private throwInvalidGrant = false,
  ) {}

  async exchangeCode(): Promise<TokenResponse> {
    return this.token;
  }
  async refresh(): Promise<TokenResponse> {
    this.refreshCalls++;
    if (this.throwInvalidGrant) {
      const err = new Error("refused") as Error & { oauthError?: string };
      err.oauthError = "invalid_grant";
      throw err;
    }
    return this.token;
  }
}

/** Logger that records every line. */
export class RecordingLogger implements Logger {
  infos: string[] = [];
  errors: string[] = [];
  info(msg: string): void {
    this.infos.push(msg);
  }
  error(msg: string): void {
    this.errors.push(msg);
  }
}

/** KeyListener that lets a test emit synthetic key events. */
export class FakeKeyListener implements KeyListener {
  private handler?: (e: KeyEvent, mods: ModifierState) => void;
  started = false;
  stopped = false;

  async start(onKey: (e: KeyEvent, mods: ModifierState) => void): Promise<void> {
    this.handler = onKey;
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  emit(e: KeyEvent, mods: ModifierState): void {
    this.handler?.(e, mods);
  }
}

/** WakeNotifier that lets a test fire a wake event manually. */
export class FakeWakeNotifier implements WakeNotifier {
  private handler?: (sleptMs: number) => void;
  started = false;
  stopped = false;

  start(onResume: (sleptMs: number) => void): void {
    this.handler = onResume;
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  fire(sleptMs: number): void {
    this.handler?.(sleptMs);
  }
}

/** SystemControl with a settable uptime and a sleep recorder. */
export class FakeSystemControl implements SystemControl {
  slept = 0;
  constructor(public uptime = 9999) {}
  async sleepPc(): Promise<void> {
    this.slept++;
  }
  uptimeSeconds(): number {
    return this.uptime;
  }
}

/** Prompter that returns a preset answer. */
export class FakePrompter implements Prompter {
  asked: string[] = [];
  constructor(private answer = "") {}
  async question(prompt: string): Promise<string> {
    this.asked.push(prompt);
    return this.answer;
  }
}

/** Build a Deps with sensible fakes, overridable per test. */
export function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  const base: Deps = {
    clock: new FakeClock(),
    config: new InMemoryConfigStore({ pcInput: "HDMI2", token: "test-token" }),
    tvApi: () => new FakeTVApi([{ power: "on", inputCapability: "mediaInputSource", currentInput: "HDMI2", sources: [] }]),
    logger: new RecordingLogger(),
    system: new FakeSystemControl(),
    wakeNotifier: new FakeWakeNotifier(),
    keyListener: new FakeKeyListener(),
    prompter: new FakePrompter(),
    oauth: new FakeOAuthClient(),
  };
  return { ...base, ...overrides };
}
