import { describe, expect, it } from "vitest";
import { summarizeUsDataQuality } from "../src/lib/usDataQuality";
import { usBrowserViews } from "../src/lib/usBrowserViews";
import type { UsProspectiveCache, UsProspectiveCacheRow } from "../src/lib/usProspectiveCloud";
const row = (changes: Partial<UsProspectiveCacheRow> = {}) =>
  ({
    symbol: "TEST",
    date: "2026-10-02",
    open: 10,
    close: 12,
    marketCap: 100,
    sector: "Technology",
    ret120: 0,
    ret252: -0.1,
    coreRank: 0,
    betaRank: 0.9,
    tkRank: null,
    adv20Usd: 1000,
    liquidityRank: 0.3,
    ...changes,
  }) as UsProspectiveCacheRow;
describe("saved US field coverage", () => {
  it("counts real zeros for returns/ranks but not nonpositive prices or absent values", () => {
    const rows = [
      row(),
      row({
        symbol: "OTHER",
        open: 0,
        close: NaN,
        marketCap: null,
        sector: " ",
        ret120: null,
        betaRank: Infinity,
        adv20Usd: -1,
      }),
    ];
    const before = structuredClone(rows);
    const q = summarizeUsDataQuality(rows, "2026-10-02");
    expect(q.coverage.find((f) => f.key === "returns")?.present).toBe(1);
    expect(q.coverage.find((f) => f.key === "coreRank")?.present).toBe(2);
    for (const key of ["open", "close", "marketCap", "sector", "betaRank", "adv20Usd"])
      expect(q.coverage.find((f) => f.key === key)?.present).toBe(1);
    expect(q.coverage.find((f) => f.key === "tkRank")?.present).toBe(0);
    expect(rows).toEqual(before);
  });
  it("reports duplicate/date mismatches instead of claiming raw OHLC validation", () => {
    const q = summarizeUsDataQuality([row(), row({ date: "2026-10-01" })], "2026-10-02");
    expect(q.duplicateSymbols).toBe(1);
    expect(q.dateMismatch).toBe(1);
    expect(q).not.toHaveProperty("ohlcErrors");
  });
  it("keeps compact summary provenance and excludes source rows", () => {
    const source = {
      dataHash: "fixture-hash",
      generatedAt: "2026-10-02",
      source: { provider: "fixture", collectedAt: "2026-10-02", schemaVersion: "1", metadata: {} },
      analysis: {
        date: "2026-10-02",
        ruleVersion: "fixture",
        summary: { rankedRows: 1 },
        rows: [row()],
      },
    } as UsProspectiveCache;
    const summary = usBrowserViews(source).summary;
    expect(summary.quality.rowCount).toBe(1);
    expect(summary.analysis).not.toHaveProperty("rows");
    expect(summary.dataHash).toBe(source.dataHash);
  });
});
