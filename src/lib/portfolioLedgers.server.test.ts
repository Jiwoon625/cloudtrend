vi.mock("./ledger/websiteRepository.server", () => ({
  readWebsiteDocument: async (client: SupabaseClient, uid: string, source: string) => {
    const result = await client.from(source).select("revision,payload").eq("user_id", uid).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data;
  },
}));
import { kospiEntryGates, kospiGateDataset } from "../../tests/kospi-policy-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { operateLedgers } from "./portfolioLedgers.server";
import { KOSPI_ENTRY_POLICY } from "./engine/kospiEntryConfirmation";
import { OPERATIONAL_SIGNAL_VERSION } from "./engine/operationalStrategy";
import type { LedgerDocument } from "./portfolioLedgers";

vi.mock("./dashboardOperations.server", () => ({
  portfolioEtfContext: async () => ({
    rows: [
      {
        symbol: "490590",
        name: "ETF",
        market: "ETF",
        date: "2026-01-02",
        price: 110,
        exitReason: "MA60",
        onset: false,
      },
    ],
    trackedSymbols: ["490590"],
    date: "2026-01-02",
  }),
}));

let csv = "symbol,date,market,open,high,low,close,volume\nA,2026-01-02,KOSDAQ,100,110,90,105,1000";
vi.mock("./screeningSources.server", () => ({
  listActiveSources: async () => [
    {
      id: "source",
      storage_bucket: "test",
      storage_path: "test",
      max_date: "9999-12-31",
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
  it("keeps ETF capital, positions, and PnL separate from Korean stocks", async () => {
    const db = database();
    const first = await operateLedgers(db.client, "owner", { action: "load" });
    const buy = {
      id: "",
      symbol: "490590",
      name: "ETF",
      market: "ETF" as const,
      signalKey: null,
      side: "BUY" as const,
      date: "2026-01-02",
      price: 100,
      shares: 10,
      fee: 2,
      note: "실제 ETF 체결",
    };
    const bought = await operateLedgers(db.client, "owner", {
      action: "execution",
      revision: first.revision,
      execution: buy,
    });
    expect(bought.actual).toEqual(first.actual);
    expect(bought.document.strategy).toEqual(first.document.strategy);
    expect(bought.etfActual!.positions[0]).toMatchObject({
      symbol: "490590",
      shares: 10,
      cost: 1002,
      marketValue: 1100,
      unrealizedPnl: 98,
      exitSignal: "MA60",
    });
    const funded = await operateLedgers(db.client, "owner", {
      action: "capital",
      revision: bought.revision,
      etfCapital: 5000,
    });
    expect(funded.document.actualCapital).toBe(first.document.actualCapital);
    expect(funded.document.settings).toEqual(first.document.settings);
    expect(funded.etfActual!.summary.cash).toBe(3998);
    const sold = await operateLedgers(db.client, "owner", {
      action: "execution",
      revision: funded.revision,
      execution: { ...buy, side: "SELL", price: 120, shares: 4, fee: 1 },
    });
    expect(sold.etfActual!.summary.realizedPnl).toBe(78.2);
    expect(sold.etfActual!.positions[0]!.shares).toBe(6);
    expect(sold.actual).toEqual(first.actual);
    const reloaded = await operateLedgers(db.client, "owner", { action: "load" });
    expect(reloaded.etfActual).toEqual(sold.etfActual);
    expect(reloaded.etfTrackedSymbols).toEqual(["490590"]);
    await expect(
      operateLedgers(db.client, "owner", {
        action: "execution",
        revision: sold.revision,
        execution: { ...buy, side: "SELL", shares: 7 },
      }),
    ).rejects.toThrow("초과");
  });
  it("preserves all original migration and user notes during a read", async () => {
    const db = database();
    await operateLedgers(db.client, "owner", { action: "load" });
    const stored = db.tables["portfolio_ledgers"]![0]!["payload"] as LedgerDocument;
    stored.executions[0]!.note = "기존 0주 초과 기록 이관 · 기존 비용 유지";
    const cleaned = await operateLedgers(db.client, "owner", { action: "load" });
    expect(cleaned.document.executions[0]!.note).toBe("기존 0주 초과 기록 이관 · 기존 비용 유지");
    const saved = db.tables["portfolio_ledgers"]![0]!["payload"] as LedgerDocument;
    saved.executions[0]!.note = "사용자 메모 · 이관 내용 확인";
    expect(
      (await operateLedgers(db.client, "owner", { action: "load" })).document.executions[0]!.note,
    ).toBe("사용자 메모 · 이관 내용 확인");
  });
});

const confirmedSnapshot = () => ({
  date: "2026-10-02",
  asOfDate: "2026-10-02",
  savedAt: "2026-10-02T09:00:00Z",
  entries: [
    {
      symbol: "C",
      name: "C",
      instrumentType: "STOCK",
      sectorCode: "S",
      sectorName: "S",
      kospi80Onset: false,
      technicalPoints: 8.5,
      priorityPoints: 5,
      operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
      kospiEntry: {
        version: KOSPI_ENTRY_POLICY.version,
        marketGate: kospiEntryGates(),
        date: "2026-10-02",
        originDate: "2026-10-01",
        confirmationDate: "2026-10-02",
        state: "confirmed",
        issues: [],
        rsAccel: 1,
        score: 8.5,
        originScore: 8,
        eligible: true,
      },
    },
  ],
});
const confirmationCsv = (middle: string) =>
  [
    "symbol,date,market,open,high,low,close,volume,foreignnetbuyvalue",
    ...kospiGateDataset([
      "2026-10-01",
      "2026-10-02",
      "2026-10-06",
      "2026-10-07",
    ]).indexSeries[0]!.bars.map(
      (b) => `KOSPI,${b.tradeDate},INDEX,${b.open},${b.high},${b.low},${b.close},${b.volume},10`,
    ),
    "A,2026-01-02,KOSDAQ,100,110,90,105,1000",
    "C,2026-10-01,KOSPI,100,110,90,105,1000",
    "C,2026-10-02,KOSPI,100,110,90,105,1000",
    middle,
    "C,2026-10-07,KOSPI,110,120,100,115,1000",
  ]
    .filter(Boolean)
    .join("\n");

describe("confirmation source and persistence integration", () => {
  it("loads confirmed symbols without raw onset and preserves actual executions across same-day syncs", async () => {
    const previousCsv = csv;
    try {
      csv = confirmationCsv("C,2026-10-06,KOSPI,0,0,0,0,0");
      const db = database();
      const first = await operateLedgers(db.client, "owner", { action: "load" });
      const originalExecutions = structuredClone(first.document.executions);
      db.tables["screening_history"]!.push({ user_id: "owner", snapshot: confirmedSnapshot() });
      const confirmed = await operateLedgers(db.client, "owner", { action: "sync" });
      expect(
        confirmed.document.strategy?.trades.find((trade) => trade.symbol === "C"),
      ).toMatchObject({ entryDate: "2026-10-07", entryPrice: 110 });
      expect(confirmed.document.executions).toEqual(originalExecutions);
      const rerun = await operateLedgers(db.client, "owner", { action: "sync" });
      expect(rerun.revision).toBe(confirmed.revision);
      expect(rerun.document.strategy?.trades).toEqual(confirmed.document.strategy?.trades);
      expect(rerun.document.executions).toEqual(originalExecutions);
    } finally {
      csv = previousCsv;
    }
  });
  it("uses observed sessions despite a partial benchmark to block a late fill after an absent symbol bar", async () => {
    const previousCsv = csv;
    try {
      csv = confirmationCsv("").replace(
        /^KOSPI,2026-10-06,.*$/m,
        "D,2026-10-06,KOSPI,100,110,90,105,1000",
      );
      const db = database();
      db.tables["screening_history"]!.push({ user_id: "owner", snapshot: confirmedSnapshot() });
      const model = (await operateLedgers(db.client, "owner", { action: "sync" })).document
        .strategy!;
      expect(model.trades.some((trade) => trade.symbol === "C")).toBe(false);
      expect(model.candidates.find((candidate) => candidate.symbol === "C")?.decision).toContain(
        "2026-10-06 자료 누락",
      );
    } finally {
      csv = previousCsv;
    }
  });
  it("does not turn KOSDAQ zero-price source rows into fills or actual quotes", async () => {
    const previousCsv = csv;
    try {
      csv = [
        "symbol,date,market,open,high,low,close,volume",
        "A,2026-01-02,KOSDAQ,0,0,0,0,0",
        "A,2026-01-03,KOSDAQ,100,110,90,105,0",
        "A,2026-01-04,KOSDAQ,0,0,0,0,0",
      ].join("\n");
      const db = database();
      const state = await operateLedgers(db.client, "owner", { action: "sync" });
      expect(state.document.strategy?.trades[0]?.entryDate).toBe("2026-01-03");
      expect(state.document.strategy?.quotes["A"]).toMatchObject({
        price: 105,
        date: "2026-01-03",
      });
      expect(state.actual.positions[0]).toMatchObject({
        currentPrice: 105,
        markDate: "2026-01-03",
      });
    } finally {
      csv = previousCsv;
    }
  });
});
