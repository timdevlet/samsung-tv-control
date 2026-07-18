import { memo } from "react";
import { hasLeadingNewline, stripLeadingNewlines, tokenize } from "../../lib/highlight";
import type { LogEntry } from "../../types";
import "./LogLine.scss";

// One log line, tokenized for highlighting. Memoized: entries are immutable and keyed by their
// monotonic id, so appends only render the new tail.
export const LogLine = memo(function LogLine({ entry }: { entry: LogEntry }) {
  const tokens = tokenize(stripLeadingNewlines(entry.message));
  return (
    <div
      className={entry.level === "error" ? "line error" : "line"}
      // Blank-line separators (the daemon prefixes some lines with \n) render as real spacing.
      style={hasLeadingNewline(entry.message) ? { marginTop: 8 } : undefined}
    >
      {tokens.map((token, i) =>
        token.kind === "text" ? (
          token.text
        ) : (
          <span key={i} className={token.kind}>
            {token.text}
          </span>
        ),
      )}
    </div>
  );
});
