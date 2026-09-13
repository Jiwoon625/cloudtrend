import { describe, expect, it } from "vitest";

import { NO_CAPABILITIES, type MarketDataset } from "./dataset";
import { adjustSectorPenaltyScore } from "./sectorScoreAdjustment";
import { V8_REQUIRED_COLUMNS } from "./v8InputQuality";
import { buildV8ScoreAvailabilityReport } from "./v8ScoreAvailability";
import type { DailyPrice, Instrument } from "./types";

function day(i: number) {
  const d = new Date(Date.UTC(2020, 0, 1 + i));
  return d.toISOString().slice(0, 10);
}

function bar(i: number): DailyPrice {
  const close = 100 + i;
  return {
    tradeDate: day(i),
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000,
    tradingValue: close * 1_000,
    marketCap: null,
    foreignNetBuyValue: 1,
    institutionNetBuyValue: null,
  };
}

function stock(): Instrument {
  return {
    id: "005930",
    symbol: "005930",
    name: "테스트",
    instrumentType: "STOCK",
    market: "KOSPI",
    sectorCode: "TEST",
    sectorName: "테스트",
    isPreferredStock: false,
    isManagementIssue: false,
    isInvestmentWarning: false,
    isLeveraged: false,
    isInverse: false,
    isActive: true,
    indexMemberships: [],
  };
}

describe("V8 feature availability policies", () => {
  it("requires market and foreignNetBuyValue in the V8 input contract", () => {
    expect(V8_REQUIRED_COLUMNS).toContain("market");
    expect(V8_REQUIRED_COLUMNS).toContain("foreignNetBuyValue");
  });

  it("keeps the 9.5-point base unchanged when sector PL is missing", () => {
    expect(adjustSectorPenaltyScore(7.5, null, 80)).toEqual({
      score: 7.5,
      sectorScoreAvailable: false,
      overheated: null,
      penaltyApplied: false,
    });
    expect(adjustSectorPenaltyScore(7.5, 60, 80).score).toBe(8);
    expect(adjustSectorPenaltyScore(7.5, 85, 80).score).toBe(7.5);
  });

  it("attributes post-warmup score loss to a missing 20D foreign window", () => {
    const bars = Array.from({ length: 300 }, (_, i) => bar(i));
    bars[260] = { ...bars[260]!, foreignNetBuyValue: null };
    const inst = stock();
    const dataset: MarketDataset = {
      provider: "TEST",
      version: "test",
      asOfDate: bars.at(-1)!.tradeDate,
      isLive: false,
      capabilities: NO_CAPABILITIES,
      notes: [],
      sectors: [{ code: "TEST", name: "테스트" }],
      tradeDates: bars.map((b) => b.tradeDate),
      instruments: [inst],
      bars: { [inst.symbol]: bars },
      indexSeries: [],
      financials: {},
      etfFacts: {},
      vkospiSeries: [],
    };

    const report = buildV8ScoreAvailabilityReport(dataset, 1);
    expect(report.totalDays).toBe(300);
    expect(report.warmupBefore120Days).toBe(120);
    expect(report.high52wWarmupDays).toBe(131);
    expect(report.postWarmupCandidateDays).toBe(49);
    expect(report.foreign20dMissingDays).toBe(20);
    expect(report.otherTechnicalMissingDays).toBe(0);
    expect(report.scoredDays).toBe(29);
    expect(report.postWarmupUnavailableDays).toBe(20);
  });
});
