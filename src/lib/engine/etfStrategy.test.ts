import { describe, expect, it } from "vitest";
import {
  calculateEtfStrategies,
  ETF_MAPPING,
  ETF_POLICY,
  etfEntryWeight,
  etfFamily,
  etfOrderPlan,
  etfTechnical,
  type EtfStrategySnapshot,
} from "./etfStrategy";
import { parseManualMarketData } from "./manualDataset";
import { runAnalysis } from "./pipeline";
import { FULL_CAPABILITIES, type MarketDataset } from "./dataset";
import type { DailyPrice, Instrument } from "./types";
import golden from "../../../tests/fixtures/etf-v01-golden.json";

function fixture(): MarketDataset {
  const bars: DailyPrice[] = golden.bars.map((b, i) => ({
    ...b,
    tradeDate: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    open: b.close,
    volume: 100,
    tradingValue: 2e9,
    marketCap: 200e9,
    foreignNetBuyValue: null,
    institutionNetBuyValue: null,
    etfUnderlyingIndexClose: 100 + i,
    etfMarketCap: 200e9,
    etfTradingValue: 2e9,
    priceSource: "TOSS_ADJUSTED_CANDLE",
    marketCapSource: "KRX_ETF",
    tradingValueSource: "KRX_ETF",
  }));
  const inst: Instrument = {
    id: "360750",
    symbol: "360750",
    name: "TIGER 미국S&P500",
    instrumentType: "ETF",
    market: "ETF",
    sectorCode: "MARKET_IDX",
    sectorName: "시장대표",
    isPreferredStock: false,
    isManagementIssue: false,
    isInvestmentWarning: false,
    isLeveraged: false,
    isInverse: false,
    isActive: true,
    indexMemberships: [],
  };
  return {
    provider: "TEST",
    version: "1",
    asOfDate: bars.at(-1)!.tradeDate,
    isLive: true,
    capabilities: FULL_CAPABILITIES,
    notes: [],
    sectors: [],
    tradeDates: bars.map((b) => b.tradeDate),
    instruments: [inst],
    bars: { "360750": bars },
    indexSeries: [
      { indexCode: "KOSPI", indexName: "KOSPI", bars: bars.map((b) => ({ ...b, close: 100 })) },
    ],
    financials: {},
    etfFacts: {},
    vkospiSeries: [],
  };
}
function snapshot(ds = fixture()) {
  return calculateEtfStrategies(ds).get("360750")!;
}
function entry(vol = 0.3): EtfStrategySnapshot {
  return { ...snapshot(), onset: true, annualVolatility: vol };
}

describe("ETF V0.1 confirmed policy", () => {
  it("preserves all 393 research mappings, 245 plain equity classifications", () => {
    expect(Object.keys(ETF_MAPPING)).toHaveLength(393);
    expect(Object.values(ETF_MAPPING).filter((m) => m.assetClass === "equity")).toHaveLength(245);
    expect(Object.values(ETF_POLICY.weights).reduce<number>((a, b) => a + b, 0)).toBe(100);
  });
  it("matches independently calculated pandas technical and sample volatility", () => {
    const ds = fixture(),
      s = snapshot(ds);
    expect(s.technical).toBeCloseTo(golden.technical, 10);
    expect(etfTechnical(ds.bars["360750"]!.slice(0, -1))).toBeCloseTo(golden.previousTechnical, 10);
    expect(s.annualVolatility).toBeCloseTo(golden.annualVolatility, 12);
    expect(s.score).toBeCloseTo(golden.technical * 0.625 + 30, 10);
    expect(s.priority).toBe(0);
    expect(s.health).toBe(100);
    expect(s.environment).toBe(100);
    expect(s.environmentSource).toBe("own_index_lag1");
    expect(s.eligible).toBe(true);
    expect(s.onset).toBe(false); // Already above 80 on both days.
  });
  it.each([
    [0, 0.1],
    [0.15, 0.1],
    [0.2, 0.075],
    [0.25, 0.06],
    [0.3, 0.05],
    [0.6, 0.025],
  ])("uses linear sizing at sigma %s", (vol, weight) => {
    expect(etfEntryWeight(vol)).toBeCloseTo(weight, 12);
  });
  it.each([null, NaN, Infinity, -0.1])("blocks invalid volatility %s", (vol) =>
    expect(etfEntryWeight(vol)).toBeNull(),
  );
  it("generates a fresh onset from prior M0, without a liquidity hard gate", () => {
    const ds = fixture(),
      bars = ds.bars["360750"]!;
    bars.forEach((b) => {
      b.etfTradingValue = 0;
      b.etfMarketCap = 10e9;
    });
    bars.at(-1)!.etfMarketCap = 100e9;
    const s = snapshot(ds);
    expect(s.previousScore).toBeLessThan(80);
    expect(s.score).toBeGreaterThanOrEqual(80);
    expect(s.onset).toBe(true);
  });
  it("does not manufacture an onset across a missing previous session", () => {
    const ds = fixture();
    ds.bars["360750"]!.splice(-2, 1);
    expect(snapshot(ds).onset).toBe(false);
  });
  it("never substitutes the KOSPI or zero for a missing ETF underlying", () => {
    const ds = fixture();
    ds.bars["360750"]!.at(-1)!.etfUnderlyingIndexClose = null;
    const s = snapshot(ds);
    expect(s.exit).toBe("DATA_UNAVAILABLE");
    expect(s.underlyingClose).toBeNull();
    expect(s.eligible).toBe(false);
    expect(s.onset).toBe(false);
  });
  it("exits on the MA60 state even if it was already below yesterday", () => {
    const ds = fixture();
    ds.bars["360750"]!.slice(-2).forEach((b) => (b.etfUnderlyingIndexClose = 50));
    const s = snapshot(ds);
    expect(s.exit).toBe("MA60");
  });
  it("requires dated KRX amounts and adjusted-price provenance", () => {
    const ds = fixture();
    ds.bars["360750"]!.at(-1)!.marketCapSource = "ESTIMATED";
    expect(snapshot(ds).health).toBeNull();
    expect(snapshot(ds).eligible).toBe(false);
    ds.bars["360750"]!.at(-1)!.priceSource = "";
    expect(snapshot(ds).issues.join(" ")).toContain("수정주가");
  });
  it("ignores future bars and future peer information", () => {
    const ds = fixture(),
      before = snapshot(ds);
    ds.bars["360750"]!.push({
      ...ds.bars["360750"]!.at(-1)!,
      tradeDate: "2099-01-01",
      close: 1e9,
      etfUnderlyingIndexClose: 1,
    });
    expect(snapshot(ds)).toEqual(before);
  });
  it("removes rotation, size, membership, premium, tracking and fees from scoring", () => {
    const ds = fixture(),
      s = snapshot(ds);
    ds.instruments[0]!.indexMemberships = ["KOSPI200", "KRX300"];
    ds.etfFacts["360750"] = {
      nav: 1,
      premiumDiscountRate: 999,
      totalExpenseRatio: 999,
      assetsUnderManagement: 1,
      averageTradingValue20d: 1,
      underlyingIndex: "KOSPI",
    };
    ds.bars["360750"]!.forEach((b) => (b.etfMarketCap = 999e9));
    expect(snapshot(ds).score).toBe(s.score);
    expect(snapshot(ds).priority).toBe(s.priority);
    const row = runAnalysis(ds).rows[0]!;
    expect(row.etfStrategy?.version).toBe(ETF_POLICY.version);
    expect(row.totalScoreNormalized).toBe(s.score);
    expect(row.priority.points).toBe(0);
    expect(row.hardFilterPassed).toBe(true);
    expect(row.failedRules).toEqual([]);
  });
  it("retains source fields through CSV parsing", () => {
    const ds = fixture();
    const keys = [
      "symbol",
      "name",
      "market",
      "type",
      "date",
      "open",
      "high",
      "low",
      "close",
      "volume",
      "tradingValue",
      "marketCap",
      "etfUnderlyingIndexClose",
      "etfMarketCap",
      "etfTradingValue",
      "priceSource",
      "marketCapSource",
      "tradingValueSource",
    ];
    const lines = [keys.join(",")];
    for (const [symbol, kind, bars] of [
      ["KOSPI", "INDEX", ds.indexSeries[0]!.bars],
      ["360750", "ETF", ds.bars["360750"]!],
    ] as const)
      for (const b of bars) {
        const rec: Record<string, unknown> = {
          ...b,
          symbol,
          name: symbol,
          market: kind,
          type: kind,
          date: b.tradeDate,
        };
        lines.push(keys.map((k) => rec[k] ?? "").join(","));
      }
    const parsed = parseManualMarketData(lines.join("\n")).dataset;
    expect(parsed.bars["360750"]!.at(-1)!.etfUnderlyingIndexClose).toBe(249);
    expect(snapshot(parsed).score).toBeCloseTo(snapshot(ds).score!, 10);
  });
  it("groups hedge/share variants so peers cannot include their own family", () => {
    expect(etfFamily("S&P 500 Total Return Index")).toBe(etfFamily("S&P500 Price Return"));
    expect(etfFamily("KOSPI 200 정보기술")).not.toBe(etfFamily("KOSPI 200"));
  });
  it("uses stock-only sector ranks and does not let ETFs change breadth", () => {
    const ds = fixture();
    for (let group = 0; group < 3; group++) {
      const symbol = `stock${group}`;
      ds.instruments.push({
        ...ds.instruments[0]!,
        id: symbol,
        symbol,
        instrumentType: "STOCK",
        market: "KOSPI",
        sectorCode: `sector${group}`,
      });
      ds.bars[symbol] = Array.from({ length: 300 }, (_, i) => {
        const close = 100 * Math.exp(0.001 * (group + 1) * i);
        return {
          ...ds.bars["360750"]![0]!,
          tradeDate: new Date(Date.UTC(2025, 0, 1 + i - 150)).toISOString().slice(0, 10),
          close,
          high: close * 1.01,
          low: close * 0.99,
        };
      });
    }
    const mapping = {
      "360750": {
        ...ETF_MAPPING["360750"]!,
        region: "KR",
        rotationSource: "domestic_stock_sector",
        stockSectorCode: "sector1",
      },
    };
    const s = calculateEtfStrategies(ds, mapping).get("360750")!;
    expect(s.environment).toBeCloseTo(60, 10); // median sector rank 1/3, trend 20, breadth 20.
    expect(s.environmentSource).toBe("stock_sector");
  });
});

describe("ETF executable new-order budget", () => {
  const candidates = () =>
    Array.from({ length: 12 }, (_, i) => ({
      symbol: String(i).padStart(6, "0"),
      price: 10000,
      strategy: entry(),
    }));
  it("limits the whole plan to cash, 10 positions and integer shares", () => {
    const orders = etfOrderPlan({
      equity: 1e7,
      cash: 1e6,
      heldSymbols: [],
      candidates: candidates(),
    });
    expect(orders.length).toBeLessThanOrEqual(10);
    expect(orders.reduce((s, o) => s + o.estimatedCost, 0)).toBeLessThanOrEqual(1e6);
    expect(orders[0]!.quantity).toBe(49);
    expect(orders.every((o) => Number.isInteger(o.quantity))).toBe(true);
  });
  it("keeps symbol order, skips owned/duplicate candidates, leaves at most one slot", () => {
    const held = Array.from({ length: 9 }, (_, i) => String(i).padStart(6, "0"));
    const c = candidates().reverse();
    c.push(c[0]!);
    const orders = etfOrderPlan({ equity: 1e7, cash: 1e7, heldSymbols: held, candidates: c });
    expect(orders.map((o) => o.symbol)).toEqual(["000009"]);
  });
  it("does not rebalance, top up, or buy states without a new onset", () => {
    const c = candidates();
    c.forEach((x) => (x.strategy.onset = false));
    expect(etfOrderPlan({ equity: 1e7, cash: 1e7, heldSymbols: [], candidates: c })).toEqual([]);
  });
  it("blocks invalid cash and prices and unavailable volatility", () => {
    expect(
      etfOrderPlan({ equity: 1e7, cash: 2e7, heldSymbols: [], candidates: candidates() }),
    ).toEqual([]);
    const c = candidates();
    c.forEach((x) => (x.strategy.annualVolatility = null));
    expect(etfOrderPlan({ equity: 1e7, cash: 1e7, heldSymbols: [], candidates: c })).toEqual([]);
    c.forEach((x) => {
      x.strategy.annualVolatility = 0.3;
      x.price = NaN;
    });
    expect(etfOrderPlan({ equity: 1e7, cash: 1e7, heldSymbols: [], candidates: c })).toEqual([]);
  });
});
