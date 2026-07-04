// Mirror of the highlighting rules in src/log.ts, kept in sync by hand (they're module-private
// there, and importing log.ts at runtime would crash the sandboxed renderer — it touches
// `process`). The leading timestamp is dimmed, and "variable" tokens — quoted strings, counts
// like 1/3, numbers incl. units, → / ✅ — are colored.

const TIMESTAMP_RE = /^\[\d{1,2}:\d{2}:\d{2}(?:\s?[AP]M)?\]/i;
const VAR_RE = /("[^"]*"|`[^`]*`)|(\b\d+(?:\.\d+)?(?:\/\d+)?(?:\s?(?:ms|s|min|m))?\b)|([→✅])/g;

export type TokenKind = "ts" | "var-string" | "var-num" | "text";

export interface Token {
  kind: TokenKind;
  text: string;
}

// Split a log message into styled tokens; "text" runs render unstyled.
export function tokenize(message: string): Token[] {
  const tokens: Token[] = [];
  let body = message;
  const ts = body.match(TIMESTAMP_RE);
  if (ts) {
    tokens.push({ kind: "ts", text: ts[0] });
    body = body.slice(ts[0].length);
  }
  let last = 0;
  for (const m of body.matchAll(VAR_RE)) {
    const start = m.index ?? 0;
    if (start > last) tokens.push({ kind: "text", text: body.slice(last, start) });
    tokens.push({ kind: m[1] || m[3] ? "var-string" : "var-num", text: m[0] });
    last = start + m[0].length;
  }
  if (last < body.length) tokens.push({ kind: "text", text: body.slice(last) });
  return tokens;
}

// The daemon prefixes some lines with \n as a visual separator; render that as real spacing.
export function hasLeadingNewline(message: string): boolean {
  return message.startsWith("\n");
}

export function stripLeadingNewlines(message: string): string {
  return message.replace(/^\n+/, "");
}
