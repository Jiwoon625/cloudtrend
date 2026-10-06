import { describe, expect, it } from "vitest";
import {
  CANONICAL_SOURCE_COLUMNS,
  SOURCE_MAX_FILE_BYTES,
  toCanonicalCsv,
  validateSourceBytes,
  type CanonicalSourceRow,
} from "../src/lib/sourceData";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import {
  ScreeningCompactor,
  stableValueHash,
  canonicalRowsHash,
  assertSourceOrderUnambiguous,
} from "../scripts/screening-compaction-core";

const row = (overrides: Partial<CanonicalSourceRow> = {}) =>
  ({
    ...Object.fromEntries(CANONICAL_SOURCE_COLUMNS.map((column) => [column, ""])),
    symbol: "005930",
    name: "삼성전자",
    market: "KOSPI",
    type: "STOCK",
    date: "2026-01-01",
    open: "100",
    high: "101",
    low: "99",
    close: "100",
    volume: "10",
    tradingValue: "1000",
    sector: "SEMICON",
    ...overrides,
  }) as CanonicalSourceRow;
function fixture() {
  return Array.from({ length: 260 }, (_, i) => {
    const date = new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10);
    const close = String(100 + i);
    return [
      row({
        symbol: "KOSPI",
        name: "코스피",
        market: "INDEX",
        type: "INDEX",
        sector: "MARKET_IDX",
        date,
        open: close,
        high: close,
        low: close,
        close,
      }),
      row({
        date,
        open: close,
        high: close,
        low: close,
        close,
        marketCap: "1000000000000",
        foreignNetBuyValue: "50000",
        shortSellingVolumeRate: "0",
        lendingBalanceQuantity: "123",
        foreignHoldingQuantity: "44",
      }),
    ];
  }).flat();
}
describe("screening source compaction", () => {
  it("preserves all 103 canonical columns and nullable enrichment across overlap", () => {
    expect(CANONICAL_SOURCE_COLUMNS).toHaveLength(103);
    const c = new ScreeningCompactor();
    c.addCanonicalCsv(
      toCanonicalCsv([
        row({
          shortSellingVolumeRate: "4",
          lendingBalanceQuantity: "100",
          foreignHoldingQuantity: "42",
        }),
      ]),
    );
    c.addCanonicalCsv(
      toCanonicalCsv([
        row({
          shortSellingVolumeRate: "",
          lendingBalanceQuantity: "0",
          foreignHoldingQuantity: "",
        }),
      ]),
    );
    const text = [...c.chunks()][0]!.text;
    expect(text).toContain("42");
    expect(c.rowCount).toBe(1);
    expect(c.duplicateRows).toBe(1);
    expect(c.effectiveRowsHash()).toBe(canonicalRowsHash([text]));
  });
  it("matches actual parser and full analysis with first-seen metadata and partial later updates", () => {
    const original = toCanonicalCsv(fixture());
    const correction = toCanonicalCsv([
      row({
        name: "CHANGED",
        sector: "OTHER",
        date: "2025-01-01",
        shortSellingVolumeRate: "NaN",
        lendingBalanceQuantity: "0",
      }),
    ]);
    const c = new ScreeningCompactor();
    c.addCanonicalCsv(original);
    c.addCanonicalCsv(correction);
    const chunks = [...c.chunks(12_000)].map((x) => x.text);
    expect(chunks.length).toBeGreaterThan(1);
    const before = parseManualMarketData([original, correction]).dataset;
    const after = parseManualMarketData(chunks).dataset;
    expect(stableValueHash(after)).toBe(stableValueHash(before));
    expect(after.instruments[0]!.name).toBe("삼성전자");
    const first = after.bars["005930"]![0]!;
    expect(first.shortSellingVolumeRate).toBe(0);
    expect(first.lendingBalanceQuantity).toBe(0);
    const a = runFullMarketAnalysis(before).analysis,
      b = runFullMarketAnalysis(after).analysis;
    expect(stableValueHash({ ...a, calculatedAt: "" })).toBe(
      stableValueHash({ ...b, calculatedAt: "" }),
    );
  });
  it("keeps exact byte limits including UTF-8, quoted commas and multiline data", async () => {
    const c = new ScreeningCompactor();
    c.addCanonicalCsv(
      toCanonicalCsv(
        Array.from({ length: 8 }, (_, i) =>
          row({ date: `2026-01-0${i + 1}`, name: '한글,"이름"\n둘째 줄' }),
        ),
      ),
    );
    const chunks = [...c.chunks(2600)];
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      const part = chunks[i]!;
      expect(part.bytes).toBe(Buffer.byteLength(part.text));
      expect(part.bytes).toBeLessThanOrEqual(2600);
      expect(
        (
          await validateSourceBytes({
            bytes: Buffer.from(part.text),
            filename: `part${i}.csv`,
            streamingCsv: true,
          })
        ).valid,
      ).toBe(true);
    }
    expect(chunks.reduce((sum, c) => sum + c.rowCount, 0)).toBe(8);
    expect(canonicalRowsHash(chunks.map((x) => x.text))).toBe(c.effectiveRowsHash());
  });
  it("rejects missing columns, ragged rows, unsafe limits and ambiguous source ordering", () => {
    expect(() =>
      new ScreeningCompactor().addCanonicalCsv("symbol,date,close\n005930,2026-01-01,1\n"),
    ).toThrow();
    expect(() =>
      new ScreeningCompactor().addCanonicalCsv(
        CANONICAL_SOURCE_COLUMNS.join(",") + "\n005930,2026-01-01,1\n",
      ),
    ).toThrow();
    const c = new ScreeningCompactor();
    c.addCanonicalCsv(toCanonicalCsv([row()]));
    expect(() => [...c.chunks(SOURCE_MAX_FILE_BYTES + 1)]).toThrow();
    expect(() => [...c.chunks(1)]).toThrow();
    expect(() =>
      assertSourceOrderUnambiguous([
        { activated_at: "x", created_at: "y" },
        { activated_at: "x", created_at: "y" },
      ]),
    ).toThrow();
  });
  it("stable hash ignores object insertion order but preserves array order and zero", () => {
    expect(stableValueHash({ a: 1, b: 0 })).toBe(stableValueHash({ b: 0, a: 1 }));
    expect(stableValueHash([0, null])).not.toBe(stableValueHash([null, 0]));
  });
});
