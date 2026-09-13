import { describe, expect, it } from "vitest";

import {
  classifyBreadthForTest,
  classifyIndexRegimeForTest,
  classifyLeadershipForTest,
} from "./v8MarketRegimeValidation";

describe("V8 market regime validation helpers", () => {
  it("reuses the legacy index regime rules", () => {
    expect(classifyIndexRegimeForTest([true, true, true, true])).toBe("RISK_ON");
    expect(classifyIndexRegimeForTest([false, false, false, false])).toBe("RISK_OFF");
    expect(classifyIndexRegimeForTest([true, true, false, false])).toBe("NEUTRAL");
    expect(classifyIndexRegimeForTest([true, null, null, false])).toBe("UNKNOWN");
  });

  it("classifies breadth with fixed pre-specified thresholds", () => {
    expect(classifyBreadthForTest(65)).toBe("BROAD");
    expect(classifyBreadthForTest(50)).toBe("MIXED");
    expect(classifyBreadthForTest(35)).toBe("NARROW");
    expect(classifyBreadthForTest(null)).toBe("UNKNOWN");
  });

  it("uses the index-led proxy only when the gap is large and breadth is weak", () => {
    expect(classifyLeadershipForTest(6, 45)).toBe("INDEX_LED");
    expect(classifyLeadershipForTest(6, 55)).toBe("BALANCED");
    expect(classifyLeadershipForTest(-6, 70)).toBe("STOCK_LED");
    expect(classifyLeadershipForTest(null, 45)).toBe("UNKNOWN");
  });
});
