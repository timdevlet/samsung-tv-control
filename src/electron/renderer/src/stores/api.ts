// The renderer's single seam to the preload bridge: every IPC call the UI or a store makes goes
// through `api`, so `window.tvAPI` is touched nowhere else in the renderer. Each method resolves
// the bridge lazily, per call — the store modules are imported by the node-environment unit
// tests, where neither `window` nor the bridge exists, so grabbing `window.tvAPI` at module load
// would crash them. The `TvAPI` annotation keeps this mirror complete: a method added to the
// preload without a wrapper here fails `npm run typecheck`.

// Type-only import — the preload module itself must never be loaded here (its graph reaches
// node: modules and `process`, which don't exist in the sandboxed renderer); erased at build.
import type { TvAPI } from "../../../preload.js";

export type { DeviceListResult, DeviceStatusResult, TvAPI } from "../../../preload.js";

export const api: TvAPI = {
  onLog: (cb) => window.tvAPI.onLog(cb),
  getHistory: () => window.tvAPI.getHistory(),
  clearHistory: () => window.tvAPI.clearHistory(),
  runCommand: (cmd) => window.tvAPI.runCommand(cmd),
  sendKeys: (deviceId, keys) => window.tvAPI.sendKeys(deviceId, keys),
  authStatus: () => window.tvAPI.authStatus(),
  login: () => window.tvAPI.login(),
  logout: () => window.tvAPI.logout(),
  getAppVersion: () => window.tvAPI.getAppVersion(),
  getSettings: () => window.tvAPI.getSettings(),
  saveSettings: (partial) => window.tvAPI.saveSettings(partial),
  listTVs: () => window.tvAPI.listTVs(),
  getStatuses: (deviceIds) => window.tvAPI.getStatuses(deviceIds),
  discoverTVs: () => window.tvAPI.discoverTVs(),
  pairTV: (args) => window.tvAPI.pairTV(args),
  setHotkeysSuspended: (suspended) => window.tvAPI.setHotkeysSuspended(suspended),
  onOpenSettings: (cb) => window.tvAPI.onOpenSettings(cb),
};
