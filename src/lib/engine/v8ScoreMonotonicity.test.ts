import { describe, expect, it } from "vitest";

import {
  neweyWestMeanForTest,
  spearmanRankCorrelationForTest,
} from "./v8ScoreMonotonicity";

describe("V8 score monotonicity statistics", () => {
  it("detects perfectly monotone and inverse bucket ordering", () => {
    expect(spearmanRankCorrelationForTest([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
    expect(spearmanRankCorrelationForTest([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10);
  });

  it("returns a positive HAC mean and finite confidence interval", () => {
    const result = neweyWestMeanForTest([0.1, 0.2, 0.15, 0.25, 0.18, 0.22], 2);
    expect(result.n).toBe(6);
    expect(result.mean).toBeGreaterThan(0);
    expect(result.t).not.toBeNull();
    expect(Number.isFinite(result.ciLow)).toBe(true);
    expect(Number.isFinite(result.ciHigh)).toBe(true);
  });
});
