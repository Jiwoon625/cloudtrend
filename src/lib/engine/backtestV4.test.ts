import { describe, expect, it } from "vitest";

import {
  DEFAULT_BACKTEST_PARAMS,
  runBacktest,
  type BacktestInputSeries,
} from "./backtestV4";
import type { DailyPrice, IndexSeries } from "./types";

function dateAt(i: number): string {
  const d = new Date(Date.UTC(2021, 0, 4));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}

function bars(n: number, start: number, drift: number): DailyPrice[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start * (1 + drift * i + 0.01 * Math.sin(i / 9));
    return {
      tradeDate: dateAt(i),
      open: close * 0.995,
      high: close * 1.015,
      low: close * 0.985,
      close,
      volume: 1_000_000 + (i % 7) * 50_000,
      tradingValue: close * 1_000_000,
      marketCap: null,
      foreignNetBuyValue: i % 2 === 0 ? 1_000_000 : -200_000,
      institutionNetBuyValue: null,
    };
  });
}

const kospiBars = bars(420, 2500, 0.0005);
const kosdaqBars = bars(420, 900, 0.0007);
const indexes: IndexSeries[] = [
  { indexCode: "KOSPI", indexName: "코스피", bars: kospiBars },
  { indexCode: "KOSDAQ", indexName: "코스닥", bars: kosdaqBars },
];
const series: BacktestInputSeries[] = [
  { symbol: "000001", name: "KOSPI주", market: "KOSPI", bars: bars(420, 10_000, 0.0010) },
  { symbol: "000002", name: "KOSDAQ주", market: "KOSDAQ", bars: bars(420, 20_000, 0.0012) },
];

const result = runBacktest(
  series,
  {
    ...DEFAULT_BACKTEST_PARAMS,
    horizonDays: 20,
    sampleEvery: 5,
    intervalCandidates: [5, 10, 20],
  },
  { indexSeries: indexes },
);

describe("Backtest V4", () => {
  it("keeps the requested five-day observation grid instead of auto-capping observations", () => {
    expect(result.baseInterval).toBe(5);
    expect(result.observations).toBeGreaterThan(0);
  });

  it("calculates benchmark and market-adjusted returns", () => {
    expect(result.baselineMarketReturn).not.toBeNull();
    expect(result.baselineMarketAdjustedReturn).not.toBeNull();
    expect(result.featureHorizons.some((f) => f.metrics.some((m) => m.marketAdjustedEdge !== null))).toBe(true);
  });

  it("adds cross-sectional robust statistics", () => {
    expect(
      result.featureHorizons.some((f) =>
        f.metrics.some((m) => m.marketAdjustedCrossSectionalEdge !== null),
      ),
    ).toBe(true);
    expect(result.featureHorizons[0]!.metrics[0]).toHaveProperty("robustTStat");
    expect(result.featureHorizons[0]!.metrics[0]).toHaveProperty("ci95Low");
    expect(result.featureHorizons[0]!.metrics[0]).toHaveProperty("ci95High");
  });

  it("breaks results down by market, regime, year and time split", () => {
    expect(new Set(result.marketBreakdown.map((r) => r.segment))).toEqual(new Set(["KOSPI", "KOSDAQ"]));
    expect(result.yearlyBreakdown.length).toBeGreaterThan(0);
    expect(result.regimeBreakdown.length).toBeGreaterThan(0);
    expect(new Set(result.splitBreakdown.map((r) => r.segment))).toEqual(
      new Set(["DEVELOPMENT", "VALIDATION", "OOS"]),
    );
    expect(result.splitBoundaries.oosStart).not.toBeNull();
  });

  it("removes synthetic cumulativeReturn from strategy summary", () => {
    expect("cumulativeReturn" in result.strategy).toBe(false);
  });
});
