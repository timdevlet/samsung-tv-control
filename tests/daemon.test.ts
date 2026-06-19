import { describe, it, expect, beforeEach, vi } from "vitest";
import { runDaemon } from "../src/daemon.js";
import type { TVStatus, KeyEvent, ModifierState } from "../src/domain.js";
import {
  fakeDeps,
  FakeTVApi,
  FakeKeyListener,
  FakeWakeNotifier,
  FakeSystemControl,
  InMemoryConfigStore,
  FakeClock,
} from "./fakes.js";

const onPc: TVStatus = { power: "on", inputCapability: "mediaInputSource", currentInput: "HDMI2", sources: [{ id: "HDMI2", name: "PC" }] };

// The daemon dispatches on the host platform; pick the matching modifiers.
const isMac = process.platform === "darwin";
const heldMods: ModifierState = isMac
  ? { ctrl: true, alt: false, meta: true }
  : { ctrl: true, alt: true, meta: false };
const downKey = (name: string): KeyEvent => ({ state: "DOWN", name });

function cachedConfig() {
  return new InMemoryConfigStore({ pcInput: "HDMI2", token: "test-token", deviceId: "tv1", deviceLabel: "TV" });
}

// Let queued microtasks (the fire-and-forget triggers) settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SMARTTHINGS_TOKEN", "");
});

describe("runDaemon hotkeys", () => {
  it("E wakes the TV and switches to PC", async () => {
    const api = new FakeTVApi([onPc]);
    const keys = new FakeKeyListener();
    const sys = new FakeSystemControl(); // high uptime -> no boot trigger
    const deps = fakeDeps({ tvApi: () => api, config: cachedConfig(), keyListener: keys, system: sys });
    await runDaemon(deps);

    keys.emit(downKey("E"), heldMods);
    await flush();
    expect(api.calls).toContain("getStatus");
    expect(api.calls).not.toContain("powerOff");
  });

  it("Q turns the TV off then sleeps the PC", async () => {
    const api = new FakeTVApi([onPc]);
    const keys = new FakeKeyListener();
    const sys = new FakeSystemControl();
    const deps = fakeDeps({ tvApi: () => api, config: cachedConfig(), keyListener: keys, system: sys });
    await runDaemon(deps);

    keys.emit(downKey("Q"), heldMods);
    await flush();
    await flush();
    expect(api.calls).toContain("powerOff");
    expect(sys.slept).toBe(1);
  });

  it("ignores a second trigger while one is running (cooldown gate)", async () => {
    // Slow API keeps the first trigger 'busy' so the second is gated out.
    let resolveStatus: (s: TVStatus) => void = () => {};
    const slowApi = {
      ...new FakeTVApi([onPc]),
      getStatus: () => new Promise<TVStatus>((r) => (resolveStatus = r)),
    } as unknown as FakeTVApi;
    const callRecorder: string[] = [];
    const tvApi = () => {
      callRecorder.push("construct");
      return slowApi;
    };
    const keys = new FakeKeyListener();
    const deps = fakeDeps({ tvApi, config: cachedConfig(), keyListener: keys, system: new FakeSystemControl() });
    await runDaemon(deps);

    keys.emit(downKey("E"), heldMods); // acquires the gate, then awaits getStatus
    await flush();
    keys.emit(downKey("E"), heldMods); // should be ignored — still busy
    await flush();
    resolveStatus(onPc);
    await flush();
    // Only one trigger ran -> tvApi constructed once.
    expect(callRecorder.length).toBe(1);
  });
});

describe("runDaemon boot + wake", () => {
  it("reconciles the TV when started near boot", async () => {
    const api = new FakeTVApi([onPc]);
    const deps = fakeDeps({
      tvApi: () => api,
      config: cachedConfig(),
      keyListener: new FakeKeyListener(),
      system: new FakeSystemControl(10), // uptime 10s < 120s window
    });
    await runDaemon(deps);
    await flush();
    expect(api.calls).toContain("getStatus");
  });

  it("does not reconcile when started long after boot", async () => {
    const api = new FakeTVApi([onPc]);
    const deps = fakeDeps({
      tvApi: () => api,
      config: cachedConfig(),
      keyListener: new FakeKeyListener(),
      system: new FakeSystemControl(9999),
    });
    await runDaemon(deps);
    await flush();
    expect(api.calls).toEqual([]); // no trigger fired
  });

  it("wakes the TV when the PC resumes from sleep", async () => {
    const api = new FakeTVApi([onPc]);
    const wake = new FakeWakeNotifier();
    const deps = fakeDeps({
      tvApi: () => api,
      config: cachedConfig(),
      keyListener: new FakeKeyListener(),
      wakeNotifier: wake,
      system: new FakeSystemControl(9999),
    });
    await runDaemon(deps);
    wake.fire(120_000);
    await flush();
    expect(api.calls).toContain("getStatus");
  });

  it("stop() tears down the key listener and wake notifier", async () => {
    const keys = new FakeKeyListener();
    const wake = new FakeWakeNotifier();
    const deps = fakeDeps({
      tvApi: () => new FakeTVApi([onPc]),
      config: cachedConfig(),
      keyListener: keys,
      wakeNotifier: wake,
      system: new FakeSystemControl(9999),
    });
    const stop = await runDaemon(deps);
    stop();
    expect(keys.stopped).toBe(true);
    expect(wake.stopped).toBe(true);
  });
});
