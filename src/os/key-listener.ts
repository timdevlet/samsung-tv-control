// Adapter over node-global-key-listener implementing the KeyListener port. Maps the
// library's event/modifier shapes into the neutral domain shapes (KeyEvent/ModifierState)
// so the rest of the app never imports the library types.
//
// The listener ships an unexecutable helper binary; npm drops the +x bit. We chmod it up
// front (no sudo) before the first spawn — best-effort; the library's own sudo-prompt
// fallback still applies on failure.

import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  GlobalKeyboardListener,
  type IGlobalKeyEvent,
  type IGlobalKeyDownMap,
} from "node-global-key-listener";
import type { KeyEvent, ModifierState } from "../domain.js";
import type { KeyListener } from "../interfaces.js";

function ensureKeyServerExecutable(): void {
  if (process.platform === "win32") return; // .exe needs no chmod
  const binary = process.platform === "darwin" ? "MacKeyServer" : "X11KeyServer";
  try {
    const require = createRequire(import.meta.url);
    let root: string;
    try {
      root = dirname(require.resolve("node-global-key-listener/package.json"));
    } catch {
      // entry resolves to <root>/build/index.js → package root is two levels up.
      root = dirname(dirname(require.resolve("node-global-key-listener")));
    }
    const binPath = join(root, "bin", binary);
    if (existsSync(binPath)) chmodSync(binPath, 0o755);
  } catch {
    /* best-effort */
  }
}

function toModifiers(down: IGlobalKeyDownMap): ModifierState {
  return {
    ctrl: Boolean(down["LEFT CTRL"] || down["RIGHT CTRL"]),
    alt: Boolean(down["LEFT ALT"] || down["RIGHT ALT"]),
    meta: Boolean(down["LEFT META"] || down["RIGHT META"]),
  };
}

/** Production KeyListener backed by node-global-key-listener. */
export function globalKeyListener(): KeyListener {
  let keyboard: GlobalKeyboardListener | undefined;
  return {
    async start(onKey: (e: KeyEvent, mods: ModifierState) => void) {
      ensureKeyServerExecutable();
      keyboard = new GlobalKeyboardListener();
      await keyboard.addListener((e: IGlobalKeyEvent, down: IGlobalKeyDownMap) => {
        onKey({ state: e.state, name: e.name }, toModifiers(down));
      });
    },
    stop() {
      keyboard?.kill();
      keyboard = undefined;
    },
  };
}
