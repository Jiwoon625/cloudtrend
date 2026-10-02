import { kospiEntryGates, kospiGateDataset } from "../../tests/kospi-policy-fixtures";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPortfolioStore } from "./portfolioStoreCore";
import { KOSPI_ENTRY_POLICY, type KospiEntrySnapshot } from "./engine/kospiEntryConfirmation";
import {
  LEGACY_OPERATIONAL_SIGNAL_VERSION,
  OPERATIONAL_SIGNAL_VERSION,
} from "./engine/operationalStrategy";
import { type MarketDataset } from "./engine/dataset";
import type { DailyPrice, Instrument } from "./engine/types";
import type { ScreeningSnapshot, SnapshotEntry } from "./screeningSnapshot";

const dates = ["2026-10-01", "2026-10-02", "2026-10-06", "2026-10-07"];
function entry(changes: Partial<KospiEntrySnapshot> = {}): SnapshotEntry {
  return {
    symbol: "A",
    name: "A",
    instrumentType: "STOCK",
    sectorCode: "S",
    sectorName: "S",
    grade: "A",
    status: "",
    totalScore: 85,
    technicalPoints: 8.5,
    priorityPoints: 5,
    scoreDelta1d: 0,
    hardFilterPassed: true,
    kospi80Onset: false,
    operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
    kospiEntry: {
      version: KOSPI_ENTRY_POLICY.version,
      marketGate: kospiEntryGates(),
      date: dates[1]!,
      originDate: dates[0]!,
      confirmationDate: dates[1]!,
      state: "confirmed",
      issues: [],
      rsAccel: 1,
      score: 8.5,
      originScore: 8,
      eligible: true,
      ...changes,
    },
  };
}
function snapshot(e = entry(), date = dates[1]!): ScreeningSnapshot {
  return {
    date,
    asOfDate: date,
    savedAt: `${date}T09:00:00Z`,
    entries: [e],
    marketGateStatus: "",
    totalCount: 1,
    passedCount: 1,
    gradeACount: 1,
    gradeBCount: 0,
  };
}
function dataset(): MarketDataset {
  return {
    provider: "test",
    version: "test",
    asOfDate: dates.at(-1)!,
    isLive: false,
    notes: [],
    sectors: [],
    instruments: [{ symbol: "A", market: "KOSPI", instrumentType: "STOCK" } as Instrument],
    bars: {
      A: dates.map(
        (tradeDate) => ({ tradeDate, open: 100, close: 110, volume: 1000 }) as DailyPrice,
      ),
    },
    financials: {},
    etfFacts: {},
    vkospiSeries: [],
    ...kospiGateDataset(dates),
  };
}
function database(initialTrades: Record<string, unknown>[] = []) {
  const tables: Record<string, Record<string, unknown>[]> = {
    portfolio_settings: [
      {
        user_id: "owner",
        initial_capital: 30000,
        max_positions: 30,
        sector_cap: 0.3,
        round_trip_cost_rate: 0,
      },
    ],
    portfolio_trades: structuredClone(initialTrades),
    portfolio_signal_log: [],
  };
  const client = {
    from(name: string) {
      const filters: [string, unknown][] = [];
      let operation = "select",
        payload: Record<string, unknown> = {},
        single = false;
      const query = {
        select: () => query,
        order: () => query,
        eq: (key: string, value: unknown) => {
          filters.push([key, value]);
          return query;
        },
        maybeSingle: () => {
          single = true;
          return query;
        },
        single: () => {
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
        upsert: (value: Record<string, unknown>) => {
          operation = "upsert";
          payload = value;
          return query;
        },
        then(resolve: (result: unknown) => unknown) {
          let rows = tables[name]!.filter((row) =>
            filters.every(([key, value]) => row[key] === value),
          );
          if (operation === "insert") {
            const row = {
              id: `trade-${tables[name]!.length}`,
              exit_date: null,
              exit_fee: 0,
              ...structuredClone(payload),
            };
            tables[name]!.push(row);
            rows = [row];
          }
          if (operation === "update")
            rows.forEach((row) => Object.assign(row, structuredClone(payload)));
          if (operation === "upsert") {
            const old = tables[name]!.find(
              (row) =>
                row["symbol"] === payload["symbol"] &&
                row["signal_date"] === payload["signal_date"],
            );
            if (old) Object.assign(old, structuredClone(payload));
            else tables[name]!.push(structuredClone(payload));
            rows = [payload];
          }
          return Promise.resolve(
            resolve({ data: structuredClone(single ? (rows[0] ?? null) : rows), error: null }),
          );
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, tables };
}
function setup(
  snapshots = [snapshot()],
  ds = dataset(),
  initialTrades: Record<string, unknown>[] = [],
) {
  const db = database(initialTrades);
  return {
    ...db,
    store: createPortfolioStore({
      supabase: db.client,
      userId: async () => "owner",
      ensureManualDataset: async () => ({ dataset: ds }),
      loadSnapshots: () => snapshots,
    }),
  };
}

describe("legacy explicit portfolio sync confirmation gate", () => {
  it.each(["pending", "rejected", "unobservable"] as const)(
    "never inserts %s into stored trades",
    async (state) => {
      const { store, tables } = setup([snapshot(entry({ state, eligible: false }))]);
      expect((await store.syncPortfolioFromHistory()).trades).toHaveLength(0);
      expect(tables["portfolio_trades"]).toHaveLength(0);
    },
  );
  it("fills the first observed tradable open after confirmation and remains idempotent on rerun", async () => {
    const ds = dataset();
    ds.bars["A"]![2] = { ...ds.bars["A"]![2]!, open: 0, volume: 0 };
    const { store, tables } = setup([snapshot()], ds);
    const first = await store.syncPortfolioFromHistory();
    expect(first.trades[0]).toMatchObject({
      entryDate: "2026-10-07",
      signalDate: "2026-10-02",
      entryPrice: 100,
    });
    await store.syncPortfolioFromHistory();
    expect(tables["portfolio_trades"]).toHaveLength(1);
    expect(tables["portfolio_signal_log"]).toHaveLength(1);
  });
  it("does not insert a delayed fill through a missing market session", async () => {
    const ds = dataset();
    ds.bars["A"]!.splice(2, 1);
    // A partially loaded benchmark must not hide a session observed in dataset.tradeDates.
    ds.indexSeries = [{ indexCode: "KOSPI", indexName: "KOSPI", bars: ds.bars["A"]!.slice(0, 2) }];
    const { store } = setup([snapshot()], ds);
    expect((await store.syncPortfolioFromHistory()).trades).toHaveLength(0);
  });
  it("does not backfill historical new confirmations or raw legacy onsets", async () => {
    const old = {
      ...entry(),
      kospiEntry: undefined,
      kospi80Onset: true,
      operationalSignalVersion: LEGACY_OPERATIONAL_SIGNAL_VERSION,
    };
    for (const s of [
      snapshot(old),
      snapshot(
        entry({ date: "2026-10-01", confirmationDate: "2026-10-01", originDate: "2026-09-30" }),
        "2026-10-01",
      ),
    ]) {
      const { store } = setup([s]);
      expect((await store.syncPortfolioFromHistory()).trades).toHaveLength(0);
    }
  });
  it.each(["2026-10-01", "2026-10-06"])(
    "keeps stored executions and excludes an origin whose prior holding sold on %s",
    async (exitDate) => {
      const old = {
        id: "kept",
        user_id: "owner",
        symbol: "A",
        name: "A",
        market: "KOSPI",
        sector_code: "S",
        sector_name: "S",
        signal_date: "2026-09-28",
        entry_date: "2026-09-29",
        entry_price: 99,
        shares: 10,
        buy_amount: 990,
        entry_fee: 0,
        exit_date: exitDate,
        exit_price: 110,
        exit_fee: 0,
        exit_reason: "9.5점 상향돌파",
        status: "CLOSED",
        realized_pnl: 110,
      };
      const { store, tables } = setup([snapshot()], dataset(), [old]);
      const state = await store.syncPortfolioFromHistory();
      expect(state.trades).toHaveLength(1);
      expect(tables["portfolio_trades"]![0]).toEqual(old);
      expect(tables["portfolio_signal_log"]![0]?.["decision"]).toBe("SKIPPED_HELD");
    },
  );
  it("keeps KOSDAQ raw-onset execution unchanged", async () => {
    const ds = dataset();
    ds.instruments[0]!.market = "KOSDAQ";
    ds.bars["A"]![2]!.volume = 0;
    const e = { ...entry(), kospiEntry: undefined, kosdaq80Onset: true };
    const { store } = setup([snapshot(e)], ds);
    expect((await store.syncPortfolioFromHistory()).trades[0]?.entryDate).toBe("2026-10-06");
  });
});
