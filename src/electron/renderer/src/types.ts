// Renderer-local aliases for the shared main-process types. Type-only re-exports — erased at
// build, so none of the node-side modules are ever loaded in the sandboxed renderer.

export type { CommandAction, ThemePreference } from "../../../domain/config.js";
export type { DevicePower, STDevice } from "../../../domain/tv.js";
export type { LogEntry } from "../../../log.js";
export type { AuthStatus } from "../../auth.js";
export type { AppSettings, CommandSettings, DeviceConfigSettings } from "../../settings.js";
