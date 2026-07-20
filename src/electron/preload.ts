// Preload: the only bridge between the privileged main process and the sandboxed renderer.
// Exposes a tiny, explicit `window.tvAPI` (contextIsolation is on, nodeIntegration off) — the
// log window can read history, subscribe to new lines, and run user commands, nothing more.

import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import type { CommandConfig } from "../domain/config.js";
import type { ActionResult } from "../domain/daemon.js";
import type { DevicePower, STDevice } from "../domain/tv.js";
import type { LogEntry } from "../log.js";
import type { AuthStatus } from "./auth.js";
import type { AppSettings } from "./settings.js";

type AuthResult = { ok: true } | { ok: false; error?: string; cancelled?: boolean };
type DeviceListResult =
  | { ok: true; devices: STDevice[] }
  | { ok: false; error: string; notAuthorized?: boolean };
type DeviceStatusResult =
  | { ok: true; statuses: Record<string, DevicePower> }
  | { ok: false; error: string };
type DiscoveredTV = { host: string; name?: string; mac?: string };
type DiscoverResult = { ok: true; candidates: DiscoveredTV[] } | { ok: false; error: string };
type PairResult = { ok: true; deviceId: string } | { ok: false; error?: string };

const tvAPI = {
  // Subscribe to live log lines. Returns an unsubscribe function.
  onLog: (cb: (entry: LogEntry) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, entry: LogEntry) => cb(entry);
    ipcRenderer.on("log", handler);
    return () => ipcRenderer.off("log", handler);
  },
  // Fetch the backlog accumulated before the window opened.
  getHistory: (): Promise<LogEntry[]> => ipcRenderer.invoke("log:history"),
  clearHistory: (): void => ipcRenderer.send("log:clear"),
  // Run a user-defined command (Settings → Commands) as currently shown in the UI.
  runCommand: (cmd: CommandConfig): Promise<ActionResult> => ipcRenderer.invoke("command:run", cmd),
  // Send an explicit remote-key sequence to one LAN TV (Settings → the per-TV "Run key sequence"
  // button). The keys are the user's raw tokens (comma-split); the main process normalizes them.
  sendKeys: (deviceId: string, keys: string[]): Promise<ActionResult> =>
    ipcRenderer.invoke("tv:send-keys", { deviceId, keys }),
  // Auth
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke("auth:status"),
  login: (): Promise<AuthResult> => ipcRenderer.invoke("auth:login"),
  logout: (): Promise<AuthResult> => ipcRenderer.invoke("auth:logout"),
  // The app version (from package.json, kept in sync with the git tag by scripts/sync-version.mjs).
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
  saveSettings: (partial: Partial<AppSettings>): Promise<AuthResult> =>
    ipcRenderer.invoke("settings:save", partial),
  // The account's TVs, for the Settings device-selection list.
  listTVs: (): Promise<DeviceListResult> => ipcRenderer.invoke("devices:list"),
  // Live power of the given TVs, for the Settings list's status pills. Batched in one round-trip;
  // an unreachable TV resolves to "unknown" rather than failing the call.
  getStatuses: (deviceIds: string[]): Promise<DeviceStatusResult> =>
    ipcRenderer.invoke("devices:status", deviceIds),
  // Local transport: find Samsung TVs on the LAN, and pair with one (pops the on-screen Allow
  // and stores the returned token).
  discoverTVs: (): Promise<DiscoverResult> => ipcRenderer.invoke("tv:discover"),
  pairTV: (args: { deviceId?: string; host: string; mac: string }): Promise<PairResult> =>
    ipcRenderer.invoke("tv:pair", args),
  // Tell the main process whether the Settings tab is open. While it is, the daemon suspends its
  // global command hotkeys so a combo typed into a capture field isn't swallowed by its own live
  // registration (which is what blocks re-entering an already-bound combo).
  setHotkeysSuspended: (suspended: boolean): void => ipcRenderer.send("hotkeys:suspend", suspended),
  // Open the Settings modal when asked from the tray. Returns an unsubscribe function.
  onOpenSettings: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on("open-settings", handler);
    return () => ipcRenderer.off("open-settings", handler);
  },
};

// Single source of truth for the renderer: window.tvAPI is typed as exactly this object (the
// renderer's tvapi.d.ts imports this type), so any preload/renderer drift fails `npm run
// typecheck`. Type-only export — nothing extra lands in the bundle.
export type TvAPI = typeof tvAPI;

contextBridge.exposeInMainWorld("tvAPI", tvAPI);
