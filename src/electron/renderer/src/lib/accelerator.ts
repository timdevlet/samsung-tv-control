// KeyboardEvent → Electron accelerator decision table, pure so it's unit-testable. A valid combo
// needs at least one modifier plus a non-modifier key, so a global shortcut can't swallow normal
// typing.

const NAMED_KEYS: Record<string, string> = {
  Space: "Space",
  Enter: "Return",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Escape: "Escape",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Equal: "Plus",
  Minus: "-",
};

// Map a KeyboardEvent.code to the accelerator key token Electron expects, or null for a press
// with no non-modifier key (e.g. a bare modifier).
export function acceleratorKeyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3); // KeyE → E
  if (/^Digit\d$/.test(code)) return code.slice(5); // Digit1 → 1
  if (/^F\d{1,2}$/.test(code)) return code; // F1..F24
  return NAMED_KEYS[code] ?? null;
}

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

export type CaptureResult =
  | { kind: "cancel" } // Escape — keep the previous value
  | { kind: "pending" } // modifier-only press — keep waiting for the real key
  | { kind: "invalid"; reason: string } // bare key — needs a modifier
  | { kind: "accelerator"; accelerator: string };

export function captureFromEvent(e: KeyLike): CaptureResult {
  if (e.key === "Escape") return { kind: "cancel" };
  const key = acceleratorKeyFromCode(e.code);
  if (!key) return { kind: "pending" };
  const mods: string[] = [];
  if (e.metaKey) mods.push("Command");
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (mods.length === 0) {
    return { kind: "invalid", reason: "Hotkey needs at least one modifier (⌘/Ctrl/Alt/Shift)." };
  }
  return { kind: "accelerator", accelerator: [...mods, key].join("+") };
}
