import { describe, expect, it } from "vitest";
import { overlayPassForTest, relativeStrengthForTest } from "./v8MarketSplitValidation";

describe("V8 market split relative strength", () => {
  it("computes stock return minus matching market return", () => {
    expect(relativeStrengthForTest(110, 100, 105, 100)).toBeCloseTo(5, 10);
    expect(relativeStrengthForTest(95, 100, 90, 100)).toBeCloseTo(5, 10);
    expect(relativeStrengthForTest(0, 100, 105, 100)).toBeNull();
  });

  it("applies relative-strength overlays without changing score scale", () => {
    expect(overlayPassForTest("NONE", null, null)).toBe(true);
    expect(overlayPassForTest("RS20_POS", 0.1, null)).toBe(true);
    expect(overlayPassForTest("RS20_POS", 0, null)).toBe(false);
    expect(overlayPassForTest("RS60_POS", null, 0.1)).toBe(true);
    expect(overlayPassForTest("RS20_60_POS", 1, 2)).toBe(true);
    expect(overlayPassForTest("RS20_60_POS", 1, -1)).toBe(false);
    expect(overlayPassForTest("RS20_GE5", 5, null)).toBe(true);
    expect(overlayPassForTest("RS60_GE5", null, 4.99)).toBe(false);
    expect(overlayPassForTest("RS20_60_GE5", 5.1, 6)).toBe(true);
  });
});
