import { describe, expect, it } from "vitest";
import {
  calculateKrxPreliminary,
  previousKrxSession,
  krxPreliminaryExportValues,
  KRX_PRELIMINARY_EXPORT_HEADERS,
} from "./krxPreliminary";
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
const calendar = sessions(140);
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
    priceSource: "TOSS_ADJUSTED_CANDLE",
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
          marketCapSource: "KRX_ETF",
          etfMarketCap: 125e9,
          etfUnderlyingIndexClose: 105,
          etfUnderlyingIndexSource: "KRX_ETF",
        }),
  }));
const etf = (changes: Record<string, unknown> = {}) =>
  ({
    instrument: { symbol: "069500", instrumentType: "ETF", isLeveraged: false, isInverse: false },
    snapshot: { tradeDate: date, close: 100 },
    etfStrategy: {
      version: ETF_POLICY.version,
      date,
      previousDate: previous,
      dataStatus: "krx_batch_pending",
      region: "US",
      environmentSource: "own_index_lag1",
      issues: [],
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


  it("rejects unverified ETF price bars and strategy-invalid components even when scores are numeric", () => {
    const clean = bars();
    const partial = etf();
    expect(calculateKrxPreliminary(partial, analysis,
      dataset("069500", clean), reference("069500", 125e9))?.m0).toBeCloseTo(83.25);
    const badBar = bars();
    badBar[badBar.length - 22]!.priceSource = "TOSS_UNVERIFIED";
    const rawNumericButInvalid = etf({
      issues: ["수정주가 출처·120일 이력 확인 필요"],
    });
    const invalid = calculateKrxPreliminary(rawNumericButInvalid, analysis,
      dataset("069500", badBar), reference("069500", 125e9));
    expect(invalid?.status).toBe("INCOMPLETE");
    expect(invalid?.m0).toBeNull();
    expect(invalid?.preliminaryOnset).toBeNull();
    expect(invalid?.issues).toContain(
      "당일 수정주가 120거래일 출처 미검증 · 예비 M0 산정 보류",
    );
    expect(calculateKrxPreliminary(etf({ issues: ["벤치마크 수익률 없음"] }),
      analysis, dataset("069500", clean), reference("069500", 125e9))?.m0).toBeNull();
    expect(calculateKrxPreliminary(etf({ issues: ["환경점수 데이터 없음"] }),
      analysis, dataset("069500", clean), reference("069500", 125e9))?.m0).toBeNull();
  });

  it("does not assert a cross from a numeric-but-ineligible prior official M0", () => {
    const missingPriorCap = bars();
    const prior = missingPriorCap.find((b) => b.tradeDate === previous)!;
    prior.marketCapSource = "";
    expect(calculateKrxPreliminary(etf(), analysis,
      dataset("069500", missingPriorCap), reference("069500", 125e9)))
      .toMatchObject({ m0: 83.25, previousM0: 79, preliminaryOnset: null });
    const unverifiedPriorIndex = bars();
    unverifiedPriorIndex[unverifiedPriorIndex.length - 20]!.etfUnderlyingIndexSource = null;
    const preview = calculateKrxPreliminary(etf(), analysis,
      dataset("069500", unverifiedPriorIndex), reference("069500", 125e9));
    expect(preview?.m0).toBeCloseTo(83.25);
    expect(preview?.preliminaryOnset).toBeNull();
    expect(preview?.issues).toContain(
      "직전 거래일 가격·KRX·기초지수 적격성 미검증 · 예비 신규 돌파 보류",
    );
    const priorUnverifiedPrice = bars();
    priorUnverifiedPrice[priorUnverifiedPrice.length - 100]!.priceSource = "";
    expect(calculateKrxPreliminary(etf(), analysis,
      dataset("069500", priorUnverifiedPrice), reference("069500", 125e9))
      ?.preliminaryOnset).toBeNull();
  });

  it("exports the same explicitly labeled and dated metrics that admitted the preliminary view", () => {
    const preview = calculateKrxPreliminary(etf(), analysis,
      dataset("069500", bars()), reference("069500", 125e9));
    const fields = krxPreliminaryExportValues(preview);
    const col = (name: string) => fields[KRX_PRELIMINARY_EXPORT_HEADERS.indexOf(
      name as typeof KRX_PRELIMINARY_EXPORT_HEADERS[number],
    )];
    expect(KRX_PRELIMINARY_EXPORT_HEADERS).toHaveLength(fields.length);
    expect(col("예비 M0 (확정 아님)")).toBeCloseTo(83.25);
    expect(col("예비 20일 평균 KRX 거래대금 (원)")).toBe(1.5e9);
    expect(col("예비 KRX 시총 기준일")).toBe(previous);
    expect(col("예비 거래대금 종료 기준일")).toBe(previous);
    expect(col("예비 주가 기준일")).toBe(date);
    expect(col("예비 신규 돌파 (확정 아님)")).toBe("예비 돌파");
    expect(krxPreliminaryExportValues(undefined)).toEqual(
      KRX_PRELIMINARY_EXPORT_HEADERS.map(() => null),
    );
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
