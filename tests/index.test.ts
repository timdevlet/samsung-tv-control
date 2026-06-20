import { describe, it, expect, beforeEach, vi } from "vitest";
import { run, turnOff, resolveAccessToken } from "../src/index.js";
import type { TVStatus } from "../src/domain.js";
import {
  fakeDeps,
  FakeTVApi,
  InMemoryConfigStore,
  FakeOAuthClient,
} from "./fakes.js";

const onPc: TVStatus = { power: "on", inputCapability: "mediaInputSource", currentInput: "HDMI2", sources: [{ id: "HDMI2", name: "PC" }] };
const offStatus: TVStatus = { power: "off", inputCapability: "mediaInputSource", currentInput: undefined, sources: [{ id: "HDMI2", name: "PC" }] };
const onWrongInput: TVStatus = { power: "on", inputCapability: "mediaInputSource", currentInput: "HDMI1", sources: [{ id: "HDMI2", name: "PC" }] };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SMARTTHINGS_TOKEN", "");
});

describe("run()", () => {
  it("when off: powers on, re-reads status, then switches input", async () => {
    // First read sees it off; after wake the second read sees it on the wrong input.
    const api = new FakeTVApi([offStatus, onWrongInput]);
    await run(undefined, fakeDeps({ tvApi: () => api, config: cachedConfig() }));
    expect(api.calls).toEqual(["getStatus", "powerOn", "getStatus", "setInputSource"]);
    expect(api.setInputCalls).toEqual([{ deviceId: "tv1", capability: "mediaInputSource", source: "HDMI2" }]);
  });

  it("when on but on the wrong input: no powerOn, single status read, switches input", async () => {
    const api = new FakeTVApi([onWrongInput]);
    await run(undefined, fakeDeps({ tvApi: () => api, config: cachedConfig() }));
    expect(api.calls).not.toContain("powerOn");
    expect(api.calls.filter((c) => c === "getStatus").length).toBe(1);
    expect(api.setInputCalls).toEqual([{ deviceId: "tv1", capability: "mediaInputSource", source: "HDMI2" }]);
  });

  it("when on and already on the target input: does nothing further", async () => {
    const api = new FakeTVApi([onPc]);
    await run(undefined, fakeDeps({ tvApi: () => api, config: cachedConfig() }));
    expect(api.calls).not.toContain("powerOn");
    expect(api.setInputCalls).toEqual([]);
  });

  it("throws when the device exposes no input capability", async () => {
    const api = new FakeTVApi([{ power: "on", sources: [] }]);
    await expect(run(undefined, fakeDeps({ tvApi: () => api, config: cachedConfig() }))).rejects.toThrow(/input-source capability/);
  });

  it("honors an input override", async () => {
    const api = new FakeTVApi([onWrongInput]);
    await run("HDMI2", fakeDeps({ tvApi: () => api, config: cachedConfig() }));
    expect(api.setInputCalls[0].source).toBe("HDMI2");
  });
});

describe("turnOff()", () => {
  it("does nothing when the TV is already off", async () => {
    const api = new FakeTVApi([offStatus]);
    await turnOff(fakeDeps({ tvApi: () => api, config: cachedConfig() }));
    expect(api.calls).not.toContain("powerOff");
  });

  it("leaves the TV on when it isn't on the PC input", async () => {
    const api = new FakeTVApi([onWrongInput]);
    await turnOff(fakeDeps({ tvApi: () => api, config: cachedConfig() }));
    expect(api.calls).not.toContain("powerOff");
  });

  it("powers off when on the PC input", async () => {
    const api = new FakeTVApi([onPc]);
    await turnOff(fakeDeps({ tvApi: () => api, config: cachedConfig() }));
    expect(api.calls).toContain("powerOff");
  });
});

describe("resolveAccessToken()", () => {
  it("prefers the SMARTTHINGS_TOKEN env var", async () => {
    vi.stubEnv("SMARTTHINGS_TOKEN", "env-token");
    const token = await resolveAccessToken({ pcInput: "x" }, fakeDeps());
    expect(token).toBe("env-token");
  });

  it("uses OAuth refresh when a client + refresh token are configured", async () => {
    const oauth = new FakeOAuthClient();
    const config = new InMemoryConfigStore({ pcInput: "x" });
    const deps = fakeDeps({ oauth, config });
    const token = await resolveAccessToken(
      { pcInput: "x", clientId: "c", clientSecret: "s", refreshToken: "r" },
      deps,
    );
    expect(token).toBe("new-access");
    expect(oauth.refreshCalls).toBe(1);
    expect(config.saved.length).toBe(1); // rotated token persisted
  });

  it("falls back to a static PAT in config", async () => {
    const token = await resolveAccessToken({ pcInput: "x", token: "pat" }, fakeDeps());
    expect(token).toBe("pat");
  });

  it("throws a helpful error when nothing is configured", async () => {
    await expect(resolveAccessToken({ pcInput: "x" }, fakeDeps())).rejects.toThrow(/No SmartThings credentials/);
  });
});

// A config store with the device already cached so run()/turnOff() skip discovery.
function cachedConfig() {
  return new InMemoryConfigStore({ pcInput: "HDMI2", token: "test-token", deviceId: "tv1", deviceLabel: "TV" });
}
