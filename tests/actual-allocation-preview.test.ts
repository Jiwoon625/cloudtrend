import { describe, expect, it } from "vitest";
import {
  previewActualAllocationBatch,
  type ActualBudgetCandidate,
} from "../src/lib/actualAllocationPreview";
const candidate = (market: "KOSPI" | "ETF" | "US", symbol: string): ActualBudgetCandidate => ({
  signal: {
    symbol,
    name: symbol,
    market,
    sector: "S",
    date: "2026-10-13",
    price: 100,
    score: 9,
    priority: 1,
    reason: "",
    actualState: "READY",
    signalOriginDate: "2026-10-12",
  },
  budget: {
    id: symbol,
    annualSnapshotId: "a",
    market: market === "KOSPI" ? "KR" : market,
    currency: market === "US" ? "USD" : "KRW",
    signalDate: "2026-10-12",
    decisionDate: "2026-10-13",
    amount: "100",
    feeTreatment: "INCLUSIVE",
  },
  limitStatus: "ROOM",
  sectorKey: "S",
  sectorRemaining: 3,
});
const input = (candidates: ActualBudgetCandidate[]) => ({
  candidates,
  marketCash: { KR: "200", ETF: "200", US: "200" },
  currencyCash: { KRW: "150", USD: "200" },
  remainingSlots: { KR: 30, ETF: 10, US: 20 },
});
describe("actual allocation batch", () => {
  it("never spends shared KRW twice or treats a partial currency budget as a full one", () => {
    const kr = candidate("KOSPI", "K"),
      etf = candidate("ETF", "E");
    kr.budget!.amount = etf.budget!.amount = "101";
    const rows = previewActualAllocationBatch(input([kr, etf]));
    expect(rows[0]).toMatchObject({ status: "ESTIMATED", quantity: "1", cashRequired: "100.15" });
    expect(rows[1]).toMatchObject({ status: "SKIPPED", quantity: null });
  });
  it("counts new preview slots and sectors, without touching actual holdings", () => {
    const a = candidate("KOSPI", "A"),
      b = candidate("KOSPI", "B");
    a.budget!.amount = b.budget!.amount = "101";
    a.sectorRemaining = b.sectorRemaining = 1;
    const x = input([a, b]);
    x.currencyCash.KRW = "400";
    x.marketCash.KR = "400";
    expect(previewActualAllocationBatch(x)[1]!.reason).toContain("섹터");
    x.remainingSlots.KR = 1;
    expect(previewActualAllocationBatch(x)[1]!.reason).toContain("종목 수");
  });
  it("keeps conditions outside estimates when funding, annual budget or actual context is unknown", () => {
    const a = candidate("US", "A");
    a.budget = null;
    expect(previewActualAllocationBatch(input([a]))[0]!.status).toBe("WAITING");
    a.budget = candidate("US", "A").budget;
    a.signal.actualState = "HELD";
    expect(previewActualAllocationBatch(input([a]))[0]!.status).toBe("WAITING");
  });
});

describe("actual allocation occupied limits", () => {
  it("counts a partial fill and reservation once, across Korean venues", async () => {
    const { actualAllocationLimits } = await import("../src/lib/actualAllocationPreview");
    const security = {
      symbol: "A",
      venue: "KOSPI" as const,
      sector: "S",
      sectorCode: "S",
      originDate: "2026-10-12",
      decisionDate: "2026-10-13",
      sourceDate: "2026-10-13",
      sourceFingerprint: "sha256:" + "a".repeat(64),
    };
    const reservation = {
      id: "r",
      signalId: "s",
      signalBudgetId: "b",
      market: "KR" as const,
      currency: "KRW" as const,
      amount: "100",
      security,
    };
    const result = actualAllocationLimits({
      positions: [{ market: "KOSPI", symbol: "A" }],
      rows: [
        { market: "KOSPI", symbol: "A", sectorCode: "S" },
        { market: "KOSDAQ", symbol: "B", sectorCode: "S" },
      ],
      reservations: [
        reservation,
        { ...reservation, id: "r2", security: { ...security, venue: "KOSDAQ", symbol: "B" } },
      ],
    });
    expect(result.slots.KR).toBe(28);
    expect(result.sectors.get("S")).toBe(2);
    expect(result.reserved.has("KOSPI:A")).toBe(true);
    expect(result.unknown.size).toBe(0);
  });
  it("fails closed for legacy reservations missing server provenance", async () => {
    const { actualAllocationLimits } = await import("../src/lib/actualAllocationPreview");
    const result = actualAllocationLimits({
      positions: [],
      rows: [],
      reservations: [
        {
          id: "r",
          signalId: "s",
          signalBudgetId: "b",
          market: "KR",
          currency: "KRW",
          amount: "100",
        },
      ],
    });
    expect(result.unknown.has("KR")).toBe(true);
    expect(result.sectorsKnown).toBe(false);
  });
});

it("marks existing pending sector provenance unknown after a current classification correction", async () => {
  const { actualAllocationLimits } = await import("../src/lib/actualAllocationPreview");
  const result = actualAllocationLimits({
    positions: [],
    rows: [{ market: "KOSPI", symbol: "A", sectorCode: "NEW" }],
    reservations: [
      {
        id: "r",
        signalId: "s",
        signalBudgetId: "b",
        market: "KR",
        currency: "KRW",
        amount: "100",
        security: {
          symbol: "A",
          venue: "KOSPI",
          sector: "old",
          sectorCode: "OLD",
          originDate: "2026-10-12",
          decisionDate: "2026-10-13",
          sourceDate: "2026-10-13",
          sourceFingerprint: "sha256:" + "a".repeat(64),
        },
      },
    ],
  });
  expect(result.slots.KR).toBe(29);
  expect(result.unknown.has("KR")).toBe(true);
  expect(result.sectorsKnown).toBe(false);
});
