import { describe, expect, it } from "vitest";

import { validateSourceBytes } from "../sourceData";
import { buildV8InputQualityReport, V8_INPUT_CONTRACT_VERSION } from "./v8InputQuality";

async function validateCsv(csv: string, fileName = "screening.csv") {
  return validateSourceBytes({
    bytes: new TextEncoder().encode(csv),
    filename: fileName,
    contentType: "text/csv",
  });
}

const structuralHeader = [
  "symbol",
  "name",
  "market",
  "type",
  "date",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "tradingValue",
];

describe("main screening source contract", () => {
  it("accepts the current stock format when market and foreignNetBuyValue are supplied", async () => {
    const header = [...structuralHeader, "marketCap", "foreignNetBuyValue", "institutionNetBuyValue"];
    const row = [
      "005930",
      "삼성전자",
      "KOSPI",
      "STOCK",
      "2026-09-11",
      "70000",
      "71000",
      "69000",
      "70500",
      "1000",
      "70500000",
      "400000000000000",
      "12500000000",
      "8100000000",
    ];
    const validation = await validateCsv(`${header.join(",")}\n${row.join(",")}\n`);
    const report = buildV8InputQualityReport([{ fileName: "screening.csv", validation }]);

    expect(validation.valid).toBe(true);
    expect(report.contractVersion).toBe(V8_INPUT_CONTRACT_VERSION);
    expect(report.validForV8).toBe(true);
    expect(report.filesInvalidRequiredColumns).toEqual([]);
  });

  it("rejects a stock file that omits foreignNetBuyValue", async () => {
    const row = [
      "005930",
      "삼성전자",
      "KOSPI",
      "STOCK",
      "2026-09-11",
      "70000",
      "71000",
      "69000",
      "70500",
      "1000",
      "70500000",
    ];
    const validation = await validateCsv(`${structuralHeader.join(",")}\n${row.join(",")}\n`);
    const report = buildV8InputQualityReport([{ fileName: "screening.csv", validation }]);

    expect(validation.valid).toBe(true);
    expect(report.validForV8).toBe(false);
    expect(report.filesMissingRequiredColumns[0]?.columns).toContain("foreignNetBuyValue");
  });

  it("rejects an all-empty foreignNetBuyValue column but permits row-level nulls in mixed stock data", async () => {
    const header = [...structuralHeader, "foreignNetBuyValue"];
    const base = ["005930", "삼성전자", "KOSPI", "STOCK"];
    const rows = [
      [...base, "2026-09-10", "70000", "71000", "69000", "70500", "1000", "70500000", ""],
      [...base, "2026-09-11", "70500", "71500", "70000", "71000", "1200", "85200000", "1000000000"],
    ];
    const validation = await validateCsv(
      `${header.join(",")}\n${rows.map((row) => row.join(",")).join("\n")}\n`,
    );
    const report = buildV8InputQualityReport([{ fileName: "screening.csv", validation }]);

    expect(validation.valid).toBe(true);
    expect(report.validForV8).toBe(true);
    expect(validation.rows[0]?.foreignNetBuyValue).toBe("");
    expect(validation.rows[1]?.foreignNetBuyValue).toBe("1000000000");
  });

  it("does not require foreignNetBuyValue for an index-only correction file", async () => {
    const row = [
      "KOSPI",
      "코스피",
      "INDEX",
      "INDEX",
      "2026-09-11",
      "3310",
      "3330",
      "3290",
      "3320",
      "0",
      "0",
    ];
    const validation = await validateCsv(
      `${structuralHeader.join(",")}\n${row.join(",")}\n`,
      "kospi-correction.csv",
    );
    const report = buildV8InputQualityReport([
      { fileName: "kospi-correction.csv", validation },
    ]);

    expect(validation.stats.stockCount).toBe(0);
    expect(report.validForV8).toBe(true);
    expect(report.filesInvalidRequiredColumns).toEqual([]);
  });
});
