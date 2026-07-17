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

// Display order and labels for the modifier chips: conventional rank (Ctrl, Alt, Shift, Cmd — same
// as hotkeyLabel in src/domain/daemon.ts), mac symbols vs text names elsewhere.
const MOD_DISPLAY: readonly { token: string; mac: string; other: string }[] = [
  { token: "Control", mac: "⌃", other: "Ctrl" },
  { token: "Alt", mac: "⌥", other: "Alt" },
  { token: "Shift", mac: "⇧", other: "Shift" },
  { token: "Command", mac: "⌘", other: "Win" },
];

// Key tokens with a well-known glyph; everything else (letters, digits, F-keys, Space) is shown
// as-is.
const KEY_GLYPHS: Record<string, string> = {
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Return: "↩",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
};

export type AcceleratorPart = { token: string; label: string; kind: "mod" | "key" };

// Split a stored accelerator string into display chips: modifiers first (reordered to the
// conventional rank above, whatever order they were stored in), then the key. Display-only —
// the stored string is untouched.
export function acceleratorParts(accelerator: string, isMac: boolean): AcceleratorPart[] {
  if (!accelerator) return [];
  const tokens = accelerator.split("+");
  const mods = MOD_DISPLAY.filter((m) => tokens.includes(m.token)).map((m) => ({
    token: m.token,
    label: isMac ? m.mac : m.other,
    kind: "mod" as const,
  }));
  const keys = tokens
    .filter((t) => !MOD_DISPLAY.some((m) => m.token === t))
    .map((t) => ({ token: t, label: KEY_GLYPHS[t] ?? t, kind: "key" as const }));
  return [...mods, ...keys];
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
