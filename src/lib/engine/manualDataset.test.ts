import { describe, expect, it } from "vitest";

import { normalizeKrxSymbol, parseManualMarketData } from "./manualDataset";

const header = [
  "symbol",
  "name",
  "market",
  "securityType",
  "date",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "tradingValue",
  "marketCap",
  "foreignNetBuyValue",
  "institutionNetBuyValue",
  "sectorCode",
  ...Array.from({ length: 87 }, (_, index) => `unused${index}`),
].join(",");

function dateAt(index: number) {
  const date = new Date(Date.UTC(2024, 0, index + 1));
  return date.toISOString().slice(0, 10);
}

function indexRows() {
  return Array.from({ length: 60 }, (_, index) =>
    [
      "KOSPI",
      "코스피",
      "INDEX",
      "INDEX",
      dateAt(index),
      100,
      101,
      99,
      100,
      1,
      100,
      "",
      "",
      "",
      "",
    ].join(","),
  );
}

describe("parseManualMarketData large-column CSV path", () => {
  it("allows explicit index-only parsing for the shared strict market-gate provider", () => {
    const csv = [header, ...indexRows()].join("\n");
    expect(() => parseManualMarketData(csv)).toThrow("분석할 종목 일봉이 없습니다");
    const parsed = parseManualMarketData(csv, { allowIndexOnly: true });
    expect(parsed.dataset.instruments).toEqual([]);
    expect(parsed.dataset.indexSeries[0]?.bars).toHaveLength(60);
    expect(parsed.dataset.vkospiObservations).toHaveLength(60);
  });

  it("reads only engine fields, maps new headers, and de-duplicates across files", () => {
    const stock = [
      "005930",
      "삼성전자",
      "KOSPI",
      "STOCK",
      dateAt(59),
      70000,
      71000,
      69000,
      70500,
      1000,
      70500000,
      400000000,
      1000000,
      2000000,
      "SEMICONDUCTOR",
    ].join(",");
    const first = [header, ...indexRows(), stock].join("\n");
    const second = [header, stock].join("\n");

    const parsed = parseManualMarketData([first, second]);

    expect(parsed.dataset.instruments).toHaveLength(1);
    expect(parsed.dataset.instruments[0]?.sectorCode).toBe("SEMICONDUCTOR");
    expect(parsed.dataset.bars["005930"]).toHaveLength(1);
    expect(parsed.dataset.bars["005930"]?.[0]?.tradingValue).toBe(70_500_000);
    expect(parsed.dataset.vkospiObservations?.[19]?.value).toBeNull();
    expect(parsed.dataset.vkospiObservations?.[20]).toEqual({
      date: dateAt(20),
      value: 0,
      source: "REALIZED_VOLATILITY_KOSPI",
    });
    expect(parsed.dataset.vkospiSeries).toHaveLength(40);
  });

  it("fills short and lending fields from a later overlapping source", () => {
    const supplyHeader = [
      "symbol",
      "name",
      "market",
      "securityType",
      "date",
      "open",
      "high",
      "low",
      "close",
      "volume",
      "tradingValue",
      "marketCap",
      "foreignNetBuyValue",
      "institutionNetBuyValue",
      "sectorCode",
      "shortSellingVolumeRate",
      "lendingBalanceQuantity",
    ].join(",");

    const indexes = Array.from({ length: 60 }, (_, index) =>
      [
        "KOSPI",
        "코스피",
        "INDEX",
        "INDEX",
        dateAt(index),
        100,
        101,
        99,
        100,
        1,
        100,
        "",
        "",
        "",
        "",
        "",
        "",
      ].join(","),
    );
    const baseStock = [
      "005930",
      "삼성전자",
      "KOSPI",
      "STOCK",
      dateAt(59),
      70000,
      71000,
      69000,
      70500,
      1000,
      70500000,
      400000000,
      1000000,
      2000000,
      "SEMICONDUCTOR",
      "",
      "",
    ].join(",");
    const enrichedStock = [
      "005930",
      "삼성전자",
      "KOSPI",
      "STOCK",
      dateAt(59),
      70000,
      71000,
      69000,
      70500,
      1000,
      70500000,
      "",
      "",
      "",
      "SEMICONDUCTOR",
      1.75,
      123456,
    ].join(",");

    const parsed = parseManualMarketData([
      [supplyHeader, ...indexes, baseStock].join("\n"),
      [supplyHeader, enrichedStock].join("\n"),
    ]);

    const bar = parsed.dataset.bars["005930"]?.[0];
    expect(bar?.marketCap).toBe(400_000_000);
    expect(bar?.shortSellingVolumeRate).toBe(1.75);
    expect(bar?.lendingBalanceQuantity).toBe(123_456);
  });

  it("normalizes numeric KRX symbols without changing index or non-numeric symbols", () => {
    expect(normalizeKrxSymbol("5930")).toBe("005930");
    expect(normalizeKrxSymbol("660")).toBe("000660");
    expect(normalizeKrxSymbol("10060")).toBe("010060");
    expect(normalizeKrxSymbol("A005930")).toBe("005930");
    expect(normalizeKrxSymbol("5930.0")).toBe("005930");
    expect(normalizeKrxSymbol("KOSPI")).toBe("KOSPI");
    expect(normalizeKrxSymbol("ABC123")).toBe("ABC123");
  });

  it("merges short and zero-padded aliases into one stock time series", () => {
    const shortCodeRow = [
      "5930",
      "삼성전자",
      "KOSPI",
      "STOCK",
      dateAt(58),
      69000,
      70500,
      68500,
      70000,
      900,
      63000000,
      400000000,
      900000,
      1800000,
      "SEMICONDUCTOR",
    ].join(",");
    const paddedCodeRow = [
      "005930",
      "삼성전자",
      "KOSPI",
      "STOCK",
      dateAt(59),
      70000,
      71000,
      69000,
      70500,
      1000,
      70500000,
      400000000,
      1000000,
      2000000,
      "SEMICONDUCTOR",
    ].join(",");

    const parsed = parseManualMarketData([
      [header, ...indexRows(), shortCodeRow].join("\n"),
      [header, paddedCodeRow].join("\n"),
    ]);

    expect(parsed.dataset.instruments).toHaveLength(1);
    expect(parsed.dataset.instruments[0]?.symbol).toBe("005930");
    expect(parsed.dataset.bars["005930"]?.map((bar) => bar.tradeDate)).toEqual([
      dateAt(58),
      dateAt(59),
    ]);
    expect(parsed.dataset.bars["5930"]).toBeUndefined();
  });
});

it.each(["0", ""])(
  "retains a domestic stock observation with close '%s' for execution, but not indicator prices",
  (close) => {
    const { dataset } = parseManualMarketData(
      [
        "symbol,date,market,open,high,low,close,volume",
        `A,2026-10-12,KOSDAQ,100,110,90,${close},1000`,
      ].join("\n"),
      { allowIncompleteIndex: true },
    );
    expect(dataset.observedBars!["A"]).toHaveLength(1);
    expect(dataset.observedBars!["A"]![0]).toMatchObject({
      open: 100,
      volume: 1000,
      openObserved: true,
      volumeObserved: true,
      close: 0,
    });
    expect(dataset.bars["A"]).toEqual([]);
    expect(dataset.liquidSymbolCountsByDate!["2026-10-12"]).toBe(1);
  },
);

it.each([0, null])("does not turn a missing close %s into an observed intraday low", (close) => {
  const parsed = parseManualMarketData(
    JSON.stringify([
      {
        symbol: "005930",
        market: "KOSPI",
        date: "2026-10-14",
        open: 100,
        high: 110,
        low: 90,
        close,
        volume: 1000,
      },
    ]),
    { allowIncompleteIndex: true },
  );
  expect(parsed.dataset.observedBars!["005930"]![0]).toMatchObject({
    open: 100,
    high: 110,
    low: 90,
    close: 0,
  });
});

const partialMissingCloseCases = ["KOSDAQ", "ETF"].flatMap((market) =>
  [null, 0, ""].flatMap((close) =>
    [null, 0, 100].flatMap((open) =>
      [null, 0, 110].flatMap((high) =>
        [null, 0, 90].map((low) => ({ market, close, open, high, low })),
      ),
    ),
  ),
);
it.each(partialMissingCloseCases)(
  "preserves supplied OHLC independently for missing-close observation %j",
  (input) => {
    const { dataset } = parseManualMarketData(
      JSON.stringify([{ ...input, symbol: "005930", date: "2026-10-14", volume: null }]),
      { allowIncompleteIndex: true },
    );
    expect(dataset.observedBars!["005930"]![0]).toMatchObject({
      open: input.open ?? 0,
      high: input.high ?? 0,
      low: input.low ?? 0,
      close: 0,
      openObserved: input.open !== null,
      volume: 0,
      volumeObserved: false,
    });
    expect(dataset.bars["005930"]).toEqual([]);
  },
);

it("preserves prior observed OHLC and provenance when a duplicate only supplies enrichment", () => {
  const { dataset } = parseManualMarketData(
    JSON.stringify([
      {
        symbol: "005930",
        market: "KOSPI",
        date: "2026-10-14",
        open: 100,
        high: 110,
        low: 90,
        close: 0,
        volume: 1000,
      },
      { symbol: "005930", market: "KOSPI", date: "2026-10-14", close: 0, foreignNetBuyValue: 5 },
    ]),
    { allowIncompleteIndex: true },
  );
  expect(dataset.observedBars!["005930"]![0]).toMatchObject({
    open: 100,
    high: 110,
    low: 90,
    close: 0,
    volume: 1000,
    openObserved: true,
    volumeObserved: true,
    foreignNetBuyValue: 5,
  });
});
