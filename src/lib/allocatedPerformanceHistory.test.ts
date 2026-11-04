import { describe, it, expect } from "vitest";
import { buildAllocatedPerformanceHistory } from "./allocatedPerformanceHistory";
import { emptyNewActualMetadata, type NewActualExecution } from "./newActualPortfolio";
const fill: NewActualExecution = {
  id: "synthetic",
  date: "2026-10-12",
  market: "KOSPI",
  symbol: "SYN",
  name: "Synthetic",
  side: "BUY",
  price: 10,
  shares: 2,
  fee: 0,
  note: "",
  order: 0,
  signalKey: null,
};
const input = () => ({
  currency: "KRW" as const,
  sourceRevision: 1,
  sourceHash: "sha256:" + "a".repeat(64),
  calculatedAt: "2026-10-13T12:00:00Z",
  throughDate: "2026-10-13",
  dates: ["2026-10-12", "2026-10-13"],
  prices: [
    { symbol: "SYN", date: "2026-10-12", close: 10 },
    { symbol: "SYN", date: "2026-10-13", close: 15 },
  ],
  executions: [fill],
  metadata: {
    ...emptyNewActualMetadata(),
    assignments: {
      synthetic: {
        executionId: "synthetic",
        quantity: 2,
        gross: 20,
        fee: 0,
        brokerReference: "synthetic-reference",
      },
    },
    cashEvents: [
      {
        id: "opening",
        kind: "DEPOSIT" as const,
        date: "2026-10-12",
        amount: 1000,
        reference: "synthetic-opening",
      },
    ],
  },
});
describe("allocated actual daily report", () => {
  it("reconstructs daily values from canonical allocated fills and one common cash pool", () => {
    const result = buildAllocatedPerformanceHistory(input());
    expect(result.points.map((p) => p.nav)).toEqual(["1000", "1010"]);
    expect(result.points[1]).toMatchObject({
      cash: "980",
      netContributions: "1000",
      pnl: "10",
      returnPercent: "1",
    });
  });
  it("does not carry an old quote into a missing trading date", () => {
    const i = input();
    i.prices.pop();
    expect(buildAllocatedPerformanceHistory(i).points[1]?.returnPercent).toBeNull();
  });
  it("excludes future actual fills and never fabricates a flow adjusted return", () => {
    const i = input();
    i.executions[0] = { ...fill, date: "2026-10-13" };
    expect(buildAllocatedPerformanceHistory(i).points[0]?.nav).toBe("1000");
    i.metadata.cashEvents.push({
      id: "later",
      kind: "DEPOSIT",
      date: "2026-10-13",
      amount: 100,
      reference: "synthetic-later",
    });
    expect(buildAllocatedPerformanceHistory(i).points[1]?.returnPercent).toBeNull();
  });
  it("rejects conflicting dated prices and orphaned assignments", () => {
    const i = input();
    i.prices.push({ symbol: "SYN", date: "2026-10-13", close: 99 });
    expect(() => buildAllocatedPerformanceHistory(i)).toThrow("Conflicting");
    const orphan = input();
    orphan.executions = [];
    expect(() => buildAllocatedPerformanceHistory(orphan)).toThrow("assignment");
  });
});
