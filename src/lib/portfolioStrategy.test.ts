import { kospiEntryGates } from "../../tests/kospi-policy-fixtures";
import { describe, expect, it, vi } from "vitest";
vi.mock("./cloud", () => ({ supabase: {}, userId: vi.fn() }));
vi.mock("./manualDataStore", () => ({ ensureManualDataset: vi.fn() }));
vi.mock("./screeningHistory", () => ({ loadSnapshots: vi.fn() }));
import { deriveExitPlan, isEntryOnset, type PortfolioTrade } from "./portfolioStore";
import {
  getOperationalSignals,
  LEGACY_OPERATIONAL_SIGNAL_VERSION,
  STRATEGY_CONFIG,
} from "./engine/operationalStrategy";
import { KOSPI_ENTRY_POLICY } from "./engine/kospiEntryConfirmation";
import {
  nextConfirmedEntry,
  deriveExitPlan as unifiedExitPlan,
  normalizeSnapshots,
  heldDuringEntryWindow,
} from "./portfolioStrategyRules";
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
  it("never upgrades pending universe rows through KOSDAQ boolean or legacy status fallback", () => {
    for (const signal of [{ kosdaq80Onset: true }, { status: "KOSDAQ 8 Onset" }]) {
      expect(
        isEntryOnset({ ...signal, hardFilterPassed: false } as unknown as SnapshotEntry, "KOSDAQ"),
      ).toBe(true);
      expect(
        isEntryOnset(
          {
            ...signal,
            hardFilterPassed: false,
            hardFilterStatus: "PENDING",
            pendingRules: ["시가총액 자료 대기"],
          } as unknown as SnapshotEntry,
          "KOSDAQ",
        ),
      ).toBe(false);
    }
  });
  it("retains held exits when the current universe row is pending", () => {
    const pending = snapshot(9, 9.5);
    Object.assign(pending.entries[0]!, {
      hardFilterPassed: false,
      hardFilterStatus: "PENDING",
      pendingRules: ["시가총액 자료 대기"],
      technicalPoints: 9.5,
      scoreDelta1d: 5,
    });
    expect(deriveExitPlan(trade, [pending], bars, bars[4]!.tradeDate)).toMatchObject({
      exitDate: bars[3]!.tradeDate,
      reason: "9.5점 상향돌파",
    });
  });
  it("requires confirmed eligibility and never accepts raw or legacy onsets as live entries", () => {
    expect(
      isEntryOnset(getOperationalSignals("KOSPI", 7.5, 8, true) as SnapshotEntry, "KOSPI"),
    ).toBe(false);
    expect(
      isEntryOnset(
        {
          ...getOperationalSignals("KOSPI", 7.5, 8, true),
          kospiEntry: {
            version: KOSPI_ENTRY_POLICY.version,
            marketGate: kospiEntryGates(),
            date: "2026-10-02",
            originDate: "2026-10-01",
            confirmationDate: "2026-10-02",
            state: "confirmed",
            issues: [],
            rsAccel: 1,
            eligible: true,
            score: 8,
            originScore: 8,
          },
        } as unknown as SnapshotEntry,
        "KOSPI",
        "2026-10-02",
      ),
    ).toBe(true);
    expect(
      isEntryOnset(
        {
          ...getOperationalSignals("KOSPI", 7.5, 8, true),
          operationalSignalVersion: LEGACY_OPERATIONAL_SIGNAL_VERSION,
        } as SnapshotEntry,
        "KOSPI",
        "2026-10-02",
      ),
    ).toBe(false);
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

describe("confirmation execution guards", () => {
  it("classifies known suspension separately from an unknown price gap", () => {
    const prices = [
      { tradeDate: "2026-10-06", open: 100, volume: 0 },
      { tradeDate: "2026-10-07", open: 101, volume: 10 },
    ] as DailyPrice[];
    const marketDates = prices.map((bar) => bar.tradeDate);
    expect(nextConfirmedEntry(prices, "2026-10-02", marketDates)).toMatchObject({
      state: "ready",
      bar: { tradeDate: "2026-10-07" },
    });
    expect(nextConfirmedEntry(prices.slice(1), "2026-10-02", marketDates)).toMatchObject({
      state: "unobservable",
      bar: null,
    });
  });
  it("preserves original legacy entries across same-day historical recomputation", () => {
    const original = {
      ...snapshot(7.5, 8),
      savedAt: "2026-01-04",
      entries: [
        {
          symbol: "A",
          kospi80Onset: true,
          operationalSignalVersion: LEGACY_OPERATIONAL_SIGNAL_VERSION,
        },
      ],
    } as ScreeningSnapshot;
    const later = {
      ...original,
      savedAt: "2026-10-02",
      entries: [{ symbol: "A", ...getOperationalSignals("KOSPI", 9, 9.5, true) }],
    } as ScreeningSnapshot;
    expect(normalizeSnapshots([later, original])[0]?.entries).toEqual(original.entries);
    expect(original.entries[0]?.kospi80Onset).toBe(true);
  });
  it("blocks positions held at any time since the origin, including an origin-day or entry-day sale", () => {
    const t = { symbol: "A", entryDate: "2026-09-01", exitDate: "2026-10-01" } as PortfolioTrade;
    expect(heldDuringEntryWindow(t, "A", "2026-10-01", "2026-10-06")).toBe(true);
    expect(
      heldDuringEntryWindow({ ...t, exitDate: "2026-10-06" }, "A", "2026-10-01", "2026-10-06"),
    ).toBe(true);
    expect(
      heldDuringEntryWindow({ ...t, exitDate: "2026-09-30" }, "A", "2026-10-01", "2026-10-06"),
    ).toBe(false);
  });
});

it("carries H60 with a missing maturity close to the next executable open, without requiring that next close", () => {
  const prices = bars.map((b) => ({ ...b, volume: 100 }));
  prices[59]!.close = 0;
  prices[60]!.close = 0;
  const dates = prices.map((b) => b.tradeDate);
  expect(unifiedExitPlan(trade, [], prices, dates[59]!, dates, dates)).toBeNull();
  expect(unifiedExitPlan(trade, [], prices, dates[60]!, dates, dates)).toMatchObject({
    exitDate: dates[60],
    exitPrice: prices[60]!.open,
    timing: "OPEN",
    reason: "60거래일 만기",
  });
});
