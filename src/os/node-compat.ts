// Node 23+ removed the long-deprecated `util.isObject` / `util.isFunction`, but
// `sudo-prompt` (a transitive dependency of node-global-key-listener, used on macOS
// to chmod the helper binary) still calls them. It captures `require('util')` by
// reference, which is the same object as this default import, so restoring the two
// helpers here fixes it for the whole process. Import this module FIRST.
import util from "node:util";

const u = util as unknown as {
  isObject?: (v: unknown) => boolean;
  isFunction?: (v: unknown) => boolean;
};

if (typeof u.isObject !== "function") {
  u.isObject = (v: unknown) => v !== null && typeof v === "object";
}
if (typeof u.isFunction !== "function") {
  u.isFunction = (v: unknown) => typeof v === "function";
}
