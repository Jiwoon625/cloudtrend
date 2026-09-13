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
