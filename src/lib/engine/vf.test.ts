import { describe, expect, it } from "vitest";

import { DEFAULT_BACKTEST_PARAMS } from "./backtestV4";
import { computeIndicators, type IndicatorSnapshot } from "./indicators";
import { evaluateFeatures, DEFAULT_BACKTEST_PARAMS as LEGACY_PARAMS } from "./backtest";
import type { DailyPrice } from "./types";
import { DEFAULT_SCORING_CONFIG, normalize, vfStockScore } from "./scoring";
import { VF_FEATURE_WEIGHTS, VF_FEATURE_WEIGHT_TOTAL } from "./vfConfig";

function snapshot(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    tradeDate: "2026-09-07",
    close: 100,
    ma20: 95,
    ma60: 90,
    ma120: 80,
    ma20Slope: 1,
    maAligned: true,
    atr14: 3,
    bollinger: {
      bb: { middle: 90, upper: 99, lower: 81, width: 20 },
      bbBreakout: true,
      bbSqueezePrior: false,
      bbSqueezeAbsolute: false,
      bbWidthExpanding: true,
      bbWalk: false,
      headFakeWarning: false,
    },
    ichimoku: {
      tenkan: 98,
      kijun: 94,
      cloudTop: 92,
      cloudBottom: 88,
      futureSenkouA: 96,
      futureSenkouB: 90,
      futureCloudBullish: true,
      tenkanAboveKijun: true,
      tenkanKijunGoldenCrossToday: false,
      chikouAbovePast26Close: true,
      chikouVsDisplayedCandle: true,
    },
    volumeRatio20: 160,
    tradingValueRatio20: 160,
    high52w: 104,
    distanceFrom52wHigh: -3.85,
    return20: 0.08,
    return60: 0.15,
    dayReturn: 0.01,
    foreignNet5d: 100_000_000,
    foreignNet20d: 300_000_000,
    foreignNet60d: 500_000_000,
    institutionNet20d: 0,
    extensionFromMa20: 5.26,
    atrExtension: 1.67,
    closeLocationValue: 0.8,
    ...overrides,
  };
}

describe("CloudTrend Vf defaults", () => {
  it("uses validated weights in backtest defaults", () => {
    for (const [id, weight] of Object.entries(VF_FEATURE_WEIGHTS)) {
      expect(DEFAULT_BACKTEST_PARAMS.weights[id]).toBe(weight);
    }
    expect(DEFAULT_BACKTEST_PARAMS.weights["MA20_SLOPE_UP"]).toBeUndefined();
    expect(DEFAULT_BACKTEST_PARAMS.weights["RS_POSITIVE"]).toBeUndefined();
  });

  it("scores all seven passing features as 100", () => {
    const block = vfStockScore(snapshot(), DEFAULT_SCORING_CONFIG);
    expect(block.maxPoints).toBe(VF_FEATURE_WEIGHT_TOTAL);
    expect(block.availableMaxPoints).toBe(VF_FEATURE_WEIGHT_TOTAL);
    expect(normalize(block)).toBe(100);
  });

  it("excludes missing features from the denominator", () => {
    const block = vfStockScore(snapshot({ foreignNet20d: null }), DEFAULT_SCORING_CONFIG);
    expect(block.availableMaxPoints).toBe(
      VF_FEATURE_WEIGHT_TOTAL - VF_FEATURE_WEIGHTS.FOREIGN_NET_POSITIVE,
    );
    expect(normalize(block)).toBe(100);
  });
});


describe("screening data completeness and backtest parity", () => {
  const bars: DailyPrice[] = Array.from({ length: 300 }, (_, i) => ({
    tradeDate: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i,
    volume: 1000, tradingValue: 100000, marketCap: 1e12,
    foreignNetBuyValue: 1000000, institutionNetBuyValue: null,
  }));

  it("includes foreign flow before 252 bars, then enables the full 9.5 denominator", () => {
    for (const [count, available] of [[251, 7], [252, 9.5], [300, 9.5]] as const) {
      const snap = computeIndicators(bars, count - 1);
      const block = vfStockScore(snap);
      expect(block.maxPoints).toBe(9.5);
      expect(block.availableMaxPoints).toBe(available);
      expect(block.rows.find(r => r.group === "Vf Flow")?.points).toBe(2);
      const flags = evaluateFeatures(snap, LEGACY_PARAMS, bars[count - 1]!);
      const expected = Object.entries(VF_FEATURE_WEIGHTS).reduce(
        (sum, [id, weight]) => sum + (flags[id] === true ? weight : 0), 0,
      );
      expect(block.points).toBe(expected);
    }
  });

  it("treats a missing foreign day as unavailable, and zero/negative flows as failures", () => {
    const incomplete = bars.map(b => ({ ...b }));
    incomplete[290]!.foreignNetBuyValue = null;
    const block = vfStockScore(computeIndicators(incomplete, 299));
    expect(block.availableMaxPoints).toBe(7.5);
    expect(block.rows.find(r => r.group === "Vf Flow")?.status).toBe("NO_DATA");
    for (const foreignNet20d of [0, -1]) {
      const failed = vfStockScore(snapshot({ foreignNet20d }));
      expect(failed.availableMaxPoints).toBe(9.5);
      expect(failed.rows.find(r => r.group === "Vf Flow")?.status).toBe("FAIL");
    }
  });

  it("matches the screenshot: 4.5 technical + 2 foreign, high unavailable", () => {
    const block = vfStockScore(snapshot({ volumeRatio20: 26, high52w: null, distanceFrom52wHigh: null }));
    expect(block.points).toBe(6.5);
    expect(block.availableMaxPoints).toBe(7);
    expect(block.maxPoints).toBe(9.5);
    expect(normalize(block)).toBeCloseTo(92.857);
  });
});
