import { describe, expect, it } from "vitest";

import { adjustSectorPenaltyScore } from "./sectorScoreAdjustment";

describe("adjustSectorPenaltyScore production parity", () => {
  it("awards the 0.5 slot below the selected threshold", () => {
    expect(adjustSectorPenaltyScore(7.5, 83.9, 84).score).toBe(8);
    expect(adjustSectorPenaltyScore(7.5, 84.9, 85).score).toBe(8);
  });

  it("removes the slot at or above the selected threshold", () => {
    expect(adjustSectorPenaltyScore(7.5, 84, 84).score).toBe(7.5);
    expect(adjustSectorPenaltyScore(7.5, 85, 85).score).toBe(7.5);
  });

  it("awards no sector slot when PL is unavailable", () => {
    const result = adjustSectorPenaltyScore(7.5, null, 84);
    expect(result.score).toBe(7.5);
    expect(result.sectorScoreAvailable).toBe(false);
    expect(result.penaltyApplied).toBe(false);
  });
});
