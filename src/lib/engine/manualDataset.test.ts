import { describe, expect, it } from "vitest";

import { parseManualMarketData } from "./manualDataset";

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

describe("parseManualMarketData large-column CSV path", () => {
  it("reads only engine fields, maps new headers, and de-duplicates across files", () => {
    const indexRows = Array.from({ length: 60 }, (_, index) =>
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
    const first = [header, ...indexRows, stock].join("\n");
    const second = [header, stock].join("\n");

    const parsed = parseManualMarketData([first, second]);

    expect(parsed.dataset.instruments).toHaveLength(1);
    expect(parsed.dataset.instruments[0]?.sectorCode).toBe("SEMICONDUCTOR");
    expect(parsed.dataset.bars["005930"]).toHaveLength(1);
    expect(parsed.dataset.bars["005930"]?.[0]?.tradingValue).toBe(70_500_000);
  });
});
