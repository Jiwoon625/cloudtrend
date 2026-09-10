import { describe, expect, it } from "vitest";

import { scoreThresholdOnset, spearmanRankCorrelation } from "./backtestV4";
import { scoreChangeBucket } from "./strategyValidationLegacy";

describe("Backtest V5 validation helpers", () => {
  it("detects only an upward score threshold crossing", () => {
    expect(scoreThresholdOnset(39, 40, 40)).toBe(true);
    expect(scoreThresholdOnset(39, 65, 60)).toBe(true);
    expect(scoreThresholdOnset(40, 55, 40)).toBe(false);
    expect(scoreThresholdOnset(65, 55, 60)).toBe(false);
    expect(scoreThresholdOnset(null, 60, 60)).toBeNull();
    expect(scoreThresholdOnset(55, null, 60)).toBeNull();
  });

  it("calculates Spearman Rank IC for positive and negative rankings", () => {
    expect(spearmanRankCorrelation([10, 20, 30, 40], [1, 2, 3, 4])).toBeCloseTo(1, 10);
    expect(spearmanRankCorrelation([10, 20, 30, 40], [4, 3, 2, 1])).toBeCloseTo(-1, 10);
  });

  it("uses average ranks when score ties exist", () => {
    const value = spearmanRankCorrelation([10, 20, 20, 40], [1, 2, 3, 4]);
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThan(0.9);
  });
});

describe("V6 score-change buckets", () => {
  it("uses non-overlapping left-closed ranges", () => {
    expect(scoreChangeBucket(0)).toBe("0-5");
    expect(scoreChangeBucket(4.999)).toBe("0-5");
    expect(scoreChangeBucket(5)).toBe("5-10");
    expect(scoreChangeBucket(9.999)).toBe("5-10");
    expect(scoreChangeBucket(10)).toBe("10-20");
    expect(scoreChangeBucket(19.999)).toBe("10-20");
    expect(scoreChangeBucket(20)).toBe("20+");
  });

  it("does not classify missing, invalid, or negative changes", () => {
    expect(scoreChangeBucket(null)).toBeNull();
    expect(scoreChangeBucket(Number.NaN)).toBeNull();
    expect(scoreChangeBucket(-0.001)).toBeNull();
  });
});
