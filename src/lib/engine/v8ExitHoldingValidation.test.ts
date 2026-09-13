import { describe, expect, it } from "vitest";

import {
  crossedDownPercentForTest,
  crossedUpPercentForTest,
  neweyWestMeanForExitTest,
  shouldBlockOnsetForTest,
} from "./v8ExitHoldingValidation";

describe("V8 exit and holding validation helpers", () => {
  it("detects score threshold crossings on the 0-100 scale", () => {
    expect(crossedUpPercentForTest(8.5, 9.0, 90)).toBe(true);
    expect(crossedUpPercentForTest(9.0, 9.5, 90)).toBe(false);
    expect(crossedUpPercentForTest(null, 9.0, 90)).toBe(false);
    expect(crossedDownPercentForTest(3.0, 2.5, 30)).toBe(true);
    expect(crossedDownPercentForTest(2.5, 2.0, 30)).toBe(false);
  });

  it("blocks re-entry until the previous position has actually exited", () => {
    expect(shouldBlockOnsetForTest(10, -1, null)).toBe(false);
    expect(shouldBlockOnsetForTest(10, 12, "OPEN")).toBe(true);
    expect(shouldBlockOnsetForTest(12, 12, "OPEN")).toBe(false);
    expect(shouldBlockOnsetForTest(12, 12, "CLOSE")).toBe(true);
    expect(shouldBlockOnsetForTest(13, 12, "CLOSE")).toBe(false);
  });

  it("returns a finite Newey-West estimate for a non-constant series", () => {
    const result = neweyWestMeanForExitTest([1, 2, -0.5, 1.5, 0.25, 2.25, -1, 1], 2);
    expect(result.n).toBe(8);
    expect(result.mean).not.toBeNull();
    expect(Number.isFinite(result.t ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(result.ciLow ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(result.ciHigh ?? Number.NaN)).toBe(true);
  });
});
