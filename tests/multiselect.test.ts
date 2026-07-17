import { describe, it, expect } from "vitest";
import { selectionState, triggerLabel } from "../src/electron/renderer/src/lib/multiselect.js";

describe("selectionState", () => {
  const opts = ["a", "b", "c"];

  it("reports none selected", () => {
    expect(selectionState(opts, new Set())).toEqual({
      count: 0,
      total: 3,
      allChecked: false,
      someChecked: false,
    });
  });

  it("reports a partial selection as someChecked", () => {
    expect(selectionState(opts, new Set(["a", "b"]))).toEqual({
      count: 2,
      total: 3,
      allChecked: false,
      someChecked: true,
    });
  });

  it("reports a full selection as allChecked", () => {
    expect(selectionState(opts, new Set(["a", "b", "c"]))).toEqual({
      count: 3,
      total: 3,
      allChecked: true,
      someChecked: false,
    });
  });

  it("ignores ids not present in the options (stale selection)", () => {
    // "z" dropped off the list but lingers in the set — it must not inflate the count or flip
    // Select-all to fully-checked.
    const state = selectionState(opts, new Set(["a", "z"]));
    expect(state.count).toBe(1);
    expect(state.allChecked).toBe(false);
    expect(state.someChecked).toBe(true);
  });

  it("with no options is neither all nor some checked", () => {
    expect(selectionState([], new Set(["a"]))).toEqual({
      count: 0,
      total: 0,
      allChecked: false,
      someChecked: false,
    });
  });
});

describe("triggerLabel", () => {
  it("shows the placeholder when there are no options", () => {
    expect(triggerLabel(0, 0, "TV", "Sign in to load your TVs.")).toBe("Sign in to load your TVs.");
  });

  it("shows 'No TVs' when none are selected", () => {
    expect(triggerLabel(0, 3, "TV", "None")).toBe("No TVs");
  });

  it("shows a singular counter for one", () => {
    expect(triggerLabel(1, 3, "TV", "None")).toBe("1 TV");
  });

  it("shows a plural counter for several", () => {
    expect(triggerLabel(2, 3, "TV", "None")).toBe("2 TVs");
  });

  it("shows 'All TVs' when every option is selected", () => {
    expect(triggerLabel(3, 3, "TV", "None")).toBe("All TVs");
  });

  it("with emptyMeansAll, a zero selection reads 'All TVs' instead of 'No TVs'", () => {
    expect(triggerLabel(0, 3, "TV", "None", true)).toBe("All TVs");
    // A partial selection is still a count, and full is still "All".
    expect(triggerLabel(1, 3, "TV", "None", true)).toBe("1 TV");
    expect(triggerLabel(3, 3, "TV", "None", true)).toBe("All TVs");
  });
});
