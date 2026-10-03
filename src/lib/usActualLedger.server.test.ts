vi.mock("./ledger/websiteRepository.server", () => ({
  readWebsiteDocument: async (client: SupabaseClient, uid: string, source: string) => {
    const result = await client.from(source).select("revision,payload").eq("user_id", uid).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data;
  },
}));
import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { operateUsActual } from "./usActualLedger.server";
import type { UsExecution } from "./usActualLedger";

function database() {
  const tables: Record<string, Record<string, unknown>[]> = {
    us_actual_portfolio_ledgers: [],
    us_portfolio_trades: [],
    us_a0_entry_signals: [
      { user_id: "owner", date: "2026-01-01", symbol: "ABC", name: "Company ABC" },
    ],
  };
  const writes: string[] = [];
  let conflict = false;
  const client = {
    storage: {
      from: () => ({
        download: async () => ({
          data: new Blob([
            new Uint8Array(
              gzipSync(
                JSON.stringify({
                  analysis: {
                    date: "2026-01-05",
                    rows: [{ date: "2026-01-05", symbol: "ABC", close: 110, a0Exit: true }],
                  },
                }),
              ),
            ),
          ]),
          error: null,
        }),
      }),
    },
    from(name: string) {
      const filters: [string, unknown][] = [];
      let op = "select",
        payload: Record<string, unknown> = {},
        single = false,
        start = 0,
        end = 499;
      const q = {
        select: () => q,
        order: () => q,
        not: () => q,
        range: (a: number, b: number) => {
          start = a;
          end = b;
          return q;
        },
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return q;
        },
        maybeSingle: () => {
          single = true;
          return q;
        },
        insert: (v: Record<string, unknown>) => {
          op = "insert";
          payload = v;
          return q;
        },
        update: (v: Record<string, unknown>) => {
          op = "update";
          payload = v;
          return q;
        },
        then(resolve: (result: unknown) => unknown) {
          let rows = (tables[name] ?? [])
            .filter((r) => filters.every(([k, v]) => r[k] === v))
            .slice(start, end + 1);
          if (op !== "select") writes.push(name);
          if (op === "insert") {
            tables[name]!.push(structuredClone(payload));
            rows = [payload];
          }
          if (op === "update") {
            if (conflict) rows = [];
            else rows.forEach((r) => Object.assign(r, structuredClone(payload)));
          }
          return Promise.resolve(
            resolve({ data: structuredClone(single ? (rows[0] ?? null) : rows), error: null }),
          );
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return {
    client,
    tables,
    writes,
    conflict: () => {
      conflict = true;
    },
  };
}
const event: UsExecution = {
  id: "",
  symbol: "ABC",
  name: "ABC",
  market: "US",
  signalKey: "ABC|2026-01-01",
  side: "BUY",
  date: "2026-01-02",
  price: 100,
  shares: 5,
  fee: 1,
  order: 0,
  note: "",
};
describe("US actual server persistence", () => {
  it("persists actual fills without writing model tables and marks stocks after the model has exited", async () => {
    const db = database();
    const first = await operateUsActual(db.client, "owner", { action: "load" });
    const bought = await operateUsActual(db.client, "owner", {
      action: "execution",
      revision: first.revision,
      execution: event,
    });
    expect(bought.actual.positions[0]).toMatchObject({
      symbol: "ABC",
      shares: 5,
      currentPrice: 110,
      exitSignal: "A0 청산 신호",
    });
    expect(bought.actual.summary.totalPnl).toBe(49);
    const read = await operateUsActual(db.client, "owner", { action: "load" });
    expect(read.document).toEqual(bought.document);
    expect(new Set(db.writes)).toEqual(new Set(["us_actual_portfolio_ledgers"]));
    expect(db.tables["us_portfolio_trades"]).toEqual([]);
  });
  it("rejects stale revisions and racing writes", async () => {
    const db = database(),
      first = await operateUsActual(db.client, "owner", { action: "load" });
    await expect(
      operateUsActual(db.client, "owner", { action: "execution", revision: 0, execution: event }),
    ).rejects.toThrow("다른 화면");
    db.conflict();
    await expect(
      operateUsActual(db.client, "owner", {
        action: "execution",
        revision: first.revision,
        execution: event,
      }),
    ).rejects.toThrow("동시에");
    expect(
      (await operateUsActual(db.client, "owner", { action: "load" })).actual.positions,
    ).toHaveLength(0);
  });
  it("paginates all eligible signals beyond the API row cap", async () => {
    const db = database();
    db.tables["us_a0_entry_signals"] = Array.from({ length: 1001 }, (_, i) => ({
      user_id: "owner",
      date: "2026-01-01",
      symbol: String(i),
      name: String(i),
    }));
    expect((await operateUsActual(db.client, "owner", { action: "load" })).candidates).toHaveLength(
      1001,
    );
  });
});
