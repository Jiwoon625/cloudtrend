import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  compareSourceRows,
  parseDelimitedRows,
  validateSourceBytes,
  validateSourceText,
} from "./sourceData";

const CSV = `종목코드,종목명,시장,일자,시가,고가,저가,종가,거래량,거래대금,외국인순매수
005930,삼성전자,KOSPI,2026-09-09,70000,72000,69500,71000,100,7100000,500000
KOSPI,코스피,INDEX,2026-09-09,2600,2620,2590,2610,0,0,
`;

describe("CloudTrend source validation", () => {
  it("normalizes a CSV and creates deterministic hashes", async () => {
    const first = await validateSourceText(CSV, "today.csv");
    const second = await validateSourceText(CSV, "renamed.csv");
    expect(first.valid).toBe(true);
    expect(first.stats).toMatchObject({
      rowCount: 2,
      symbolCount: 2,
      stockCount: 1,
      indexCount: 1,
    });
    expect(first.rows[0]).toMatchObject({ symbol: "005930", date: "2026-09-09", sector: "SEMI" });
    expect(first.dataHash).toBe(second.dataHash);
    expect(first.fileHash).toBe(second.fileHash);
    expect(first.canonicalCsv).toContain("foreignNetBuyValue");
  });

  it("keeps commas and newlines inside quoted CSV cells", () => {
    expect(parseDelimitedRows('symbol,name,date,close\n1,"A, Inc.",20260909,10')).toEqual([
      ["symbol", "name", "date", "close"],
      ["1", "A, Inc.", "20260909", "10"],
    ]);
    expect(parseDelimitedRows('symbol,name,date,close\n1,"two\nlines",20260909,10')[1]?.[1]).toBe(
      "two\nlines",
    );
  });

  it("deduplicates identical rows and rejects conflicting duplicate keys", async () => {
    const identical = await validateSourceText(
      `${CSV}005930,삼성전자,KOSPI,2026-09-09,70000,72000,69500,71000,100,7100000,500000\n`,
    );
    expect(identical.valid).toBe(true);
    expect(identical.stats.duplicateRowCount).toBe(1);

    const conflict = await validateSourceText(
      `${CSV}005930,삼성전자,KOSPI,2026-09-09,70000,73000,69500,72000,100,7200000,500000\n`,
    );
    expect(conflict.valid).toBe(false);
    expect(conflict.errors.some((error) => error.code === "DUPLICATE_CONFLICT")).toBe(true);
  });

  it("rejects invalid dates and invalid OHLC", async () => {
    const result = await validateSourceText(
      "symbol,date,open,high,low,close\n005930,2026-02-30,100,90,80,110\n",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["INVALID_DATE", "INVALID_OHLC"]),
    );
  });

  it("flattens nested JSON bars", async () => {
    const json = JSON.stringify([
      {
        symbol: "005930",
        name: "삼성전자",
        market: "KOSPI",
        bars: [{ date: "20260909", open: 10, high: 12, low: 9, close: 11, volume: 2 }],
      },
    ]);
    const result = await validateSourceText(json, "source.json");
    expect(result.valid).toBe(true);
    expect(result.rows[0]).toMatchObject({ symbol: "005930", date: "2026-09-09", close: "11" });
  });

  it("reads the first worksheet of an XLSX file", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("data");
    sheet.addRow(["symbol", "name", "market", "date", "open", "high", "low", "close", "volume"]);
    sheet.addRow(["005930", "삼성전자", "KOSPI", "2026-09-09", 10, 12, 9, 11, 2]);
    const buffer = await workbook.xlsx.writeBuffer();
    const result = await validateSourceBytes({
      bytes: new Uint8Array(buffer),
      filename: "source.xlsx",
    });
    expect(result.valid).toBe(true);
    expect(result.format).toBe("xlsx");
    expect(result.rows[0]?.symbol).toBe("005930");
  });

  it("preserves the Toss+KRX extended contract and reports header-only columns", async () => {
    const result = await validateSourceText(
      `symbol,name,market,securityType,date,open,high,low,close,volume,tradingValue,sectorCode,listedShares,shortSellingVolume,lendingBalanceQuantity,priceSource
005930,삼성전자,KOSPI,STOCK,2026-09-09,10,12,9,11,2,22,SEMI,1000,,,TOSS
`,
      "extended.csv",
    );
    expect(result.valid).toBe(true);
    expect(result.rows[0]).toMatchObject({
      type: "STOCK",
      sector: "SEMI",
      listedShares: "1000",
      priceSource: "TOSS",
    });
    expect(result.canonicalCsv).toContain("shortSellingVolume");
    expect(result.stats.completelyEmptyColumns).toEqual(
      expect.arrayContaining(["shortSellingVolume", "lendingBalanceQuantity"]),
    );
    expect(result.stats.columnNonEmptyRates["listedShares"]).toBe(1);
  });

  it("reports identical and conflicting overlap separately", async () => {
    const existing = await validateSourceText(CSV);
    const incoming = await validateSourceText(
      `symbol,name,market,date,open,high,low,close,volume
005930,삼성전자,KOSPI,2026-09-09,70000,72000,69500,71000,100
005930,삼성전자,KOSPI,2026-09-10,71000,73000,70000,72500,200
`,
    );
    const overlap = compareSourceRows(incoming.rows, [{ sourceId: "old", rows: existing.rows }]);
    expect(overlap).toMatchObject({ incomingRows: 2, newRows: 1, conflictingRows: 1 });
  });
});
