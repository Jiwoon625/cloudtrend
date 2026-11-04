import { it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extendUsActualPriceHistory } from "./usActualPriceHistory.server";
interface FixtureValue {
  dataHash: string;
  analysis: {
    date: string;
    ruleVersion: string;
    rows: Array<{ date: string; symbol: string; close: number | null }>;
  };
}
interface FixtureQuery {
  select(): FixtureQuery;
  eq(): FixtureQuery;
  gte(): FixtureQuery;
  lt(): FixtureQuery;
  order(): FixtureQuery;
  range(): Promise<{
    data: Array<{ date: string; data_hash: string; rule_version: string }>;
    error: null;
  }>;
}
function fixture(change: (value: FixtureValue) => void = () => {}) {
  const record = {
    date: "2026-10-12",
    data_hash: "sha256:" + "b".repeat(64),
    rule_version: "synthetic-rule",
  };
  const value: FixtureValue = {
    dataHash: record.data_hash,
    analysis: {
      date: record.date,
      ruleVersion: record.rule_version,
      rows: [{ date: record.date, symbol: "SYN", close: 10 }],
    },
  };
  change(value);
  const q: FixtureQuery = {
    select: () => q,
    eq: () => q,
    gte: () => q,
    lt: () => q,
    order: () => q,
    range: async () => ({ data: [record], error: null }),
  };
  return {
    from: () => q,
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([JSON.stringify(value)]), error: null }),
      }),
    },
  } as unknown as SupabaseClient;
}
const input = {
  sourceHash: "sha256:" + "a".repeat(64),
  throughDate: "2026-10-13",
  prices: [{ symbol: "SYN", date: "2026-10-13", close: 12 }],
};
it("reconstructs prior dates even when latest US input has only one session", async () => {
  const result = await extendUsActualPriceHistory(
    fixture(),
    "synthetic-owner",
    input,
    new Set(["SYN"]),
  );
  expect(result.dates).toEqual(["2026-10-12", "2026-10-13"]);
  expect(result.prices.map((p) => p.close)).toEqual([10, 12]);
  expect(result.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(result.sourceHash).not.toBe(input.sourceHash);
});
it("rejects altered archive identity and duplicate dated observations", async () => {
  await expect(
    extendUsActualPriceHistory(
      fixture((v) => {
        v.dataHash = "other";
      }),
      "owner",
      input,
      new Set(["SYN"]),
    ),
  ).rejects.toThrow("식별");
  await expect(
    extendUsActualPriceHistory(
      fixture((v) => {
        v.analysis.rows.push(v.analysis.rows[0]!);
      }),
      "owner",
      input,
      new Set(["SYN"]),
    ),
  ).rejects.toThrow("중복");
});
it("retains a missing price as a missing mark rather than using the next day's close", async () => {
  const result = await extendUsActualPriceHistory(
    fixture((v) => {
      v.analysis.rows[0]!.close = null;
    }),
    "owner",
    input,
    new Set(["SYN"]),
  );
  expect(result.dates).toHaveLength(2);
  expect(result.prices).toEqual(input.prices);
});
