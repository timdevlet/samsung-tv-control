// Preload: the only bridge between the privileged main process and the sandboxed renderer.
// Exposes a tiny, explicit `window.tvAPI` (contextIsolation is on, nodeIntegration off) — the
// log window can read history, subscribe to new lines, and fire the two TV actions, nothing more.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { LogEntry } from "../log.js";

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
});
