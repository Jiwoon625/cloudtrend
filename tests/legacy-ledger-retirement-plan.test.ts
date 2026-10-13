import { describe, expect, it } from "vitest";
import { summarizeActualRetirement } from "../scripts/plan-legacy-ledger-retirement";
const doc = () => ({
  revision: 5,
  payload: {
    executions: [
      { id: "old", date: "2026-10-07" },
      { id: "new", date: "2026-10-12" },
    ],
    newActualPortfolio: { seriesId: "actual-performance-2026-10-12-v1", assignments: { new: {} } },
    operatingAllocation: { keep: true },
  },
});
describe("read-only archive planning", () => {
  it("only identifies historical candidates and retains assigned identities and every key", () => {
    const row = doc(),
      before = structuredClone(row);
    const plan = summarizeActualRetirement(row);
    expect(plan.unassignedHistoricalCandidateIds).toEqual(["old"]);
    expect(plan.currentAssignedSourceIds).toEqual(["new"]);
    expect(plan.preservedKeys).toContain("operatingAllocation");
    expect(plan.mutationAllowed).toBe(false);
    expect(row).toEqual(before);
  });
  it("never proposes assigned old sources as deletable", () => {
    const row = doc();
    row.payload.newActualPortfolio.assignments = {
      old: {},
    } as unknown as typeof row.payload.newActualPortfolio.assignments;
    expect(summarizeActualRetirement(row).unassignedHistoricalCandidateIds).toEqual([]);
  });
  it("rejects missing new series and missing source identities", () => {
    expect(() => summarizeActualRetirement({ payload: { executions: [] } })).toThrow("identity");
    const row = doc();
    row.payload.executions = [];
    expect(() => summarizeActualRetirement(row)).toThrow("source is missing");
  });
});
