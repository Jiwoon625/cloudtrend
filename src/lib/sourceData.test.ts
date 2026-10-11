import ExcelJS from "exceljs";
import { parseManualMarketData } from "./engine/manualDataset";
import { describe, expect, it, vi } from "vitest";

import {
  SOURCE_MAX_FILE_BYTES,
  compareSourceRows,
  parseDelimitedRows,
  validateSourceBlob,
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

  it("stops immediately when an uploaded file exceeds 45MB", async () => {
    const arrayBuffer = vi.fn(async () => {
      throw new Error("oversized file should not be read");
    });
    const blob = {
      size: SOURCE_MAX_FILE_BYTES + 1,
      type: "text/csv",
      arrayBuffer,
    } as unknown as Blob;

    const result = await validateSourceBlob(blob, "oversized.csv");

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      { code: "FILE_TOO_LARGE", message: "파일 1개 크기는 45MB 이하여야 합니다." },
    ]);
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
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

describe("missing-close upload observations", () => {
  it.each(["", "0"])("retains a legitimate close '%s' from uploaded CSV bytes", async (close) => {
    const result = await validateSourceBlob(
      new Blob([
        `symbol,date,market,open,high,low,close,volume\n005930,2026-10-14,KOSPI,100,110,90,${close},1000\n`,
      ]),
      "observed.csv",
    );
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    expect(result.rows[0]).toMatchObject({
      symbol: "005930",
      close: "0",
      open: "100",
      volume: "1000",
    });
  });
});

const observation = {
  symbol: "005930",
  market: "KOSPI",
  date: "2026-10-14",
  open: 100,
  high: 110,
  low: 90,
  close: null,
  volume: 1000,
};

describe("canonical observation safety", () => {
  it.each(["csv", "streaming-csv", "json", "xlsx"])(
    "retains missing-close observations through %s upload bytes",
    async (format) => {
      const rows = [observation, { ...observation, symbol: "069500", market: "ETF", type: "ETF" }];
      let bytes: Uint8Array;
      if (format === "xlsx") {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("data");
        const columns = [...Object.keys(observation), "type"];
        sheet.addRow(columns);
        for (const row of rows)
          sheet.addRow(columns.map((column) => (row as Record<string, unknown>)[column]));
        bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
      } else if (format === "json") bytes = new TextEncoder().encode(JSON.stringify(rows));
      else
        bytes = new TextEncoder().encode(
          "symbol,market,date,open,high,low,close,volume,type\n005930,KOSPI,2026-10-14,100,110,90,,1000,STOCK\n069500,ETF,2026-10-14,100,110,90,,1000,ETF\n",
        );
      const validation = await validateSourceBytes({
        bytes,
        filename: `source.${format === "streaming-csv" ? "csv" : format}`,
        streamingCsv: format === "streaming-csv",
      });
      expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
      expect(validation.rows.map((row) => row.close)).toEqual(["0", "0"]);
      expect(
        validation.warnings.filter((issue) => issue.code === "MISSING_CLOSE_OBSERVATION"),
      ).toHaveLength(2);
      const dataset = parseManualMarketData(validation.canonicalCsv, {
        allowIncompleteIndex: true,
      }).dataset;
      for (const symbol of ["005930", "069500"]) {
        expect(dataset.bars[symbol]).toEqual([]);
        expect(dataset.observedBars![symbol]![0]).toMatchObject({
          open: 100,
          close: 0,
          volume: 1000,
          openObserved: true,
          volumeObserved: true,
        });
      }
      const again = await validateSourceText(validation.canonicalCsv);
      expect(again.valid).toBe(true);
      expect(again.dataHash).toBe(validation.dataHash);
    },
  );

  it("accepts omitted close columns for domestic observations while preserving missing execution evidence", async () => {
    const validation = await validateSourceText(
      "symbol,market,date,high,low\n005930,KOSPI,2026-10-14,110,90\n",
    );
    expect(validation.valid).toBe(true);
    expect(validation.rows[0]).toMatchObject({ open: "", volume: "", close: "0" });
    const dataset = parseManualMarketData(validation.canonicalCsv, {
      allowIncompleteIndex: true,
    }).dataset;
    expect(dataset.observedBars!["005930"]![0]).toMatchObject({
      openObserved: false,
      volumeObserved: false,
      close: 0,
    });
    expect(dataset.bars["005930"]).toEqual([]);
  });

  it.each([
    { close: "garbage" },
    { close: -1 },
    { close: "Infinity" },
    { open: -1 },
    { open: "bad" },
    { high: 99 },
    { low: 101 },
    { high: 80, low: 90 },
    { high: 0 },
    { low: 0 },
    { volume: -1 },
    { volume: "bad" },
    { tradingValue: -1 },
    { marketCap: -1 },
    { date: "2026-02-30" },
    { symbol: "" },
  ])("rejects malformed or contradictory observation %j", async (bad) => {
    const validation = await validateSourceText(
      JSON.stringify([{ ...observation, ...bad }]),
      "source.json",
    );
    expect(validation.valid).toBe(false);
    expect(validation.rows).toEqual([]);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it.each([
    { symbol: "KOSPI", market: "INDEX", type: "INDEX" },
    { symbol: "SPY", market: "NYSE", type: "ETF" },
    { symbol: "AAPL", market: "NASDAQ", type: "STOCK" },
    { symbol: "UNKNOWN", market: "", type: "STOCK" },
  ])(
    "does not relax positive-close validation outside recognized domestic observations: %j",
    async (instrument) => {
      for (const close of [null, 0]) {
        const validation = await validateSourceText(
          JSON.stringify([{ ...observation, ...instrument, close }]),
          "source.json",
        );
        expect(validation.valid).toBe(false);
        expect(validation.rows).toEqual([]);
      }
    },
  );

  it("retains observed zero volume without turning it into liquidity", async () => {
    const validation = await validateSourceText(
      JSON.stringify([{ ...observation, volume: 0 }]),
      "source.json",
    );
    expect(validation.valid).toBe(true);
    const dataset = parseManualMarketData(validation.canonicalCsv, {
      allowIncompleteIndex: true,
    }).dataset;
    expect(dataset.observedBars!["005930"]![0]).toMatchObject({ volume: 0, volumeObserved: true });
    expect(dataset.liquidSymbolCountsByDate![observation.date]).toBe(0);
  });
});
