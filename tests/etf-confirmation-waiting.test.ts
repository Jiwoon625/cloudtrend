import { describe, expect, it } from "vitest";
import { calculateEtfStrategies, etfOrderPlan } from "../src/lib/engine/etfStrategy";
import { FULL_CAPABILITIES, type MarketDataset } from "../src/lib/engine/dataset";
import type { DailyPrice, Instrument } from "../src/lib/engine/types";
import type { AnalysisResult, ScreeningRow } from "../src/lib/engine/pipeline";
import { marketSignals, projectKrDashboard } from "../src/lib/dashboardOperations";
import golden from "./fixtures/etf-v01-golden.json";

// All prices are the existing deterministic synthetic OHLC fixture. The new
// names, identifiers, session dates, and KRX fields are synthetic as well.
const symbol = "SYN001";
const mapping = {
  [symbol]: {
    assetClass: "equity",
    sectorCode: "SYNTHETIC",
    region: "US",
    stockSectorCode: "",
    rotationSource: "not_applicable_no_compatible_stock_sector",
    underlyingIndexName: "Synthetic Test Index",
  },
};
function fixture(): MarketDataset {
  const sessions: string[] = [];
  for (let time = Date.UTC(2027, 0, 4); sessions.length < golden.bars.length; time += 86400000) {
    const date = new Date(time);
    if (![0, 6].includes(date.getUTCDay())) sessions.push(date.toISOString().slice(0, 10));
  }
  const bars: DailyPrice[] = golden.bars.map((b, i) => ({
    ...b,
    tradeDate: sessions[i]!,
    open: b.close,
    volume: 100,
    tradingValue: 0,
    marketCap: 10e9,
    foreignNetBuyValue: null,
    institutionNetBuyValue: null,
    etfUnderlyingIndexClose: 100 + i,
    etfMarketCap: i >= golden.bars.length - 2 ? 100e9 : 10e9,
    etfTradingValue: 0,
    priceSource: "TOSS_ADJUSTED_CANDLE",
    marketCapSource: "KRX_ETF",
    tradingValueSource: "KRX_ETF",
  }));
  const instrument: Instrument = {
    id: symbol,
    symbol,
    name: "합성 검증 ETF",
    instrumentType: "ETF",
    market: "ETF",
    sectorCode: "SYNTHETIC",
    sectorName: "합성",
    isPreferredStock: false,
    isManagementIssue: false,
    isInvestmentWarning: false,
    isLeveraged: false,
    isInverse: false,
    isActive: true,
    indexMemberships: [],
  };
  const instruments = Array.from({ length: 10 }, (_, i) => ({
    ...instrument,
    id: `SYN${String(i + 1).padStart(3, "0")}`,
    symbol: `SYN${String(i + 1).padStart(3, "0")}`,
  }));
  return {
    provider: "SYNTHETIC_TEST",
    version: "1",
    asOfDate: sessions.at(-1)!,
    isLive: false,
    capabilities: FULL_CAPABILITIES,
    notes: [],
    sectors: [],
    tradeDates: sessions,
    instruments,
    bars: Object.fromEntries(instruments.map((i) => [i.symbol, structuredClone(bars)])),
    indexSeries: [],
    financials: {},
    etfFacts: {},
    vkospiSeries: [],
  };
}
function evaluate(ds: MarketDataset) {
  const strategy = calculateEtfStrategies(ds, mapping).get(symbol)!;
  const row = {
    instrument: ds.instruments[0]!,
    snapshot: ds.bars[symbol]!.find((bar) => bar.tradeDate === ds.asOfDate)!,
    etfStrategy: strategy,
  } as ScreeningRow;
  const index = projectKrDashboard({
    asOfDate: ds.asOfDate,
    tradeDates: ds.tradeDates,
    rows: [row],
  } as AnalysisResult);
  return { strategy, index, signals: marketSignals(index, "ETF", [], [], null, "2026-10-12") };
}
function missingBatch(ds: MarketDataset) {
  for (const bars of Object.values(ds.bars))
    Object.assign(bars.at(-1)!, {
      etfMarketCap: null,
      etfTradingValue: null,
      etfUnderlyingIndexClose: null,
      marketCapSource: "",
      tradingValueSource: "CLOSE_X_VOLUME_PROXY",
    });
}

describe("ETF confirmation publication lifecycle", () => {
  it.each(["confirmed", "low_score", "below_ma60"] as const)(
    "preserves evening waiting and resolves the same session as %s on morning arrival",
    (outcome) => {
      const complete = fixture(),
        morning = structuredClone(complete);
      const origin = complete.tradeDates.at(-2)!;
      morning.asOfDate = origin;
      const original = evaluate(morning);
      expect(original.strategy).toMatchObject({
        entryState: "pending",
        rawOnset: true,
        originDate: origin,
      });
      expect(original.signals.pendingCount).toBe(1);
      const evening = structuredClone(complete);
      missingBatch(evening);
      const before = JSON.stringify(evening);
      for (let repeat = 0; repeat < 3; repeat++) {
        const waiting = evaluate(evening);
        expect(waiting.strategy).toMatchObject({
          entryState: "data_pending",
          dataStatus: "krx_batch_pending",
          onset: false,
          originDate: origin,
          confirmationDate: evening.asOfDate,
          score: null,
        });
        expect(waiting.signals.pendingCount).toBe(1);
        expect(waiting.signals.pending![0]).toMatchObject({
          signalOriginDate: origin,
          score: null,
        });
        expect(waiting.signals.onsetCount).toBe(0);
        expect(
          etfOrderPlan({
            equity: 1e7,
            cash: 1e7,
            heldSymbols: [],
            candidates: [{ symbol, price: 100, strategy: waiting.strategy }],
          }),
        ).toEqual([]);
      }
      expect(JSON.stringify(evening)).toBe(before);
      if (outcome === "low_score") complete.bars[symbol]!.at(-1)!.etfMarketCap = 10e9;
      if (outcome === "below_ma60") complete.bars[symbol]!.at(-1)!.etfUnderlyingIndexClose = 50;
      for (let repeat = 0; repeat < 3; repeat++) {
        const final = evaluate(complete);
        expect(final.strategy.technical).toBeGreaterThan(90);
        expect(final.strategy.entryState).toBe(outcome === "confirmed" ? "confirmed" : "rejected");
        expect(final.strategy.originDate).toBe(origin);
        expect(final.signals.pendingCount).toBe(0);
        expect(final.signals.onsetCount).toBe(outcome === "confirmed" ? 1 : 0);
        if (outcome === "low_score")
          expect(final.strategy.confirmationIssues).toContain("확인일 M0 80 미만 또는 결측");
        if (outcome === "below_ma60")
          expect(final.strategy.confirmationIssues).toContain("확인일 기초지수 MA60 하회");
      }
    },
  );
  it("does not turn generic KRX batch absence into a waiting origin", () => {
    const ds = fixture();
    for (const bars of Object.values(ds.bars)) bars.at(-2)!.etfMarketCap = 10e9;
    missingBatch(ds);
    const result = evaluate(ds);
    expect(result.strategy.originDate).toBeNull();
    expect(result.signals.pendingCount).toBe(0);
    expect(result.signals.onsetCount).toBe(0);
  });
});
