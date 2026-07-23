// Pure truncation for the copyable id chip (rendering + clipboard live in components/Id.tsx).
// Kept side-effect-free so tests/id.test.ts can cover it with the node-environment runner.

// Shorten an opaque id to its last `tail` characters, with an ellipsis to signal truncation.
// Ids at or under the limit come back unchanged.
export function shortId(id: string, tail = 6): string {
  if (id.length <= tail) return id;
  return `…${id.slice(-tail)}`;
}
