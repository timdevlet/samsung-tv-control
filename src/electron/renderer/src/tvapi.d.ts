// The renderer's view of the preload bridge, derived from the implementation so any drift fails
// `npm run typecheck`. Type-only import — the preload module itself must never be loaded here
// (its graph reaches node: modules and `process`, which don't exist in the sandboxed renderer);
// types are erased at build.
import type { TvAPI } from "../../preload.js";

declare global {
  interface Window {
    tvAPI: TvAPI;
  }
}
