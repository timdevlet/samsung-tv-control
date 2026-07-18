// Tiny logger. The daemon timestamps every line; the one-shot CLI doesn't.
// Call useTimestamps() once at daemon startup to switch modes.
//
// Besides writing to the console, every line is fanned out to any registered
// listeners via onLog(). The Electron app (src/electron/main.ts) uses this to
// mirror the daemon's output into its log window — without the daemon or app
// code needing to know a UI exists.

let stamped = false;

export function useTimestamps(): void {
  stamped = true;
}

function fmt(msg: string): string {
  return stamped ? `[${new Date().toLocaleTimeString()}] ${msg}` : msg;
}

// --- Color highlighting -----------------------------------------------------
// Both surfaces (terminal + Electron window) highlight the same things: the
// leading [HH:MM:SS] timestamp, and "variable" tokens — the dynamic values that
// get interpolated into messages (quoted names, numbers, attempt counts like
// 1/3, statuses, →, ✅). The terminal colors with ANSI (TTY only); the Electron
// renderer wraps the same tokens in <span>s. The rules live here as the single
// source of truth, exported for the renderer to mirror.

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m", // timestamp
  cyan: "\x1b[36m", // quoted strings / arrows / ✅
  yellow: "\x1b[33m", // numbers, counts
} as const;

const TIMESTAMP_RE = /^\[\d{1,2}:\d{2}:\d{2}(?:\s?[AP]M)?\]/i;

// A variable token is one of: a quoted "string", a count like 1/3, a bare
// number (incl. units like 2s/40min), or the → / ✅ markers. Each match becomes
// either "var-string" (cyan) or "var-num" (yellow) when classified.
const VAR_RE = /("[^"]*"|`[^`]*`)|(\b\d+(?:\.\d+)?(?:\/\d+)?(?:\s?(?:ms|s|min|m))?\b)|([→✅])/g;

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

function colorize(message: string): string {
  if (!useColor) return message;

  let body = message;
  let prefix = "";
  const ts = body.match(TIMESTAMP_RE);
  if (ts) {
    prefix = `${ANSI.dim}${ts[0]}${ANSI.reset}`;
    body = body.slice(ts[0].length);
  }

  body = body.replace(VAR_RE, (m, quoted, num, marker) => {
    if (quoted || marker) return `${ANSI.cyan}${m}${ANSI.reset}`;
    if (num) return `${ANSI.yellow}${m}${ANSI.reset}`;
    return m;
  });

  return prefix + body;
}

export type LogLevel = "info" | "error";
export interface LogEntry {
  id: number; // monotonic, process-unique — lets the Electron renderer dedupe history vs live
  level: LogLevel;
  message: string; // already formatted (timestamp prefixed when in daemon mode)
}

// Monotonic counter so every emitted line has a stable identity. The renderer subscribes to live
// logs and also fetches a history backlog; without an id, lines that appear in both (a line logged
// in the narrow window around the window opening) would render twice.
let nextId = 0;

type Listener = (entry: LogEntry) => void;
const listeners = new Set<Listener>();

// Subscribe to every log line. Returns an unsubscribe function.
export function onLog(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(entry: LogEntry): void {
  for (const listener of listeners) listener(entry);
}

export const log = (msg: string): void => {
  const message = fmt(msg);
  console.log(colorize(message));
  // Listeners (Electron window) get the uncolored line; they highlight it
  // themselves with <span>s — see src/electron/renderer/index.html.
  emit({ id: nextId++, level: "info", message });
};

export const logError = (msg: string): void => {
  const message = fmt(msg);
  console.error(colorize(message));
  emit({ id: nextId++, level: "error", message });
};
