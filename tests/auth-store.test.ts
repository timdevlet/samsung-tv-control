import { describe, expect, it } from "vitest";
import type { AuthStatus } from "../src/electron/auth.js";
import { createAuthStore } from "../src/electron/renderer/src/stores/authStore.js";

const signedIn: AuthStatus = { hasClient: true, authorized: true };
const signedOut: AuthStatus = { hasClient: true, authorized: false };

// One controllable fetch per refresh() call, resolved by the test in any order.
function stubFetcher() {
  const pending: { resolve: (s: AuthStatus) => void }[] = [];
  const fetch = () =>
    new Promise<AuthStatus>((resolve) => {
      pending.push({ resolve });
    });
  return { fetch, pending };
}

describe("createAuthStore", () => {
  it("starts null, then exposes and resolves the fetched status", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createAuthStore(fetch);
    expect(store.getSnapshot()).toBeNull();

    const seen: (AuthStatus | null)[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()));
    const result = store.refresh();
    pending[0].resolve(signedIn);
    await expect(result).resolves.toEqual(signedIn);
    expect(store.getSnapshot()).toEqual(signedIn);
    expect(seen).toEqual([signedIn]);
    unsubscribe();
  });

  it("keeps only the newest refresh's result when they resolve out of order", async () => {
    const { fetch, pending } = stubFetcher();
    const store = createAuthStore(fetch);
    const first = store.refresh();
    const second = store.refresh();

    pending[1].resolve(signedIn); // newest lands first…
    await second;
    pending[0].resolve(signedOut); // …then the stale one
    await first;
    expect(store.getSnapshot()).toEqual(signedIn); // stale result discarded
  });
});
