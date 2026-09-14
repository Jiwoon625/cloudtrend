import { describe, expect, it } from "vitest";
import {
  percentileRankPctForSectorTest,
  rotationScoreForSectorTest,
  sectorSelectionPassForTest,
} from "./v8SectorRotationValidation";

describe("V8 sector rotation helpers", () => {
  it("uses cross-sectional percentile ranks consistently", () => {
    const sorted = [10, 20, 30, 40];
    expect(percentileRankPctForSectorTest(sorted, 10)).toBe(0);
    expect(percentileRankPctForSectorTest(sorted, 30)).toBe(50);
    expect(percentileRankPctForSectorTest(sorted, 40)).toBe(75);
  });

  it("uses the existing 40/45/15 rotation weights and reweights missing components", () => {
    expect(rotationScoreForSectorTest(80, 60, 40)).toBeCloseTo(65, 10);
    expect(rotationScoreForSectorTest(80, 60, null)).toBeCloseTo((0.4 * 80 + 0.45 * 60) / 0.85, 10);
  });

  it("applies identical rank filters to PL and full rotation comparisons", () => {
    expect(sectorSelectionPassForTest("TOP50", 55, 50)).toBe(true);
    expect(sectorSelectionPassForTest("TOP25", 80, 74.9)).toBe(false);
    expect(sectorSelectionPassForTest("TOP25", 45, 75)).toBe(true);
    expect(sectorSelectionPassForTest("RAW_GE70", 69.9, 90)).toBe(false);
    expect(sectorSelectionPassForTest("Q1", 20, 24.9)).toBe(true);
    expect(sectorSelectionPassForTest("Q4", 20, 75)).toBe(true);
  });
});
