import { describe, expect, it } from "vitest";

import { DEFAULT_BACKTEST_PARAMS } from "./backtestV4";
import { computeIndicators, type IndicatorSnapshot } from "./indicators";
import { evaluateFeatures, DEFAULT_BACKTEST_PARAMS as LEGACY_PARAMS } from "./backtest";
import type { DailyPrice } from "./types";
import {
  DEFAULT_SCORING_CONFIG,
  normalize,
  vfStockScore,
  v8FinalStockScore,
  strictRawTechnicalScore,
  historicalTechnicalScore,
} from "./scoring";
import { getMockDataset } from "./mockProvider";
import { runAnalysis, scoreHistory } from "./pipeline";
import { evaluateUniverse, vfGrade } from "./scoring";
import { computeV8SectorPriceLeadership } from "./v8SectorPriceLeadership";
import { selectV8SectorPriceLeadership } from "./v8SectorPriceLeadershipPolicy";
import { VF_FEATURE_WEIGHTS, VF_FEATURE_WEIGHT_TOTAL } from "./vfConfig";

// Seven-feature Vf base is intentionally retained for historical research.
// V8 adds the sector slot separately; using the eight-feature total here would
// accidentally double-count it in historical sector-penalty studies.
const HISTORICAL_VF_WEIGHTS = {
  ICH_ABOVE_CLOUD: 1,
  ICH_TENKAN_KIJUN: 1,
  BB_BREAKOUT: 1.5,
  MA_ALIGNED: 1,
  VOLUME_SURGE: 0.5,
  NEAR_52W_HIGH: 2.5,
  FOREIGN_NET_POSITIVE: 2,
} as const;

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

describe("Historical seven-feature Vf research base", () => {
  it("keeps legacy backtest weights separate from the live V8 sector slot", () => {
    for (const [id, weight] of Object.entries(HISTORICAL_VF_WEIGHTS)) {
      expect(DEFAULT_BACKTEST_PARAMS.weights[id]).toBe(weight);
    }
    expect(DEFAULT_BACKTEST_PARAMS.features).toEqual(Object.keys(HISTORICAL_VF_WEIGHTS));
    expect(DEFAULT_BACKTEST_PARAMS.weights["SECTOR_PRICE_LEADERSHIP"]).toBeUndefined();
    expect(VF_FEATURE_WEIGHTS).toEqual({ ...HISTORICAL_VF_WEIGHTS, SECTOR_PRICE_LEADERSHIP: 0.5 });
    expect(VF_FEATURE_WEIGHT_TOTAL).toBe(10);
    expect(DEFAULT_BACKTEST_PARAMS.weights["MA20_SLOPE_UP"]).toBeUndefined();
    expect(DEFAULT_BACKTEST_PARAMS.weights["RS_POSITIVE"]).toBeUndefined();
  });

  it("scores all seven passing features as 100", () => {
    const block = vfStockScore(snapshot(), DEFAULT_SCORING_CONFIG);
    expect(block.maxPoints).toBe(9.5);
    expect(block.availableMaxPoints).toBe(9.5);
    expect(normalize(block)).toBe(100);
  });

  it("excludes missing features from the denominator", () => {
    const block = vfStockScore(snapshot({ foreignNet20d: null }), DEFAULT_SCORING_CONFIG);
    expect(block.availableMaxPoints).toBe(9.5 - HISTORICAL_VF_WEIGHTS.FOREIGN_NET_POSITIVE);
    expect(normalize(block)).toBe(100);
  });
});

describe("Historical Vf normalization and seven-feature backtest parity", () => {
  const bars: DailyPrice[] = Array.from({ length: 300 }, (_, i) => ({
    tradeDate: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 101 + i,
    volume: 1000,
    tradingValue: 100000,
    marketCap: 1e12,
    foreignNetBuyValue: 1000000,
    institutionNetBuyValue: null,
  }));

  it("includes foreign flow before 252 bars, then enables the full 9.5 denominator", () => {
    for (const [count, available] of [
      [251, 7],
      [252, 9.5],
      [300, 9.5],
    ] as const) {
      const snap = computeIndicators(bars, count - 1);
      const block = vfStockScore(snap);
      expect(block.maxPoints).toBe(9.5);
      expect(block.availableMaxPoints).toBe(available);
      expect(block.rows.find((r) => r.group === "Vf Flow")?.points).toBe(2);
      const flags = evaluateFeatures(snap, LEGACY_PARAMS, bars[count - 1]!);
      const expected = Object.entries(HISTORICAL_VF_WEIGHTS).reduce(
        (sum, [id, weight]) => sum + (flags[id] === true ? weight : 0),
        0,
      );
      expect(block.points).toBe(expected);
    }
  });

  it("treats a missing foreign day as unavailable, and zero/negative flows as failures", () => {
    const incomplete = bars.map((b) => ({ ...b }));
    incomplete[290]!.foreignNetBuyValue = null;
    const block = vfStockScore(computeIndicators(incomplete, 299));
    expect(block.availableMaxPoints).toBe(7.5);
    expect(block.rows.find((r) => r.group === "Vf Flow")?.status).toBe("NO_DATA");
    for (const foreignNet20d of [0, -1]) {
      const failed = vfStockScore(snapshot({ foreignNet20d }));
      expect(failed.availableMaxPoints).toBe(9.5);
      expect(failed.rows.find((r) => r.group === "Vf Flow")?.status).toBe("FAIL");
    }
  });

  it("preserves legacy partial normalization: 4.5 technical + 2 foreign, high unavailable", () => {
    const block = vfStockScore(
      snapshot({ volumeRatio20: 26, high52w: null, distanceFrom52wHigh: null }),
    );
    expect(block.points).toBe(6.5);
    expect(block.availableMaxPoints).toBe(7);
    expect(block.maxPoints).toBe(9.5);
    expect(normalize(block)).toBeCloseTo(92.857);
  });
});

describe("Current V8 stock operating score", () => {
  it.each([
    { pl: 79.999, threshold: 80, slot: 0.5 },
    { pl: 80, threshold: 80, slot: 0 },
    { pl: 83.999, threshold: 84, slot: 0.5 },
    { pl: 84, threshold: 84, slot: 0 },
    { pl: null, threshold: 84, slot: 0 },
  ])(
    "keeps the fixed 10-point denominator at PL=$pl / threshold=$threshold",
    ({ pl, threshold, slot }) => {
      const options = { sectorPriceLeadership: pl, sectorPriceLeadershipThreshold: threshold };
      const block = v8FinalStockScore(snapshot(), DEFAULT_SCORING_CONFIG, options);
      expect(block.rows).toHaveLength(8);
      expect(block.points).toBe(9.5 + slot);
      expect(block.maxPoints).toBe(10);
      expect(block.availableMaxPoints).toBe(10);
      expect(block.rows.at(-1)).toMatchObject({ group: "V8 Sector", points: slot, maxPoints: 0.5 });
      expect(strictRawTechnicalScore(block)).toBe(9.5 + slot);
      expect(historicalTechnicalScore(snapshot(), DEFAULT_SCORING_CONFIG, options).points).toBe(
        9.5 + slot,
      );
    },
  );

  it("never promotes a missing core feature by rescaling the available denominator", () => {
    const snap = snapshot({ foreignNet20d: null });
    const options = { sectorPriceLeadership: 60 };
    const block = v8FinalStockScore(snap, DEFAULT_SCORING_CONFIG, options);
    expect(block.points).toBe(8);
    expect(block.availableMaxPoints).toBe(8);
    expect(block.maxPoints).toBe(10);
    expect(normalize(block)).toBe(100); // Valid only as a generic helper, never a live score.
    expect(strictRawTechnicalScore(block)).toBeNull();
    expect(historicalTechnicalScore(snap, DEFAULT_SCORING_CONFIG, options)).toMatchObject({
      points: null,
      rawPoints: 8,
      rawMaxPoints: 10,
      availableMaxPoints: 8,
      missingRules: ["최근 20거래일 외국인 누적 순매수 > 0"],
    });
  });

  it("uses dated sector PL and strict raw points consistently in screening and history", () => {
    const dataset = getMockDataset();
    const analysis = runAnalysis(dataset);
    const stockPl = computeV8SectorPriceLeadership(dataset, 0, "STOCK");
    const etfPl = computeV8SectorPriceLeadership(dataset, 0, "ETF");
    const stocks = analysis.rows.filter((r) => r.instrument.instrumentType === "STOCK");
    expect(stocks.length).toBeGreaterThan(0);
    for (const row of stocks) {
      const selection = selectV8SectorPriceLeadership(
        row.instrument.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI",
        row.instrument.sectorCode,
        stockPl,
        etfPl,
      );
      const expected = v8FinalStockScore(row.snapshot, DEFAULT_SCORING_CONFIG, {
        sectorPriceLeadership: selection.value,
        sectorPriceLeadershipThreshold: selection.threshold,
      });
      const raw = strictRawTechnicalScore(expected);
      expect(row.sectorPriceLeadership).toBe(selection.value);
      expect(row.technical).toEqual(expected);
      expect(row.vf).toEqual(expected);
      expect(row.technical.maxPoints).toBe(10);
      expect(row.operatingScore10).toBe(raw);
      expect(row.totalScoreNormalized).toBe(raw === null ? 0 : raw * 10);
      expect(row.grade).toBe(vfGrade(raw === null ? null : raw * 10));
      const history = scoreHistory(dataset, row.instrument.symbol, 1);
      expect(history[0]?.technicalPoints).toBe(raw);
      expect(history[0]?.grade).toBe(row.grade);
    }
  });

  it("keeps a missing foreign day null in live/history scores despite a positive partial score", () => {
    const dataset = getMockDataset();
    const stock = dataset.instruments.find((i) => i.instrumentType === "STOCK")!;
    const original = dataset.bars[stock.symbol]!;
    const incomplete = {
      ...dataset,
      bars: {
        ...dataset.bars,
        [stock.symbol]: original.map((bar, i) =>
          i === original.length - 1 ? { ...bar, foreignNetBuyValue: null } : bar,
        ),
      },
    };
    const row = runAnalysis(incomplete).rows.find((r) => r.instrument.symbol === stock.symbol)!;
    expect(row.technical.points).toBeGreaterThan(0);
    expect(row.technical.availableMaxPoints).toBe(8);
    expect(row.operatingScore10).toBeNull();
    expect(row.totalScoreNormalized).toBe(0);
    expect(row.grade).toBe("C");
    expect(row.kosdaq80Onset).toBe(false);
    expect(row.kospi80Onset).toBe(false);
    expect(scoreHistory(incomplete, stock.symbol, 1)[0]?.technicalPoints).toBeNull();
  });

  it("does not disqualify low intraday turnover even with an old saved threshold", () => {
    const inst = getMockDataset().instruments.find((i) => i.instrumentType === "STOCK")!;
    const eligible = {
      ...inst,
      isActive: true,
      isPreferredStock: false,
      isManagementIssue: false,
      isInvestmentWarning: false,
    };
    const params = { ...DEFAULT_SCORING_CONFIG.universe, minTradingValue: 3000000000 };
    const snap = snapshot({ close: 10000 });
    const result = evaluateUniverse(eligible, snap, 1e12, 0, 300, undefined, params);
    expect(result.passed).toBe(true);
    expect(result.failedRules).toEqual([]);
    expect(evaluateUniverse(eligible, snap, 1, 0, 300, undefined, params).failedRules).toContain(
      "시가총액 기준 미달",
    );
    expect(evaluateUniverse(eligible, snap, 1e12, 0, 119, undefined, params).failedRules).toContain(
      "최근 120거래일 데이터 부족",
    );
  });
});
