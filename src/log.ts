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

export type LogLevel = "info" | "error";
export interface LogEntry {
  level: LogLevel;
  message: string; // already formatted (timestamp prefixed when in daemon mode)
}

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
  console.log(message);
  emit({ level: "info", message });
};

export const logError = (msg: string): void => {
  const message = fmt(msg);
  console.error(message);
  emit({ level: "error", message });
};
