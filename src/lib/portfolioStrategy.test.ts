import { describe, expect, it, vi } from "vitest";
vi.mock("./cloud", () => ({ supabase: {}, userId: vi.fn() }));
vi.mock("./manualDataStore", () => ({ ensureManualDataset: vi.fn() }));
vi.mock("./screeningHistory", () => ({ loadSnapshots: vi.fn() }));
import { deriveExitPlan, isEntryOnset, type PortfolioTrade } from "./portfolioStore";
import { getOperationalSignals, STRATEGY_CONFIG } from "./engine/operationalStrategy";
import type { SnapshotEntry, ScreeningSnapshot } from "./screeningSnapshot";
import type { DailyPrice } from "./engine/types";

const bars = Array.from({ length: 62 }, (_, i) => ({
  tradeDate: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  open: 100 + i,
  close: 101 + i,
})) as DailyPrice[];
const trade = {
  symbol: "005930",
  market: "KOSPI",
  entryDate: bars[0]!.tradeDate,
} as PortfolioTrade;
function snapshot(previous: number, current: number, day = 2): ScreeningSnapshot {
  return {
    asOfDate: bars[day]!.tradeDate,
    entries: [{ symbol: trade.symbol, ...getOperationalSignals("KOSPI", previous, current, true) }],
  } as ScreeningSnapshot;
}
describe("portfolio consumes KOSPI operational signals", () => {
  it("accepts versioned onset but never historical informational entry", () => {
    expect(
      isEntryOnset(getOperationalSignals("KOSPI", 7.5, 8, true) as SnapshotEntry, "KOSPI"),
    ).toBe(true);
    expect(
      isEntryOnset(
        { kospiEightPointEntry: true, status: "8점 신규 진입 후보" } as SnapshotEntry,
        "KOSPI",
      ),
    ).toBe(false);
  });
  it("executes U9.5 at the next available open and records the exit reason", () => {
    expect(deriveExitPlan(trade, [snapshot(9, 9.5)], bars, bars[4]!.tradeDate)).toMatchObject({
      exitDate: bars[3]!.tradeDate,
      exitPrice: bars[3]!.open,
      reason: "9.5점 상향돌파",
      timing: "OPEN",
    });
    expect(deriveExitPlan(trade, [snapshot(9, 9.5)], bars, bars[2]!.tradeDate)).toBeNull();
  });
  it("does not sell on downside or persistent upper score, while preserving H60", () => {
    expect(deriveExitPlan(trade, [snapshot(3, 2)], bars, bars[4]!.tradeDate)).toBeNull();
    expect(deriveExitPlan(trade, [snapshot(9.5, 10)], bars, bars[4]!.tradeDate)).toBeNull();
    expect(deriveExitPlan(trade, [snapshot(3, 2)], bars, bars[61]!.tradeDate)).toMatchObject({
      exitDate: bars[59]!.tradeDate,
      reason: "60거래일 만기",
      timing: "CLOSE",
    });
  });
});

describe("portfolio sector caps", () => {
  it("uses the validated market-specific limits", () => {
    expect(STRATEGY_CONFIG.KOSPI.sectorCap).toBe(0.1);
    expect(STRATEGY_CONFIG.KOSDAQ.sectorCap).toBe(0.2);
  });
});
