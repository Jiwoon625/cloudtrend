import { describe, expect, it } from "vitest";
import { calculateKrxPreliminary, previousKrxSession } from "./krxPreliminary";
import { selectKrxReviewReference } from "./krxReviewReference";
import { ETF_POLICY } from "./engine/etfStrategy";
import type { ScreeningRow, AnalysisResult } from "./engine/pipeline";
import type { MarketDataset } from "./engine/dataset";
import type { DailyPrice } from "./engine/types";

const sessions = (total: number) => {
  const dates: string[] = [];
  for (let day = Date.UTC(2026, 4, 1); dates.length < total; day += 86400000) {
    const date = new Date(day);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
      dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
};
const calendar = sessions(100);
const date = calendar.at(-1)!;
const previous = calendar.at(-2)!;
const cfg = {
  universe: { minMarketCap: 300e9 },
  priority: { minMarketCap: 300e9, sizePoints: 1 },
} as AnalysisResult["scoringConfig"];
const analysis = { asOfDate: date, tradeDates: calendar, scoringConfig: cfg };
const stock = (marketCap: number | null, failedRules: string[] = []) =>
  ({
    instrument: { symbol: "005930", instrumentType: "STOCK" },
    snapshot: { tradeDate: date },
    marketCap,
    failedRules,
    pendingRules: ["기준일 시가총액 미확인 · 판단 보류"],
  }) as unknown as ScreeningRow;
const dataset = (symbol: string, bars: DailyPrice[]) =>
  ({
    isLive: true,
    asOfDate: date,
    tradeDates: calendar,
    bars: { [symbol]: bars },
  }) as MarketDataset;

const reference = (symbol: string, cap: number, onDate = previous) =>
  selectKrxReviewReference(
    [
      {
        date: onDate,
        source: symbol === "005930" ? "KRX_STOCK" : "KRX_ETF",
        values: { marketCap: cap, underlyingIndexClose: 105 },
      },
    ],
    date,
  );
const bars = (): DailyPrice[] =>
  calendar.map((d) => ({
    tradeDate: d,
    close: 100,
    open: 100,
    high: 100,
    low: 100,
    volume: 1000,
    tradingValue: 1e9,
    marketCap: null,
    foreignNetBuyValue: null,
    institutionNetBuyValue: null,
    ...(d === date
      ? {}
      : {
          etfTradingValue: 1.5e9,
          tradingValueSource: "KRX_ETF",
          etfUnderlyingIndexClose: 105,
          etfUnderlyingIndexSource: "KRX_ETF",
        }),
  }));
const etf = (changes: Record<string, unknown> = {}) =>
  ({
    instrument: { symbol: "069500", instrumentType: "ETF", isLeveraged: false, isInverse: false },
    snapshot: { tradeDate: date },
    etfStrategy: {
      version: ETF_POLICY.version,
      date,
      previousDate: previous,
      dataStatus: "krx_batch_pending",
      score: null,
      previousScore: 79,
      technical: 90,
      priority: 0,
      health: null,
      environment: 80,
      ...changes,
    },
  }) as unknown as ScreeningRow;

describe("KRX previous-session preliminary; official engine is untouched", () => {
  it("recognizes the previous exchange session, not yesterday's calendar date", () => {
    expect(previousKrxSession(["2026-10-08", "2026-10-12"], "2026-10-12")).toBe("2026-10-08");
    expect(previousKrxSession(["2026-10-08", "2026-10-12"], "2026-10-15")).toBeNull();
  });

  it("makes stock cap an explicitly dated preliminary universe check, retaining other failures", () => {
    const valid = calculateKrxPreliminary(
      stock(null),
      analysis,
      dataset("005930", []),
      reference("005930", 450e9),
    );
    expect(valid).toMatchObject({
      kind: "STOCK",
      status: "ESTIMATE",
      priceDate: date,
      marketCapDate: previous,
      stockUniverse: "PASS",
      preliminarySizePoints: 1,
    });
    const small = calculateKrxPreliminary(
      stock(null),
      analysis,
      dataset("005930", []),
      reference("005930", 200e9),
    );
    expect(small?.stockUniverse).toBe("FAIL");
    const failed = calculateKrxPreliminary(
      stock(null, ["투자경고종목 제외"]),
      analysis,
      dataset("005930", []),
      reference("005930", 450e9),
    );
    expect(failed?.stockUniverse).toBe("FAIL");
    expect(
      calculateKrxPreliminary(
        stock(null),
        analysis,
        dataset("005930", []),
        reference("005930", 450e9, calendar.at(-3)!),
      )?.marketCap,
    ).toBeNull();
    expect(
      calculateKrxPreliminary(
        stock(null),
        analysis,
        dataset("005930", []),
        reference("005930", 450e9, date),
      )?.marketCapDate,
    ).toBe(date);
  });

  it("uses 20 actually published ETF sessions, never repeats the prior trading day as current", () => {
    const observed = bars();
    const before = JSON.stringify(observed);
    const result = calculateKrxPreliminary(
      etf(),
      analysis,
      dataset("069500", observed),
      reference("069500", 125e9),
    );
    expect(result).toMatchObject({
      kind: "ETF",
      status: "ESTIMATE",
      priceDate: date,
      marketCapDate: previous,
      tradingValueThrough: previous,
      averageTradingValue20: 1.5e9,
      healthPoints: 15,
      m0: 83.25,
      previousM0: 79,
      preliminaryOnset: true,
      underlyingDate: previous,
      underlyingClose: 105,
      underlyingMa60: 105,
    });
    expect(JSON.stringify(observed)).toBe(before);
    const gap = bars();
    gap[gap.length - 12]!.etfTradingValue = null;
    expect(
      calculateKrxPreliminary(etf(), analysis, dataset("069500", gap), reference("069500", 125e9))
        ?.m0,
    ).toBeNull();
    expect(
      calculateKrxPreliminary(
        etf({ previousScore: null }),
        analysis,
        dataset("069500", observed),
        reference("069500", 125e9),
      )?.preliminaryOnset,
    ).toBeNull();
  });

  it("does not promote pending previews to a confirmed onset or fabricate the next morning", () => {
    const complete = etf({ dataStatus: "ready" });
    const current = bars();
    current[current.length - 1]!.etfTradingValue = 1.5e9;
    current[current.length - 1]!.tradingValueSource = "KRX_ETF";
    const asOf = reference("069500", 125e9, date);
    expect(
      calculateKrxPreliminary(complete, analysis, dataset("069500", current), asOf),
    ).toBeUndefined();
    expect(
      calculateKrxPreliminary(
        etf(),
        analysis,
        { ...dataset("069500", bars()), isLive: false },
        reference("069500", 125e9),
      ),
    ).toBeUndefined();
    const legacy = { ...etf(), snapshot: { tradeDate: previous } } as ScreeningRow;
    expect(
      calculateKrxPreliminary(
        legacy,
        analysis,
        dataset("069500", bars()),
        reference("069500", 125e9),
      ),
    ).toBeUndefined();
  });
});
