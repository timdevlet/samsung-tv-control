import { describe, it, expect } from "vitest";
import {
  pushToast,
  beginLeave,
  removeToast,
  depthOf,
  MAX_STORED,
  type Toast,
} from "../src/electron/renderer/src/lib/toasts.js";

const toast = (id: number, leaving = false): Toast => ({
  id,
  kind: "success",
  text: `toast ${id}`,
  ...(leaving ? { leaving } : {}),
});

describe("pushToast", () => {
  it("appends the new toast last", () => {
    const { toasts, dropped } = pushToast([toast(1)], toast(2));
    expect(toasts.map((t) => t.id)).toEqual([1, 2]);
    expect(dropped).toEqual([]);
  });

  it("drops the oldest beyond MAX_STORED and reports it", () => {
    let list: Toast[] = [];
    for (let id = 1; id <= MAX_STORED; id++) list = pushToast(list, toast(id)).toasts;
    const { toasts, dropped } = pushToast(list, toast(MAX_STORED + 1));
    expect(toasts).toHaveLength(MAX_STORED);
    expect(toasts[0].id).toBe(2);
    expect(dropped).toEqual([1]);
  });
});

describe("beginLeave", () => {
  it("flags the toast without removing it", () => {
    const list = beginLeave([toast(1), toast(2)], 1);
    expect(list).toHaveLength(2);
    expect(list[0].leaving).toBe(true);
    expect(list[1].leaving).toBeUndefined();
  });
});

describe("removeToast", () => {
  it("removes only the matching toast", () => {
    expect(removeToast([toast(1), toast(2)], 1).map((t) => t.id)).toEqual([2]);
  });
});

describe("depthOf", () => {
  it("gives depth 0 to the newest (last) toast, counting up toward the oldest", () => {
    const list = [toast(1), toast(2), toast(3)];
    expect(depthOf(list, 2)).toBe(0);
    expect(depthOf(list, 1)).toBe(1);
    expect(depthOf(list, 0)).toBe(2);
  });

  it("skips leaving toasts so the stack shuffles forward immediately", () => {
    const list = [toast(1), toast(2), toast(3, true)];
    expect(depthOf(list, 1)).toBe(0);
    expect(depthOf(list, 0)).toBe(1);
  });
});
