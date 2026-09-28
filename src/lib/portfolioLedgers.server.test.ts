import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { operateLedgers } from "./portfolioLedgers.server";
import type { LedgerDocument } from "./portfolioLedgers";

const csv =
  "symbol,date,market,open,high,low,close,volume\nA,2026-01-02,KOSDAQ,100,110,90,105,1000";
vi.mock("./screeningSources.server", () => ({
  listActiveSources: async () => [
    {
      id: "source",
      storage_bucket: "test",
      storage_path: "test",
      max_date: "2026-01-02",
      file_hash: `sha256:${createHash("sha256").update(csv).digest("hex")}`,
    },
  ],
}));

function database() {
  const tables: Record<string, Record<string, unknown>[]> = {
    portfolio_ledgers: [],
    portfolio_settings: [
      { user_id: "owner", initial_capital: 12000000, sector_cap: 0.3, round_trip_cost_rate: 0.003 },
    ],
    portfolio_trades: [
      {
        user_id: "owner",
        id: "positive",
        symbol: "A",
        name: "A",
        market: "KOSDAQ",
        signal_date: "2026-01-01",
        entry_date: "2026-01-02",
        entry_price: 100,
        shares: 10,
        entry_fee: 1,
        status: "OPEN",
      },
      {
        user_id: "owner",
        id: "zero",
        symbol: "B",
        name: "B",
        market: "KOSDAQ",
        signal_date: "2026-01-01",
        shares: 0,
        status: "CLOSED",
      },
    ],
    screening_history: [
      {
        user_id: "owner",
        snapshot: {
          date: "2026-01-01",
          asOfDate: "2026-01-01",
          savedAt: "2026-01-01",
          entries: [
            {
              symbol: "A",
              name: "A",
              instrumentType: "STOCK",
              sectorCode: "S",
              sectorName: "S",
              kosdaq80Onset: true,
              technicalPoints: 8,
              priorityPoints: 5,
            },
          ],
        },
      },
    ],
  };
  let conflict = false;
  const client = {
    storage: { from: () => ({ download: async () => ({ data: new Blob([csv]), error: null }) }) },
    from(name: string) {
      const filters: [string, unknown][] = [];
      let operation = "select",
        payload: Record<string, unknown> = {},
        single = false;
      const query = {
        select: () => query,
        order: () => query,
        range: () => query,
        eq: (key: string, value: unknown) => {
          filters.push([key, value]);
          return query;
        },
        maybeSingle: () => {
          single = true;
          return query;
        },
        insert: (value: Record<string, unknown>) => {
          operation = "insert";
          payload = value;
          return query;
        },
        update: (value: Record<string, unknown>) => {
          operation = "update";
          payload = value;
          return query;
        },
        then(resolve: (result: unknown) => unknown) {
          let rows = (tables[name] ?? []).filter((row) =>
            filters.every(([key, value]) => row[key] === value),
          );
          if (operation === "insert") {
            tables[name]!.push(structuredClone(payload));
            rows = [payload];
          }
          if (operation === "update") {
            if (conflict) rows = [];
            else rows.forEach((row) => Object.assign(row, structuredClone(payload)));
          }
          return Promise.resolve(
            resolve({ data: structuredClone(single ? (rows[0] ?? null) : rows), error: null }),
          );
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return {
    client,
    tables,
    conflict: () => {
      conflict = true;
    },
  };
}

describe("ledger persistence", () => {
  it("reuses the strategy cache after JSONB changes object key order", async () => {
    const db = database();
    const first = await operateLedgers(db.client, "owner", { action: "sync" });
    const stored = db.tables["portfolio_ledgers"]![0]!["payload"] as LedgerDocument;
    stored.settings = {
      sectorCap: stored.settings.sectorCap,
      maxPositions: stored.settings.maxPositions,
      roundTripCostRate: stored.settings.roundTripCostRate,
      initialCapital: stored.settings.initialCapital,
    };
    stored.strategy!.calculatedAt = "cache-marker";
    const second = await operateLedgers(db.client, "owner", { action: "sync" });
    expect(second.revision).toBe(first.revision);
    expect(second.document.strategy!.calculatedAt).toBe("cache-marker");
  });
  it("migrates every positive legacy fill, retains zeros separately, and never changes legacy rows", async () => {
    const db = database(),
      before = JSON.stringify(db.tables["portfolio_trades"]);
    const state = await operateLedgers(db.client, "owner", { action: "load" });
    expect(state.actual.positions[0]).toMatchObject({ symbol: "A", shares: 10, cost: 1001 });
    expect(state.document.excluded).toEqual({ "B|2026-01-01": "기존 미매수 · 0주" });
    expect(state.document.strategy?.trades[0]?.shares).not.toBe(10);
    await operateLedgers(db.client, "owner", { action: "load" });
    expect(db.tables["portfolio_ledgers"]).toHaveLength(1);
    expect(JSON.stringify(db.tables["portfolio_trades"])).toBe(before);
  });
  it("zero-share correction changes only actual book and persists the exclusion", async () => {
    const db = database();
    const state = await operateLedgers(db.client, "owner", { action: "load" });
    const next = await operateLedgers(db.client, "owner", {
      action: "exclude",
      revision: state.revision,
      executionId: "legacy-buy-positive",
      signalKey: "A|2026-01-01",
      note: "독립성 정책",
    });
    expect(next.actual.positions).toHaveLength(0);
    expect(next.document.excluded["A|2026-01-01"]).toBe("독립성 정책");
    expect(next.document.strategy).toEqual(state.document.strategy);
    expect(
      (await operateLedgers(db.client, "owner", { action: "load" })).actual.positions,
    ).toHaveLength(0);
  });
  it("rejects stale revisions, unknown edits, and write conflicts without changing saved trades", async () => {
    const db = database();
    const state = await operateLedgers(db.client, "owner", { action: "load" });
    await expect(
      operateLedgers(db.client, "owner", {
        action: "remove",
        revision: 0,
        executionId: "legacy-buy-positive",
      }),
    ).rejects.toThrow("다른 화면");
    const event = state.document.executions[0]!;
    await expect(
      operateLedgers(db.client, "owner", {
        action: "execution",
        revision: state.revision,
        execution: { ...event, id: "missing" },
      }),
    ).rejects.toThrow("찾지 못");
    db.conflict();
    await expect(
      operateLedgers(db.client, "owner", {
        action: "remove",
        revision: state.revision,
        executionId: event.id,
      }),
    ).rejects.toThrow("동시에");
    expect(
      (await operateLedgers(db.client, "owner", { action: "load" })).actual.positions,
    ).toHaveLength(1);
  });
});
