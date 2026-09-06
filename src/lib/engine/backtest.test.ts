import { describe, expect, it } from "vitest";

import {
  BACKTEST_FEATURES,
  DEFAULT_BACKTEST_PARAMS,
  closeLocationValue,
  horizonMetric,
  median,
  pearson,
  quantile,
  runBacktest,
  volumeSurgeFlag,
  type BacktestInputSeries,
  type BacktestParams,
} from "./backtest";
import type { DailyPrice } from "./types";

function makeBars(n: number, fn: (i: number) => number): DailyPrice[] {
  const bars: DailyPrice[] = [];
  for (let i = 0; i < n; i++) {
    const close = fn(i);
    bars.push({
      tradeDate: `2024-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      open: close * 0.99,
      high: close * 1.02,
      low: close * 0.98,
      close,
      volume: 1_000_000 + (i % 5) * 100_000,
      tradingValue: close * 1_000_000,
      marketCap: null,
      foreignNetBuyValue: i % 3 === 0 ? 1_000_000 : -200_000,
      institutionNetBuyValue: null,
    });
  }
  return bars;
}

const uptrend: BacktestInputSeries = {
  symbol: "000001",
  name: "상승주",
  bars: makeBars(400, (i) => 10_000 * (1 + i * 0.004)),
};
const choppy: BacktestInputSeries = {
  symbol: "000002",
  name: "박스주",
  bars: makeBars(400, (i) => 10_000 * (1 + 0.05 * Math.sin(i / 7))),
};

const params: BacktestParams = { ...DEFAULT_BACKTEST_PARAMS, sampleEvery: 5 };

describe("multi horizon backtest", () => {
  const result = runBacktest([uptrend, choppy], params);

  it("computes every requested forward horizon", () => {
    expect(result.horizons).toEqual([5, 10, 20, 40, 60]);
    for (const fh of result.featureHorizons) {
      expect(fh.metrics.map((m) => m.horizon)).toEqual([5, 10, 20, 40, 60]);
    }
  });

  it("forwardReturn matches (close[t+N]/close[t]-1)*100", () => {
    // 단일 종목·단일 관측으로 직접 검증
    const bars = uptrend.bars;
    const t = 120;
    for (const n of [5, 10, 20, 40, 60]) {
      const expected = (bars[t + n]!.close / bars[t]!.close - 1) * 100;
      const single = runBacktest(
        [{ symbol: "X", name: "X", bars: bars.slice(0, t + n + 1) }],
        { ...params, sampleEvery: 20, horizonDays: n, features: ["MA_ALIGNED"] },
      );
      const base = single.baselineByHorizon.find((b) => b.horizon === n)!;
      expect(base.avgReturn).toBeCloseTo(expected, 6);
    }
  });

  it("drops only the horizons whose future bar is missing", () => {
    const short = runBacktest(
      [{ symbol: "X", name: "X", bars: uptrend.bars.slice(0, 141) }],
      { ...params, sampleEvery: 20 },
    );
    const by = Object.fromEntries(short.baselineByHorizon.map((b) => [b.horizon, b.count]));
    expect(by[5]).toBeGreaterThan(0);
    expect(by[10]).toBeGreaterThan(0);
    expect(by[60]).toBe(0);
  });

  it("edge = signal avg - non-signal avg, edgePerDay = edge / horizon", () => {
    for (const fh of result.featureHorizons) {
      for (const m of fh.metrics) {
        if (m.edge === null) continue;
        expect(m.edge).toBeCloseTo((m.signalAvgReturn ?? 0) - (m.nonSignalAvgReturn ?? 0), 9);
        expect(m.edgePerDay).toBeCloseTo(m.edge / m.horizon, 9);
      }
    }
  });

  it("includes median return everywhere", () => {
    expect(result.featureHorizons[0]!.metrics[0]!.signalMedianReturn).not.toBeUndefined();
    expect(result.bucketHorizons.every((b) => "medianReturn" in b)).toBe(true);
    expect(result.entryThresholds.every((e) => "medianReturn" in e)).toBe(true);
  });
});

describe("helpers", () => {
  it("median / quantile", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 25)).toBe(2);
    expect(quantile([], 50)).toBeNull();
  });

  it("horizonMetric edge and tStat", () => {
    const m = horizonMetric([2, 4, 6], [0, 0, 0], 10);
    expect(m.signalAvgReturn).toBe(4);
    expect(m.nonSignalAvgReturn).toBe(0);
    expect(m.edge).toBe(4);
    expect(m.edgePerDay).toBeCloseTo(0.4, 9);
    expect(m.winRate).toBe(100);
    expect(m.tStat).not.toBeNull();
  });

  it("closeLocationValue null when high == low", () => {
    const bar = { high: 10, low: 10, close: 10 } as DailyPrice;
    expect(closeLocationValue(bar)).toBeNull();
    expect(closeLocationValue({ high: 10, low: 0, close: 8 } as DailyPrice)).toBeCloseTo(0.8, 9);
  });

  it("volumeSurgeFlag modes", () => {
    expect(volumeSurgeFlag(200, 150, "SIMPLE", null, null)).toBe(true);
    expect(volumeSurgeFlag(120, 150, "SIMPLE", null, null)).toBe(false);
    expect(volumeSurgeFlag(200, 150, "UP_DAY", -0.01, 0.9)).toBe(false);
    expect(volumeSurgeFlag(200, 150, "UP_DAY", 0.01, 0.9)).toBe(true);
    expect(volumeSurgeFlag(200, 150, "HIGH_CLOSE", 0.01, 0.6)).toBe(false);
    expect(volumeSurgeFlag(200, 150, "HIGH_CLOSE", 0.01, 0.8)).toBe(true);
    expect(volumeSurgeFlag(null, 150, "SIMPLE", null, null)).toBeNull();
  });

  it("pearson correlation", () => {
    expect(pearson([0, 1, 0, 1], [0, 1, 0, 1])).toBeCloseTo(1, 9);
    expect(pearson([0, 1, 0, 1], [1, 0, 1, 0])).toBeCloseTo(-1, 9);
    expect(pearson([0, 1, null, 1], [0, 1, 1, 1])).not.toBeNull();
  });
});

describe("sensitivity and sampling", () => {
  it("observation interval only changes sampling frequency", () => {
    const r = runBacktest([uptrend, choppy], { ...params, intervalCandidates: [1, 5, 20] });
    const rows = r.intervalSensitivity;
    const one = rows.find((x) => x.interval === 1)!;
    const twenty = rows.find((x) => x.interval === 20)!;
    expect(one.observations).toBeGreaterThan(twenty.observations);
    expect(one.overlapRatio).toBeCloseTo(r.horizonDays / 1, 9);
  });

  it("overextension thresholds produce monotonically rising signal rate", () => {
    const r = runBacktest([uptrend, choppy], params);
    const rates = r.extensionSensitivity.map((x) => x.signalRate ?? 0);
    for (let i = 1; i < rates.length; i++) expect(rates[i]!).toBeGreaterThanOrEqual(rates[i - 1]!);
  });

  it("flags low discrimination at >=95% or <=5% signal rate", () => {
    const r = runBacktest([uptrend, choppy], {
      ...params,
      extensionThresholds: [0.0001, 100000],
    });
    const rows = r.extensionSensitivity;
    expect(rows[0]!.lowDiscrimination).toBe(true);
    expect(rows[rows.length - 1]!.lowDiscrimination).toBe(true);
  });

  it("computes a full correlation matrix for active features", () => {
    const r = runBacktest([uptrend, choppy], params);
    expect(r.correlation.ids.length).toBe(BACKTEST_FEATURES.length);
    expect(r.correlation.matrix.length).toBe(BACKTEST_FEATURES.length);
    expect(r.correlation.matrix[0]![0]).toBe(1);
  });
});

describe("regression: legacy single-horizon output", () => {
  const r = runBacktest([uptrend, choppy], params);

  it("keeps original fields intact", () => {
    expect(r.symbolCount).toBe(2);
    expect(r.observations).toBeGreaterThan(0);
    expect(r.horizonDays).toBe(20);
    expect(r.features.length).toBe(BACKTEST_FEATURES.length);
    expect(r.buckets.map((b) => b.label)).toEqual([
      "0~20점",
      "20~40점",
      "40~60점",
      "60~80점",
      "80~100점",
    ]);
    expect(r.strategy.trades).toBeGreaterThanOrEqual(0);
    expect(r.baselineAvgReturn).not.toBeNull();
  });

  it("legacy feature stats equal the 20d horizon metrics", () => {
    for (const f of r.features) {
      const fh = r.featureHorizons.find((x) => x.featureKey === f.id)!;
      const m = fh.metrics.find((x) => x.horizon === 20)!;
      expect(f.edge).toBe(m.edge);
      expect(f.avgReturnOn).toBe(m.signalAvgReturn);
      expect(f.signalCount).toBe(m.signalCount);
    }
  });
});
