import { describe, expect, it } from "vitest";

import {
  BACKTEST_FEATURES,
  DEFAULT_BACKTEST_PARAMS,
  runBacktest,
  signalOnsetFlags,
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
  { symbol: "000001", name: "KOSPI주", market: "KOSPI", bars: bars(420, 10_000, 0.001) },
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
    expect(
      result.featureHorizons.some((f) => f.metrics.some((m) => m.marketAdjustedEdge !== null)),
    ).toBe(true);
  });

  it("does not invent paired daily statistics when both symbols have the same Onset states", () => {
    // The original fixture shares the same feature transitions across symbols.
    // A daily cross-section needs an Onset AND a non-Onset on the same date.
    for (const feature of result.featureHorizons) {
      for (const metric of feature.metrics) {
        expect(metric.crossSectionalEdge).toBeNull();
        expect(metric.marketAdjustedCrossSectionalEdge).toBeNull();
        expect(metric.robustObservations).toBe(0);
        expect(metric.robustTStat).toBeNull();
        expect(metric.ci95Low).toBeNull();
        expect(metric.ci95High).toBeNull();
      }
    }
  });

  it("calculates paired Onset spreads and HAC confidence intervals from different market returns", () => {
    // Each pulse makes only the first stock's 20-day foreign flow positive.
    // It turns negative again before the next pulse. Thus exactly these five
    // sampled dates contain an Onset/control pair; persistent true days do not.
    const onsetIndexes = [150, 190, 230, 270, 310];
    const signalBars = bars(360, 10_000, 0.001).map((bar, i) => ({
      ...bar,
      foreignNetBuyValue: onsetIndexes.includes(i) ? 100 : -1,
    }));
    const controlBars = bars(360, 20_000, 0.0003).map((bar) => ({
      ...bar,
      foreignNetBuyValue: -1,
    }));
    const params = {
      ...DEFAULT_BACKTEST_PARAMS,
      features: ["FOREIGN_NET_POSITIVE"],
      horizonDays: 20,
      horizons: [20],
      sampleEvery: 5,
      intervalCandidates: [5],
    };
    const pairedSeries: BacktestInputSeries[] = [
      { symbol: "SIGNAL", name: "signal", market: "KOSPI", bars: signalBars },
      { symbol: "CONTROL", name: "control", market: "KOSDAQ", bars: controlBars },
    ];
    const paired = runBacktest(pairedSeries, params, { indexSeries: indexes });
    const metric = paired.featureHorizons[0]!.metrics[0]!;

    // Independent oracle: signal t, next-open fill t+1, close exit t+20,
    // with each stock's own market benchmark on the same entry/exit dates.
    const forward = (prices: DailyPrice[], i: number) =>
      (prices[i + 20]!.close / prices[i + 1]!.open - 1) * 100;
    const rawSpreads = onsetIndexes.map((i) => forward(signalBars, i) - forward(controlBars, i));
    const adjustedSpreads = onsetIndexes.map(
      (i) =>
        forward(signalBars, i) -
        forward(kospiBars, i) -
        (forward(controlBars, i) - forward(kosdaqBars, i)),
    );
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const edge = mean(adjustedSpreads);
    // Bartlett-kernel covariance matrix, bandwidth 20/5 - 1 = 3.
    // This quadratic-form oracle is independent of the engine's lag loop.
    const variance =
      adjustedSpreads.reduce(
        (sum, x, i) =>
          sum +
          adjustedSpreads.reduce(
            (subtotal, y, j) =>
              subtotal + Math.max(0, 1 - Math.abs(i - j) / 4) * (x - edge) * (y - edge),
            0,
          ),
        0,
      ) /
      adjustedSpreads.length ** 2;
    const standardError = Math.sqrt(variance);

    expect(metric.signalCount).toBe(5);
    expect(metric.robustObservations).toBe(5);
    expect(metric.crossSectionalEdge).toBeCloseTo(mean(rawSpreads), 10);
    expect(metric.marketAdjustedCrossSectionalEdge).toBeCloseTo(edge, 10);
    expect(standardError).toBeGreaterThan(0);
    expect(metric.robustTStat).toBeCloseTo(edge / standardError, 10);
    expect(metric.ci95Low).toBeCloseTo(edge - 1.96 * standardError, 10);
    expect(metric.ci95High).toBeCloseTo(edge + 1.96 * standardError, 10);

    const withoutBenchmarks = runBacktest(pairedSeries, params).featureHorizons[0]!.metrics[0]!;
    expect(withoutBenchmarks.crossSectionalEdge).toBeCloseTo(mean(rawSpreads), 10);
    expect(withoutBenchmarks.marketAdjustedCrossSectionalEdge).toBeNull();
    expect(withoutBenchmarks.robustObservations).toBe(0);
    expect(withoutBenchmarks.robustTStat).toBeNull();
  });

  it("breaks results down by market, regime, year and time split", () => {
    expect(new Set(result.marketBreakdown.map((r) => r.segment))).toEqual(
      new Set(["KOSPI", "KOSDAQ"]),
    );
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

  it("counts a persistent feature only once until it turns off and on again", () => {
    const sequence = [false, true, true, true, false, true];
    let previous: Record<string, boolean | null> | null = null;
    const onset = sequence.map((value) => {
      const current = { MA_ALIGNED: value };
      const flag = signalOnsetFlags(current, previous)["MA_ALIGNED"];
      previous = current;
      return flag;
    });
    expect(onset).toEqual([false, true, false, false, false, true]);
  });

  it("does not invent an onset when the first observed state is already true", () => {
    expect(signalOnsetFlags({ MA_ALIGNED: true }, null)["MA_ALIGNED"]).toBeNull();
  });

  it("removes MA20 slope and 20-day positive return from the V4 feature universe", () => {
    const ids = BACKTEST_FEATURES.map((f) => f.id);
    expect(ids).not.toContain("MA20_SLOPE_UP");
    expect(ids).not.toContain("RS_POSITIVE");
    expect(DEFAULT_BACKTEST_PARAMS.features).not.toContain("MA20_SLOPE_UP");
    expect(DEFAULT_BACKTEST_PARAMS.features).not.toContain("RS_POSITIVE");
  });

  it("ignores removed feature ids even when legacy saved params still contain them", () => {
    const legacyResult = runBacktest(
      series,
      {
        ...DEFAULT_BACKTEST_PARAMS,
        features: [...DEFAULT_BACKTEST_PARAMS.features, "MA20_SLOPE_UP", "RS_POSITIVE"],
        weights: {
          ...DEFAULT_BACKTEST_PARAMS.weights,
          MA20_SLOPE_UP: 99,
          RS_POSITIVE: 99,
        },
        horizonDays: 20,
        sampleEvery: 5,
        intervalCandidates: [5, 10, 20],
      },
      { indexSeries: indexes },
    );
    const ids = legacyResult.featureHorizons.map((f) => f.featureKey);
    expect(ids).not.toContain("MA20_SLOPE_UP");
    expect(ids).not.toContain("RS_POSITIVE");
    expect(legacyResult.correlation.ids).not.toContain("MA20_SLOPE_UP");
    expect(legacyResult.correlation.ids).not.toContain("RS_POSITIVE");
  });
});
