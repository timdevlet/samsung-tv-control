// Pure display/selection helpers for the MultiSelect component, split out so they're unit-testable
// without a DOM.

// How many of the given option values are selected, plus the derived "all / some" flags. Counts
// only among the passed values so a stale id in `selected` (an option that dropped off the list)
// doesn't inflate the count or wrongly flip "Select all" to fully-checked.
export function selectionState(
  optionValues: readonly string[],
  selected: ReadonlySet<string>,
): { count: number; total: number; allChecked: boolean; someChecked: boolean } {
  const total = optionValues.length;
  const count = optionValues.reduce((n, v) => n + (selected.has(v) ? 1 : 0), 0);
  return {
    count,
    total,
    allChecked: total > 0 && count === total,
    someChecked: count > 0 && count < total,
  };
}

// The counter-only trigger text: "No TVs" / "1 TV" / "3 TVs" / "All TVs", or the placeholder when
// there's nothing to choose from. When `emptyMeansAll` is set, a zero selection reads "All TVs"
// too — for callers (like a command target) where an empty list is a "fall back to everything"
// sentinel rather than a literal none.
export function triggerLabel(
  count: number,
  total: number,
  noun: string,
  placeholder: string,
  emptyMeansAll = false,
): string {
  if (total === 0) return placeholder;
  if (count === 0) return emptyMeansAll ? `All ${noun}s` : `No ${noun}s`;
  if (count === total) return `All ${noun}s`;
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
