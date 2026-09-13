import { describe, expect, it } from "vitest";

import {
  crossedEntryOnsetForTest,
  neweyWestMeanForOnsetTest,
} from "./v8EntryOnsetThreshold";

describe("V8 entry onset threshold helpers", () => {
  it("counts only a true below-to-at-or-above threshold crossing", () => {
    expect(crossedEntryOnsetForTest(5.5, 6.0, 60)).toBe(true);
    expect(crossedEntryOnsetForTest(5.5, 6.5, 60)).toBe(true);
    expect(crossedEntryOnsetForTest(6.0, 6.5, 60)).toBe(false);
    expect(crossedEntryOnsetForTest(6.5, 5.5, 60)).toBe(false);
    expect(crossedEntryOnsetForTest(null, 6.0, 60)).toBe(false);
    expect(crossedEntryOnsetForTest(5.5, null, 60)).toBe(false);
  });

  it("returns a finite Newey-West estimate for a non-degenerate series", () => {
    const result = neweyWestMeanForOnsetTest([1, 2, 1.5, 2.5, 3, 2.2, 1.8, 2.7], 2);
    expect(result.n).toBe(8);
    expect(result.mean).not.toBeNull();
    expect(Number.isFinite(result.mean!)).toBe(true);
    expect(Number.isFinite(result.t!)).toBe(true);
    expect(result.ciLow).not.toBeNull();
    expect(result.ciHigh).not.toBeNull();
  });
});
