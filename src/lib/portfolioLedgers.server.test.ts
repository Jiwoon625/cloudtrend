vi.mock("./ledger/websiteRepository.server", () => ({
  readWebsiteDocument: async (client: SupabaseClient, uid: string, source: string) => {
    const result = await client
      .from(source)
      .select("revision,payload")
      .eq("user_id", uid)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data;
  },
}));
import { kospiEntryGates, kospiGateDataset } from "../../tests/kospi-policy-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { operateLedgers, refreshPortfolioAfterScreening } from "./portfolioLedgers.server";
import { KOSPI_ENTRY_POLICY } from "./engine/kospiEntryConfirmation";
import { OPERATIONAL_SIGNAL_VERSION } from "./engine/operationalStrategy";
import { simulateStrategy, type LedgerDocument } from "./portfolioLedgers";
import { serializeScreeningSnapshot } from "./screeningSnapshotStorage";
import { largeScreeningSnapshot } from "../../tests/screening-snapshot-storage-fixture";

vi.mock("./portfolioLedgers", async (original) => {
  const actual = await original<typeof import("./portfolioLedgers")>();
  return { ...actual, simulateStrategy: vi.fn(actual.simulateStrategy) };
});
beforeEach(() => {
  vi.mocked(simulateStrategy).mockClear();
});
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
  let beforeUpdate: (() => void) | null = null;
  const download = vi.fn(async () => ({ data: new Blob([csv]), error: null }));
  const client = {
    storage: { from: () => ({ download }) },
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
          if (operation === "update" && beforeUpdate) {
            const run = beforeUpdate;
            beforeUpdate = null;
            run();
          }
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
    download,
    beforeUpdate: (callback: () => void) => {
      beforeUpdate = callback;
    },
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
  it("retains historic sources independently of editor metadata and rejects newly pasted Notion URLs", async () => {
    const db = database();
    await operateLedgers(db.client, "owner", { action: "load" });
    const stored = db.tables["portfolio_ledgers"]![0]!["payload"] as LedgerDocument;
    const url = "https://notion.so/synthetic-kr-source";
    stored.executions[0]!.note = `한글 원본\n${url}`;
    const loaded = await operateLedgers(db.client, "owner", { action: "load" });
    const original = structuredClone(loaded.document.executions[0]!);
    expect(original.note).toContain(url);
    const edited = await operateLedgers(db.client, "owner", {
      action: "execution",
      revision: loaded.revision,
      execution: { ...original, note: "메모만 정정" },
    });
    expect(edited.document.executions[0]).toEqual({
      ...original,
      note: "메모만 정정",
      sourceLinks: [{ system: "notion", url }],
    });
    const before = structuredClone(db.tables);
    await expect(
      operateLedgers(db.client, "owner", {
        action: "execution",
        revision: edited.revision,
        execution: { ...original, note: url },
      }),
    ).rejects.toThrow("Notion URL");
    expect(db.tables).toEqual(before);
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

describe("screening portfolio freshness", () => {
  it("hydrates compact stored history before replay and retains the unchanged-input cache", async () => {
    const db = database();
    const snapshot = largeScreeningSnapshot();
    db.tables["screening_history"] = [
      { user_id: "owner", snapshot: serializeScreeningSnapshot(snapshot) },
    ];
    const first = await operateLedgers(db.client, "owner", { action: "load" });
    const replayInput = vi.mocked(simulateStrategy).mock.calls.at(-1)![1];
    expect(replayInput[0]).toEqual(snapshot);
    expect(replayInput[0]?.entries[614]?.pendingRules).toEqual(snapshot.entries[614]!.pendingRules);
    db.download.mockClear();
    vi.mocked(simulateStrategy).mockClear();
    const again = await operateLedgers(db.client, "owner", { action: "load" });
    expect(again.document.strategy?.fingerprint).toBe(first.document.strategy?.fingerprint);
    expect(again.strategyRefresh.status).toBe("REUSED");
    expect(simulateStrategy).not.toHaveBeenCalled();
    expect(db.download).not.toHaveBeenCalled();
  });
  it("same-date cap completion invalidates pending cached replay once without changing actual trades", async () => {
    const previous = csv;
    csv =
      "symbol,date,market,open,high,low,close,volume,marketCap\nA,2026-01-02,KOSDAQ,100,110,90,105,1000,";
    try {
      const db = database();
      const snapshot = db.tables["screening_history"]![0]!["snapshot"] as {
        entries: Array<Record<string, unknown>>;
      };
      Object.assign(snapshot.entries[0]!, {
        hardFilterPassed: false,
        hardFilterStatus: "PENDING",
        pendingRules: ["시가총액 자료 대기"],
      });
      const first = await operateLedgers(db.client, "owner", { action: "load" });
      expect(first.document.strategy?.trades).toEqual([]);
      csv += "1000000000000";
      Object.assign(snapshot.entries[0]!, {
        hardFilterPassed: true,
        hardFilterStatus: "PASS",
        pendingRules: [],
      });
      db.download.mockClear();
      vi.mocked(simulateStrategy).mockClear();
      const completed = await operateLedgers(db.client, "owner", { action: "load" });
      expect(completed.document.strategy?.fingerprint).not.toBe(
        first.document.strategy?.fingerprint,
      );
      expect(completed.document.strategy?.trades).toHaveLength(1);
      expect(completed.document.executions).toEqual(first.document.executions);
      expect(completed.strategyRefresh.status).toBe("UPDATED");
      for (const action of ["load", "sync", "load"] as const)
        expect((await operateLedgers(db.client, "owner", { action })).strategyRefresh.status).toBe(
          "REUSED",
        );
      expect(db.download).toHaveBeenCalledTimes(1);
      expect(simulateStrategy).toHaveBeenCalledTimes(1);
    } finally {
      csv = previous;
    }
  });
  it("repeated reads and unchanged sync perform zero raw downloads and simulations", async () => {
    const db = database();
    const first = await operateLedgers(db.client, "owner", { action: "load" });
    db.download.mockClear();
    vi.mocked(simulateStrategy).mockClear();
    for (const action of ["load", "load", "sync", "load"] as const) {
      const next = await operateLedgers(db.client, "owner", { action });
      expect(next.revision).toBe(first.revision);
      expect(next.strategyRefresh.status).toBe("REUSED");
    }
    expect(db.download).not.toHaveBeenCalled();
    expect(simulateStrategy).not.toHaveBeenCalled();
  });
  it("ignores savedAt and JSONB key order, but refreshes changed screening content", async () => {
    const db = database();
    const first = await operateLedgers(db.client, "owner", { action: "load" });
    const snapshot = db.tables["screening_history"]![0]!["snapshot"] as {
      savedAt: string;
      entries: Array<{ technicalPoints: number }>;
    };
    snapshot.savedAt = "2026-10-07T00:00:00Z";
    db.tables["screening_history"]![0]!["snapshot"] = Object.fromEntries(
      Object.entries(snapshot).reverse(),
    );
    db.download.mockClear();
    vi.mocked(simulateStrategy).mockClear();
    expect((await refreshPortfolioAfterScreening(db.client, "owner")).status).toBe("REUSED");
    expect(db.download).not.toHaveBeenCalled();
    expect(simulateStrategy).not.toHaveBeenCalled();
    snapshot.entries[0]!.technicalPoints = 9;
    const next = await operateLedgers(db.client, "owner", { action: "load" });
    expect(next.revision).toBe(first.revision + 1);
    expect(next.strategyRefresh.status).toBe("UPDATED");
    expect(db.download).toHaveBeenCalledTimes(1);
    expect(simulateStrategy).toHaveBeenCalledTimes(1);
    expect(next.document.executions).toEqual(first.document.executions);
  });
  it("actual buy edits revalue the actual book without replaying the model or generating fills", async () => {
    const db = database();
    const first = await operateLedgers(db.client, "owner", { action: "load" });
    db.download.mockClear();
    vi.mocked(simulateStrategy).mockClear();
    const execution = first.document.executions[0]!;
    const next = await operateLedgers(db.client, "owner", {
      action: "execution",
      revision: first.revision,
      execution: { ...execution, shares: 12, note: "verified fill" },
    });
    expect(next.actual.positions[0]!.shares).toBe(12);
    expect(next.document.executions).toHaveLength(first.document.executions.length);
    expect(next.document.strategy).toEqual(first.document.strategy);
    expect(db.download).not.toHaveBeenCalled();
    expect(simulateStrategy).not.toHaveBeenCalled();
    await operateLedgers(db.client, "owner", {
      action: "capital",
      revision: next.revision,
      actualCapital: 13000000,
    });
    expect(simulateStrategy).not.toHaveBeenCalled();
    const current = await operateLedgers(db.client, "owner", { action: "load" });
    await operateLedgers(db.client, "owner", {
      action: "capital",
      revision: current.revision,
      strategyCapital: 15000000,
    });
    expect(simulateStrategy).toHaveBeenCalledTimes(1);
  });
  it("coalesces concurrent identical refresh work and retains the winning revision", async () => {
    const db = database();
    await operateLedgers(db.client, "owner", { action: "load" });
    (db.tables["portfolio_ledgers"]![0]!["payload"] as LedgerDocument).strategy = null;
    db.download.mockClear();
    vi.mocked(simulateStrategy).mockClear();
    const results = await Promise.all([
      operateLedgers(db.client, "owner", { action: "sync" }),
      operateLedgers(db.client, "owner", { action: "load" }),
    ]);
    expect(results[0]!.revision).toBe(results[1]!.revision);
    expect(db.download).toHaveBeenCalledTimes(1);
    expect(simulateStrategy).toHaveBeenCalledTimes(1);
  });
  it("a refresh racing a real buy re-reads canonical state rather than overwriting it", async () => {
    const db = database();
    const first = await operateLedgers(db.client, "owner", { action: "load" });
    (db.tables["portfolio_ledgers"]![0]!["payload"] as LedgerDocument).strategy = null;
    db.beforeUpdate(() => {
      const row = db.tables["portfolio_ledgers"]![0]!;
      const doc = row["payload"] as LedgerDocument;
      doc.executions[0]!.shares = 17;
      row["revision"] = Number(row["revision"]) + 1;
    });
    const next = await operateLedgers(db.client, "owner", { action: "sync" });
    expect(next.actual.positions[0]!.shares).toBe(17);
    expect(next.revision).toBe(first.revision + 2);
    expect(next.document.executions).toHaveLength(first.document.executions.length);
  });
  it("reuses exact already-verified source text from a successful screening", async () => {
    const db = database();
    await operateLedgers(db.client, "owner", { action: "load" });
    (db.tables["portfolio_ledgers"]![0]!["payload"] as LedgerDocument).strategy = null;
    db.download.mockClear();
    const { listActiveSources } = await import("./screeningSources.server");
    const sources = await listActiveSources(db.client, "owner");
    const summary = await refreshPortfolioAfterScreening(db.client, "owner", {
      sources,
      texts: [csv],
    });
    expect(db.download).not.toHaveBeenCalled();
    expect(summary.status).toBe("UPDATED");
    expect(Object.keys(summary).sort()).toEqual(["asOfDate", "calculatedAt", "status"]);
  });
});

it("background screening never initializes an absent real ledger or imports legacy trades", async () => {
  const db = database();
  const before = structuredClone(db.tables);
  const from = vi.spyOn(db.client, "from");
  expect(await refreshPortfolioAfterScreening(db.client, "owner")).toEqual({
    status: "NOT_INITIALIZED",
    asOfDate: null,
    calculatedAt: null,
  });
  expect(db.tables).toEqual(before);
  expect(from.mock.calls.map(([name]) => name)).toEqual(["portfolio_ledgers"]);
  expect(db.download).not.toHaveBeenCalled();
});
it("rejects a changed active source set instead of relabelling preloaded old texts", async () => {
  const db = database();
  await operateLedgers(db.client, "owner", { action: "load" });
  const before = structuredClone(db.tables["portfolio_ledgers"]);
  db.download.mockClear();
  vi.mocked(simulateStrategy).mockClear();
  const { listActiveSources } = await import("./screeningSources.server");
  const sources = await listActiveSources(db.client, "owner");
  await expect(
    refreshPortfolioAfterScreening(db.client, "owner", {
      sources: sources.map((s) => ({ ...s, file_hash: "old-hash" })),
      texts: [csv],
    }),
  ).rejects.toThrow("활성 원천데이터가 변경");
  expect(db.tables["portfolio_ledgers"]).toEqual(before);
  expect(db.download).not.toHaveBeenCalled();
  expect(simulateStrategy).not.toHaveBeenCalled();
});

it("canonical text cannot masquerade as raw input and falls back to verified Storage bytes", async () => {
  const previous = csv;
  csv = [
    "symbol,name,securityType,market,sector,date,open,high,low,close,volume,tradingValue,foreignNetBuyValue",
    "005930,검증 종목,STOCK,KOSDAQ,SEMI,2026-01-02,100,110,90,105,0,0,0",
    "005930,검증 종목,STOCK,KOSDAQ,SEMI,2026-01-05,105,115,100,110,0,0,",
    "005930,검증 종목,STOCK,KOSDAQ,SEMI,2026-01-06,,120,100,115,100,0,",
    "KOSPI,코스피,INDEX,INDEX,,2026-01-02,2000,2100,1900,2050,0,0,0",
    "KOSDAQ,코스닥,INDEX,INDEX,,2026-01-02,600,650,550,610,0,0,",
  ].join("\n");
  try {
    const { validateSourceText } = await import("./sourceData");
    const canonical = await validateSourceText(csv, "synthetic-raw.csv");
    expect(canonical.errors).toEqual([]);
    expect(canonical.valid).toBe(true);
    expect(canonical.canonicalCsv).not.toBe(csv);
    expect(canonical.canonicalCsv.split("\n")[0]).toContain("type");
    const db = database();
    db.tables["portfolio_trades"]![0]!["symbol"] = "005930";
    const snapshot = db.tables["screening_history"]![0]!["snapshot"] as {
      entries: Array<{ symbol: string }>;
    };
    snapshot.entries[0]!.symbol = "005930";
    const raw = await operateLedgers(db.client, "owner", { action: "load" });
    (db.tables["portfolio_ledgers"]![0]!["payload"] as LedgerDocument).strategy = null;
    const { listActiveSources } = await import("./screeningSources.server");
    const sources = await listActiveSources(db.client, "owner");
    db.download.mockClear();
    const reused = await operateLedgers(
      db.client,
      "owner",
      { action: "sync" },
      { sources, texts: [canonical.canonicalCsv] },
    );
    expect(db.download).toHaveBeenCalledTimes(1);
    expect({ ...reused.document.strategy, calculatedAt: null }).toEqual({
      ...raw.document.strategy,
      calculatedAt: null,
    });
    expect(reused.actual).toEqual(raw.actual);
  } finally {
    csv = previous;
  }
});

it("a corrected earlier actual buy date refreshes required price coverage", async () => {
  const previous = csv;
  csv = "symbol,date,market,open,high,low,close,volume\nA,2026-01-02,KOSDAQ,100,110,90,105,1000";
  try {
    const db = database();
    db.tables["screening_history"] = [];
    db.tables["portfolio_trades"]![0]!["entry_date"] = "2026-01-06";
    const first = await operateLedgers(db.client, "owner", { action: "load" });
    expect(first.document.strategy?.quotes["A"]).toBeUndefined();
    db.download.mockClear();
    vi.mocked(simulateStrategy).mockClear();
    const next = await operateLedgers(db.client, "owner", {
      action: "execution",
      revision: first.revision,
      execution: { ...first.document.executions[0]!, date: "2026-01-01" },
    });
    expect(next.document.strategy?.quotes["A"]?.price).toBe(105);
    expect(db.download).toHaveBeenCalledTimes(1);
    expect(simulateStrategy).toHaveBeenCalledTimes(1);
  } finally {
    csv = previous;
  }
});
it("rejects changed source activation metadata before reusing provided raw text", async () => {
  const db = database();
  await operateLedgers(db.client, "owner", { action: "load" });
  const before = structuredClone(db.tables["portfolio_ledgers"]);
  const { listActiveSources } = await import("./screeningSources.server");
  const sources = await listActiveSources(db.client, "owner");
  db.download.mockClear();
  await expect(
    refreshPortfolioAfterScreening(db.client, "owner", {
      sources: sources.map((source) => ({ ...source, activated_at: "different-registration" })),
      texts: [csv],
    }),
  ).rejects.toThrow("활성 원천데이터가 변경");
  expect(db.tables["portfolio_ledgers"]).toEqual(before);
  expect(db.download).not.toHaveBeenCalled();
});

it("a derived-source outage cannot drop or duplicate a valid actual execution edit", async () => {
  const db = database();
  const first = await operateLedgers(db.client, "owner", { action: "load" });
  const sources = await import("./screeningSources.server");
  const list = vi
    .spyOn(sources, "listActiveSources")
    .mockRejectedValue(new Error("temporary source outage"));
  const request = {
    action: "execution" as const,
    revision: first.revision,
    execution: { ...first.document.executions[0]!, shares: 19 },
  };
  try {
    const saved = await operateLedgers(db.client, "owner", request);
    expect(saved.actual.positions[0]!.shares).toBe(19);
    expect(saved.strategyRefresh.status).toBe("FAILED");
    expect(saved.document.strategy).toEqual(first.document.strategy);
    expect(saved.revision).toBe(first.revision + 1);
    await expect(operateLedgers(db.client, "owner", request)).rejects.toThrow("원장이 변경");
    expect(
      (db.tables["portfolio_ledgers"]![0]!["payload"] as LedgerDocument).executions,
    ).toHaveLength(first.document.executions.length);
  } finally {
    list.mockRestore();
  }
  expect(
    (await operateLedgers(db.client, "owner", { action: "load" })).actual.positions[0]!.shares,
  ).toBe(19);
});

it("changed calculation runtime invalidates a cached portfolio even when policy versions stay unchanged", async () => {
  const db = database();
  const first = await operateLedgers(db.client, "owner", { action: "load" });
  const runtime = await import("./ledger/octoberShadowEngineManifest.generated.json");
  const original = runtime.default.codeHash;
  db.download.mockClear();
  vi.mocked(simulateStrategy).mockClear();
  try {
    runtime.default.codeHash = `sha256:${"0".repeat(64)}`;
    const next = await operateLedgers(db.client, "owner", { action: "load" });
    expect(next.document.strategy?.fingerprint).not.toBe(first.document.strategy?.fingerprint);
    expect(db.download).toHaveBeenCalledTimes(1);
    expect(simulateStrategy).toHaveBeenCalledTimes(1);
  } finally {
    runtime.default.codeHash = original;
  }
});
