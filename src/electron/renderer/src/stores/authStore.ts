// Shared cloud (SmartThings) auth snapshot: null until the first fetch. One store, so App's
// Settings gating and any future consumer read the same state instead of each fetching its own
// copy. Framework-free (React binds via hooks/useAuth) so it's unit-testable in the node vitest
// env like the other stores.

import type { AuthStatus } from "../types";
import { api } from "./api";

export function createAuthStore(fetchStatus: () => Promise<AuthStatus>) {
  let snapshot: AuthStatus | null = null;
  const listeners = new Set<() => void>();
  // Monotonic fetch id: concurrent refreshes (a sign-in and an autosaved client edit can both
  // refetch) may resolve out of order; only the newest call's result becomes the snapshot.
  let seq = 0;

  return {
    getSnapshot: (): AuthStatus | null => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Re-fetch after anything that can change auth (opening Settings, sign-in/out, OAuth client
    // edits). Resolves with the fresh status so callers can react to it directly.
    async refresh(): Promise<AuthStatus> {
      const mySeq = ++seq;
      const next = await fetchStatus();
      if (mySeq === seq) {
        snapshot = next;
        for (const l of listeners) l();
      }
      return next;
    },
  };
}

export const authStore = createAuthStore(api.authStatus);
