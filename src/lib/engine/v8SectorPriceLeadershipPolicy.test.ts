import { describe, expect, it } from "vitest";

import { selectV8SectorPriceLeadership } from "./v8SectorPriceLeadershipPolicy";

describe("selectV8SectorPriceLeadership", () => {
  it("uses ETF PL first and applies KOSPI threshold 84", () => {
    const stock = new Map([["SEMI", 72]]);
    const etf = new Map([["SEMI", 88]]);

    expect(selectV8SectorPriceLeadership("KOSPI", "SEMI", stock, etf)).toEqual({
      value: 88,
      source: "ETF",
      threshold: 84,
    });
  });

  it("uses ETF PL first and applies KOSDAQ threshold 85", () => {
    const stock = new Map([["BIO", 74]]);
    const etf = new Map([["BIO", 83]]);

    expect(selectV8SectorPriceLeadership("KOSDAQ", "BIO", stock, etf)).toEqual({
      value: 83,
      source: "ETF",
      threshold: 85,
    });
  });

  it("falls back to Stock PL at threshold 80 when ETF PL is unavailable", () => {
    const stock = new Map([["FINANCE", 79]]);
    const etf = new Map<string, number>();

    expect(selectV8SectorPriceLeadership("KOSPI", "FINANCE", stock, etf)).toEqual({
      value: 79,
      source: "STOCK",
      threshold: 80,
    });
  });

  it("returns no PL when neither source is available", () => {
    expect(
      selectV8SectorPriceLeadership(
        "KOSDAQ",
        "CONSUMER",
        new Map<string, number>(),
        new Map<string, number>(),
      ),
    ).toEqual({ value: null, source: null, threshold: null });
  });
});
