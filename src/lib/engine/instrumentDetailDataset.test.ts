import { describe, expect, it } from "vitest";

import { buildInstrumentDetailDataset } from "./instrumentDetailDataset";

const header = "symbol,name,market,type,date,open,high,low,close,volume,tradingValue";

function dateAt(index: number) {
  return new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
}

function indexRows(symbol: "KOSPI" | "KOSDAQ") {
  return Array.from({ length: 60 }, (_, index) =>
    [symbol, symbol, "INDEX", "INDEX", dateAt(index), 100, 101, 99, 100, 1, 100].join(","),
  );
}

describe("buildInstrumentDetailDataset", () => {
  it("keeps the selected instrument and market indexes needed by the parser", () => {
    const source = [
      header,
      ...indexRows("KOSPI"),
      ...indexRows("KOSDAQ"),
      [
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
      ].join(","),
      [
        "000660",
        "SK하이닉스",
        "KOSPI",
        "STOCK",
        dateAt(59),
        300000,
        301000,
        295000,
        299000,
        1000,
        299000000,
      ].join(","),
    ].join("\n");

    const dataset = buildInstrumentDetailDataset(source, "5930");

    expect(dataset.instruments.map((item) => item.symbol)).toEqual(["005930"]);
    expect(dataset.bars["005930"]).toHaveLength(1);
    expect(dataset.bars["000660"]).toBeUndefined();
    expect(dataset.indexSeries.map((item) => item.indexCode)).toEqual(["KOSPI", "KOSDAQ"]);
  });

  it("reports a missing selected instrument instead of a market-index error", () => {
    const source = [header, ...indexRows("KOSPI")].join("\n");
    expect(() => buildInstrumentDetailDataset(source, "005930")).toThrow(
      "005930의 원천 일봉을 찾지 못했습니다.",
    );
  });
});
