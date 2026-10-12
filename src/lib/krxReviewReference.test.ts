import { describe, expect, it } from "vitest";
import { selectKrxReviewReference, type KrxReviewObservation } from "./krxReviewReference";
import {
  parseManualMarketDataWithReferences as parseManualMarketData,
  withKrxReviewReferences,
} from "./krxReviewReferenceParser";
import { parseManualMarketData as parseEngineInput } from "./engine/manualDataset";
import { getMockDataset } from "./engine/mockProvider";
import { runAnalysis } from "./engine/pipeline";
import { projectKrDashboard } from "./dashboardOperations";
import { compactDashboardRow } from "./dashboardRow";
import { buildSnapshot } from "./screeningSnapshot";
import { simulateStrategy } from "./portfolioLedgers";

const prior: KrxReviewObservation = {
  date: "2026-10-08",
  source: "KRX_ETF",
  values: {
    marketCap: 2e11,
    nav: 10000,
    tradingValue: 0,
    aum: 3e11,
    listedUnits: 3e7,
    underlyingIndexName: "기초지수",
    underlyingIndexClose: 100,
  },
};

describe("read-only dated KRX reference", () => {
  it("keeps the previous trading day across four calendar days and blocks future/invalid dates", () => {
    const observations = [
      prior,
      { ...prior, date: "2026-10-13", values: { nav: 999 } },
      { ...prior, date: "2026-09-31" },
    ];
    const before = JSON.stringify(observations);
    const reference = selectKrxReviewReference(observations, "2026-10-12");
    expect(reference.fields.nav).toMatchObject({ date: "2026-10-08", value: 10000 });
    expect(reference.fields.tradingValue?.value).toBe(0);
    expect(JSON.stringify(observations)).toBe(before);
    expect(selectKrxReviewReference(observations, "invalid").fields).toEqual({});
  });
  it("updates dates independently when exact current values arrive; null and invalid zero never masquerade as current", () => {
    const next: KrxReviewObservation = {
      ...prior,
      date: "2026-10-12",
      values: {
        nav: 10100,
        marketCap: null,
        aum: 0,
        listedUnits: -1,
        underlyingIndexClose: NaN,
        underlyingIndexName: "",
      },
    };
    const ref = selectKrxReviewReference([next, prior], "2026-10-12");
    expect(ref.fields.nav).toMatchObject({ date: "2026-10-12", value: 10100 });
    for (const field of [
      "marketCap",
      "aum",
      "listedUnits",
      "underlyingIndexClose",
      "underlyingIndexName",
    ] as const)
      expect(ref.fields[field]?.date).toBe("2026-10-08");
    expect(selectKrxReviewReference([], "2026-10-12").fields).toEqual({});
  });
  it("parses official reference fields without filling price bars, ETF health facts or capabilities", () => {
    const rows = [
      {
        symbol: "005930",
        name: "삼성전자",
        market: "KOSPI",
        date: "2026-10-08",
        close: 100,
        marketCap: 2e11,
        listedShares: 1000,
        marketCapSource: "KRX_STOCK",
      },
      {
        symbol: "360750",
        market: "ETF",
        date: "2026-10-08",
        close: 100,
        etfMarketCap: 2e11,
        etfNav: 10000,
        etfNetAssetTotalAmount: 3e11,
        etfListedUnits: 3e7,
        etfUnderlyingIndexName: "S&P 500",
        etfUnderlyingIndexClose: 6000,
        etfTradingValue: 0,
        marketCapSource: "KRX_ETF",
        tradingValueSource: "KRX_ETF",
      },
      { symbol: "005930", market: "KOSPI", date: "2026-10-12", close: 110, marketCap: null },
      { symbol: "360750", market: "ETF", date: "2026-10-12", close: 110 },
    ];
    const ds = parseManualMarketData(JSON.stringify(rows), { allowIncompleteIndex: true }).dataset;
    expect(ds.bars["005930"]!.at(-1)!.marketCap).toBeNull();
    expect(ds.bars["360750"]!.at(-1)!.etfMarketCap).toBeNull();
    expect(ds.etfFacts).toEqual({});
    expect(ds.capabilities.etfFacts).toBe(false);
    const { krxReviewObservations, ...engineDataset } = ds;
    expect(engineDataset).toEqual(
      parseEngineInput(JSON.stringify(rows), { allowIncompleteIndex: true }).dataset,
    );
    const partial = parseManualMarketData(
      JSON.stringify([rows[0], { ...rows[1], marketCapSource: "", etfMarketCap: null }]),
      { allowIncompleteIndex: true },
    ).dataset;
    expect(partial.krxReviewObservations!["360750"]![0]!.values.nav).toBe(10000);
    expect(partial.krxReviewObservations!["360750"]![0]!.values.marketCap).toBeUndefined();
    expect(
      selectKrxReviewReference(ds.krxReviewObservations!["005930"]!, ds.asOfDate).fields
        .listedShares,
    ).toMatchObject({ date: "2026-10-08", value: 1000 });
    const ref = selectKrxReviewReference(ds.krxReviewObservations!["360750"]!, ds.asOfDate);
    expect(ref.fields.underlyingIndexName?.value).toBe("S&P 500");
    expect(ref.fields.nav?.value).toBe(10000);
    const untrusted = parseManualMarketData(
      JSON.stringify([{ ...rows[0], marketCapSource: "TOSS" }]),
      { allowIncompleteIndex: true },
    ).dataset;
    expect(untrusted.krxReviewObservations).toEqual({});
    const csv =
      "symbol,market,date,close,listedShares,marketCap,marketCapSource\n005930,KOSPI,2026-10-08,100,1000,200000000000,KRX_STOCK";
    expect(
      parseManualMarketData(csv, { allowIncompleteIndex: true }).dataset.krxReviewObservations![
        "005930"
      ]![0]!.values.listedShares,
    ).toBe(1000);
  });
  it("bounds retained context and rejects future-only observations before rendering", () => {
    const rows = Array.from({ length: 90 }, (_, i) => ({
      symbol: "005930",
      market: "KOSPI",
      date: new Date(Date.UTC(2026, 6, i + 1)).toISOString().slice(0, 10),
      close: 100,
      marketCapSource: "KRX_STOCK",
      marketCap: 1e11 + i,
      listedShares: 1000,
    }));
    const parsed = parseManualMarketData(JSON.stringify(rows), { allowIncompleteIndex: true });
    expect(parsed.dataset.krxReviewObservations!["005930"]).toHaveLength(1);
    expect(
      selectKrxReviewReference([{ ...prior, date: "2026-10-13" }], "2026-10-12").fields,
    ).toEqual({});
  });
  it("leaves every calculated strategy, score, rank and policy field identical and transports display context", () => {
    const ds = getMockDataset();
    const before = JSON.stringify(ds);
    const first = runAnalysis(ds);
    const observations = Object.fromEntries(
      ds.instruments.map((i) => [i.symbol, [{ ...prior, date: ds.asOfDate }]]),
    );
    const second = withKrxReviewReferences(runAnalysis(ds), {
      ...ds,
      krxReviewObservations: observations,
    });
    const strategyOnly = (result: typeof first) => ({
      ...result,
      calculatedAt: "fixed",
      rows: result.rows.map(({ krxReviewReference, ...row }) => row),
    });
    expect(strategyOnly(second)).toEqual(strategyOnly(first));
    const firstSnapshot = buildSnapshot(first);
    const secondSnapshot = buildSnapshot(second);
    expect({ ...secondSnapshot, savedAt: "fixed" }).toEqual({ ...firstSnapshot, savedAt: "fixed" });
    const settings = {
      initialCapital: 10000000,
      maxPositions: 30,
      sectorCap: 0.3,
      roundTripCostRate: 0.003,
    };
    const markets = Object.fromEntries(ds.instruments.map((i) => [i.symbol, i.market]));
    const left = simulateStrategy(settings, [firstSnapshot], ds.bars, markets);
    const right = simulateStrategy(settings, [secondSnapshot], ds.bars, markets);
    expect({ ...right, calculatedAt: "fixed" }).toEqual({ ...left, calculatedAt: "fixed" });
    expect(JSON.stringify(ds)).toBe(before);
    const row = second.rows[0]!;
    expect(row.krxReviewReference?.fields.nav?.value).toBe(10000);
    expect(compactDashboardRow(row).krxReviewReference).toEqual(row.krxReviewReference);
    expect(
      projectKrDashboard(second).rows.find((r) => r.symbol === row.instrument.symbol)
        ?.krxReviewReference,
    ).toEqual(row.krxReviewReference);
  });
});
