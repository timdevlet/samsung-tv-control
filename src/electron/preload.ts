// Preload: the only bridge between the privileged main process and the sandboxed renderer.
// Exposes a tiny, explicit `window.tvAPI` (contextIsolation is on, nodeIntegration off) — the
// log window can read history, subscribe to new lines, and fire the two TV actions, nothing more.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { LogEntry } from "../log.js";
import type { AuthStatus } from "./auth.js";
import type { AppSettings } from "./settings.js";
import type { STDevice } from "../domain/tv.js";

type AuthResult = { ok: true } | { ok: false; error?: string; cancelled?: boolean };
type DeviceListResult =
  | { ok: true; devices: STDevice[] }
  | { ok: false; error: string; notAuthorized?: boolean };

contextBridge.exposeInMainWorld("tvAPI", {
  // Subscribe to live log lines. Returns an unsubscribe function.
  onLog: (cb: (entry: LogEntry) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, entry: LogEntry) => cb(entry);
    ipcRenderer.on("log", handler);
    return () => ipcRenderer.off("log", handler);
  },
  // Fetch the backlog accumulated before the window opened.
  getHistory: (): Promise<LogEntry[]> => ipcRenderer.invoke("log:history"),
  clearHistory: (): void => ipcRenderer.send("log:clear"),
  wakeTv: (): void => ipcRenderer.send("action:on"),
  tvOffSleep: (): void => ipcRenderer.send("action:off"),
  // Auth
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke("auth:status"),
  login: (): Promise<AuthResult> => ipcRenderer.invoke("auth:login"),
  logout: (): Promise<AuthResult> => ipcRenderer.invoke("auth:logout"),
  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
  saveSettings: (partial: Partial<AppSettings>): Promise<AuthResult> =>
    ipcRenderer.invoke("settings:save", partial),
  // The account's TVs, for the Settings device-selection list.
  listTVs: (): Promise<DeviceListResult> => ipcRenderer.invoke("devices:list"),
  // Open the Settings modal when asked from the tray. Returns an unsubscribe function.
  onOpenSettings: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on("open-settings", handler);
    return () => ipcRenderer.off("open-settings", handler);
  },
});
