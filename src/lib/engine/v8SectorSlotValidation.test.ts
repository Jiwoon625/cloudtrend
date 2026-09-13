import { describe, expect, it } from "vitest";
import {
  crossedUpSectorForTest,
  neweyWestMeanSectorForTest,
  policyScoreForTest,
  type V8SectorPolicy,
} from "./v8SectorSlotValidation";

const base: V8SectorPolicy = {
  id: "BASE_9P5",
  label: "base",
  sectorSlotPoints: 0,
  overheatThreshold: null,
  missingPl: "NO_SLOT",
};

const bonus: V8SectorPolicy = {
  id: "BONUS_ONLY",
  label: "bonus",
  sectorSlotPoints: 0.5,
  overheatThreshold: null,
  missingPl: "NO_SLOT",
};

const gated80: V8SectorPolicy = {
  id: "GATED_80",
  label: "gated80",
  sectorSlotPoints: 0.5,
  overheatThreshold: 80,
  missingPl: "NO_SLOT",
};

describe("V8 sector slot policy", () => {
  it("applies no slot when PL is missing and withholds the slot at the overheat threshold", () => {
    expect(policyScoreForTest(7.5, 60, base)).toBe(7.5);
    expect(policyScoreForTest(7.5, null, bonus)).toBe(7.5);
    expect(policyScoreForTest(7.5, 60, bonus)).toBe(8);
    expect(policyScoreForTest(7.5, 79.9, gated80)).toBe(8);
    expect(policyScoreForTest(7.5, 80, gated80)).toBe(7.5);
  });

  it("creates a slot-induced 80 onset only when the bonus lifts the score across the threshold", () => {
    expect(crossedUpSectorForTest(7, 7.5, 80)).toBe(false);
    expect(crossedUpSectorForTest(7.5, 8, 80)).toBe(true);
    expect(crossedUpSectorForTest(null, 8, 80)).toBe(false);
  });

  it("returns a finite Newey-West estimate", () => {
    const out = neweyWestMeanSectorForTest([1, 2, 0, 3, 1, 4, -1, 2], 2);
    expect(out.n).toBe(8);
    expect(out.mean).not.toBeNull();
    expect(Number.isFinite(out.mean!)).toBe(true);
    expect(out.ciLow).not.toBeNull();
    expect(out.ciHigh).not.toBeNull();
  });
});
