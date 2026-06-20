// Tiny logger. The daemon timestamps every line; the one-shot CLI doesn't.
// Call useTimestamps() once at daemon startup to switch modes.

let stamped = false;

export function useTimestamps(): void {
  stamped = true;
}

function fmt(msg: string): string {
  return stamped ? `[${new Date().toLocaleTimeString()}] ${msg}` : msg;
}

export const log = (msg: string): void => console.log(fmt(msg));
export const logError = (msg: string): void => console.error(fmt(msg));
