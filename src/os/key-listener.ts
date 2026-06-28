// Adapter over uiohook-napi. Maps the library's keycode/modifier-flag events into the
// neutral domain shapes (KeyEvent/ModifierState) so the rest of the app never imports the
// library types.
//
// We use uiohook-napi (not node-global-key-listener) specifically for Windows: it installs a
// real low-level system keyboard hook (WH_KEYBOARD_LL), so keys are captured regardless of
// which window is focused. The previous library's Windows backend only saw keystrokes routed
// to its own foreground window, so the hotkey worked only while the app was focused.

import {
  uIOhook,
  UiohookKey,
  type UiohookKeyboardEvent,
} from "uiohook-napi";
import type { KeyEvent, ModifierState } from "../domain/daemon.js";

// Reverse UiohookKey (name -> keycode) into keycode -> name so events carry the same key
// names the domain matcher expects (e.g. "E", "Q").
const KEYCODE_TO_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(UiohookKey).map(([name, code]) => [code as number, name]),
);

function toModifiers(e: UiohookKeyboardEvent): ModifierState {
  return { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey };
}

// Start listening for global key events, mapped to neutral domain shapes. Returns a stop
// function. Backed by uiohook-napi (system-wide low-level keyboard hook).
export async function startKeyListener(
  onKey: (e: KeyEvent, mods: ModifierState) => void,
): Promise<() => void> {
  const emit = (state: "DOWN" | "UP") => (e: UiohookKeyboardEvent) => {
    onKey({ state, name: KEYCODE_TO_NAME[e.keycode] }, toModifiers(e));
  };
  const onDown = emit("DOWN");
  const onUp = emit("UP");

  uIOhook.on("keydown", onDown);
  uIOhook.on("keyup", onUp);
  uIOhook.start();

  return () => {
    uIOhook.off("keydown", onDown);
    uIOhook.off("keyup", onUp);
    uIOhook.stop();
  };
}
