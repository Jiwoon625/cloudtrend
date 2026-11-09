import { describe, expect, it } from "vitest";
import type { CanonicalSourceRow } from "../src/lib/sourceData";
import { isIndexOnlyDatePart } from "../scripts/index-only-date-part";

const row = (overrides: Partial<CanonicalSourceRow>): CanonicalSourceRow => ({
  symbol: "KOSPI",
  name: "KOSPI",
  market: "INDEX",
  type: "INDEX",
  date: "2026-11-06",
  open: "5000",
  high: "5100",
  low: "4900",
  close: "5059.69",
  volume: "198130000",
  tradingValue: "0",
  marketCap: "",
  foreignNetBuyValue: "-14838549784",
  institutionNetBuyValue: "1312209358596",
  sector: "",
  ...overrides,
});

describe("isIndexOnlyDatePart", () => {
  it("accepts a verified index part: every as-of row is an index row", () => {
    expect(
      isIndexOnlyDatePart(
        [
          row({ date: "2026-11-05", close: "5383.8" }),
          row({ symbol: "KOSDAQ", date: "2026-11-06", close: "1650.2" }),
        ],
        "2026-11-06",
      ),
    ).toBe(true);
  });

  it("keeps the FINAL capitalization requirement for a stock part", () => {
    expect(
      isIndexOnlyDatePart(
        [
          row({
            symbol: "005930",
            name: "삼성전자",
            market: "KOSPI",
            type: "STOCK",
            marketCap: "1103193000000000",
            marketCapSource: "KRX_STOCK",
          }),
        ],
        "2026-11-06",
      ),
    ).toBe(false);
  });

  it("keeps the requirement for an ETF part", () => {
    expect(
      isIndexOnlyDatePart(
        [
          row({
            symbol: "069500",
            name: "KODEX 200",
            market: "ETF",
            type: "ETF",
            marketCap: "1000000000",
            marketCapSource: "KRX_ETF",
          }),
        ],
        "2026-11-06",
      ),
    ).toBe(false);
  });

  it("does not excuse a part with no row on the as-of date", () => {
    expect(isIndexOnlyDatePart([row({ date: "2026-11-05" })], "2026-11-06")).toBe(false);
    expect(isIndexOnlyDatePart([], "2026-11-06")).toBe(false);
  });
});
