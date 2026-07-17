// Renderer-local aliases for the shared main-process types. Type-only re-exports — erased at
// build, so none of the node-side modules are ever loaded in the sandboxed renderer.
export type { LogEntry } from "../../../log.js";
export type { AuthStatus } from "../../auth.js";
export type { AppSettings, DeviceConfigSettings, CommandSettings } from "../../settings.js";
export type {
  CommandAction,
  MainButtons,
  MainButtonKey,
  ThemePreference,
} from "../../../domain/config.js";
export type { STDevice } from "../../../domain/tv.js";
