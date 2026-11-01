import { inspectNoWork } from "./quick-inspection";
import { buildReconcilePort } from "./adapter";
import { reconcile } from "./core";
import {
  freezeRestartSeries,
  guardModelRun,
  hashSeriesValue,
  type AdoptedSeriesKind,
  type FrozenModelSeries,
} from "../../src/lib/ledger/modelSeries";
import type { OctoberRun } from "../../src/lib/ledger/octoberShadowPipeline";
/** Synthetic in-memory storage/persistence; real stage, adapters, ledger and publication code. No live DB. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMockDataset } from "../../src/lib/engine/mockProvider";
import { runAnalysis } from "../../src/lib/engine/pipeline";
import { getOperationalSignals } from "../../src/lib/engine/operationalStrategy";
import { ETF_POLICY, type EtfStrategySnapshot } from "../../src/lib/engine/etfStrategy";
import {
  runUsProspectiveAnalysis,
  type UsProspectiveInputRow,
} from "../../src/lib/engine/usProspective";
import {
  createIntegratedAllocationShadow,
  type IntegratedAllocationLedger,
} from "../../src/lib/integratedAllocationShadow";
import {
  integratedRegistry,
  type IntegratedDailyPublication,
  type IntegratedRegistry,
} from "../../src/lib/integratedAllocationPublication";
import {
  stageIntegratedKrEvidence,
  stageIntegratedUsEvidence,
  replayIntegratedAllocationAvailable,
} from "../../src/lib/integratedAllocationReplay.server";
import { type SeriesHash } from "../../src/lib/ledger/modelSeries";
import {
  octoberModelCalendar,
  OCTOBER_CALENDAR_EVIDENCE,
  regularCloseAt,
} from "../../src/lib/ledger/octoberShadowCalendar";

type Book = {
  registry: IntegratedRegistry;
  head: IntegratedDailyPublication | null;
  ledger: IntegratedAllocationLedger;
};
const memory = vi.hoisted(() => ({
  registries: new Map<string, FrozenModelSeries>(),
  modelRows: [] as Array<Record<string, unknown>>,
  integratedRows: [] as Array<Record<string, unknown>>,
  failAppend: null as string | null,
  files: new Map<string, Blob>(),
  books: new Map<string, unknown>(),
  writes: [] as string[],
  reads: [] as string[],
  uploadCount: 0,
  uploadAttempts: 0,
  failStorage: false,
  failAudit: false,
  audits: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../src/lib/freshStorage", () => ({
  downloadFreshObject: async (client: SupabaseClient, bucket: string, path: string) =>
    client.storage.from(bucket).download(path),
}));
vi.mock("../../src/lib/integratedAllocationStore.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/integratedAllocationStore.server")>();
  return {
    integratedAllocationCodeHash:
      "sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4",
    integratedAllocationRuntimeAdmission: {
      runtimeCodeHash: "sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4",
      frozenCodeHash: "sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4",
      reviewId: "original-integrated-allocation-2026-10-12",
    },
    readIntegratedAllocationBook: actual.readIntegratedAllocationBook,
    appendIntegratedAllocationPublication: vi.fn(
      async (
        _client: unknown,
        _uid: string,
        publication: IntegratedDailyPublication,
        previous: IntegratedDailyPublication | null,
      ) => {
        const key = `${publication.registry.policy.kind}:${publication.receipt.date}`;
        if (memory.failAppend === key) {
          memory.failAppend = null;
          throw Error("Synthetic append interruption");
        }
        const old = memory.books.get(publication.registry.policy.kind) as Book;
        if ((old.head?.stateHash ?? null) !== (previous?.stateHash ?? null))
          throw new Error("Synthetic predecessor conflict");
        const book: Book = {
          registry: publication.registry,
          head: publication,
          ledger: publication.result,
        };
        memory.integratedRows.push({
          user_id: uid,
          series_id: publication.bookId,
          session_date: publication.receipt.date,
          previous_session_date: previous?.receipt.date ?? null,
          state_hash: publication.stateHash,
          payload: structuredClone(publication),
        });
        memory.books.set(publication.registry.policy.kind, book);
        memory.writes.push(`${publication.registry.policy.kind}:${publication.receipt.date}`);
        return { reused: false, book };
      },
    ),
  };
});
const H = "sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4" as SeriesHash;
const uid = "11111111-1111-4111-8111-111111111111";
const client = {
  from: (table: string) => {
    if (!["shadow_replay_audit", "ledger_model_series", "ledger_model_sessions"].includes(table))
      throw Error("Unexpected table");
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let orderKey = "",
      ascending = true,
      limitN: number | undefined;
    const subset = (a: unknown, e: unknown): boolean =>
      e !== null && typeof e === "object"
        ? a !== null &&
          typeof a === "object" &&
          Object.entries(e).every(([k, v]) => subset((a as Record<string, unknown>)[k], v))
        : a === e;
    const result = () => {
      let rows =
        table === "shadow_replay_audit"
          ? memory.audits
          : table === "ledger_model_sessions"
            ? [...memory.modelRows, ...memory.integratedRows]
            : [...memory.registries.values()]
                .map((p) => ({ user_id: uid, series_id: p.bookId, payload: p }))
                .concat(
                  [...memory.books.values()].map((b) => ({
                    user_id: uid,
                    series_id: (b as Book).registry.bookId,
                    payload: (b as Book).registry,
                  })) as never[],
                );
      rows = rows.filter((r) => filters.every((f) => f(r)));
      if (orderKey)
        rows.sort(
          (a, b) => String(a[orderKey]).localeCompare(String(b[orderKey])) * (ascending ? 1 : -1),
        );
      return limitN === undefined ? rows : rows.slice(0, limitN);
    };
    const q = {
      select: () => q,
      eq(k: string, v: unknown) {
        if (k === "user_id") expect(v).toBe(uid);
        filters.push((r) => r[k] === v);
        return q;
      },
      gte(k: string, v: string) {
        filters.push((r) => String(r[k]) >= v);
        return q;
      },
      lte(k: string, v: string) {
        filters.push((r) => String(r[k]) <= v);
        return q;
      },
      contains(k: string, v: unknown) {
        filters.push((r) => subset(r[k], v));
        return q;
      },
      order(k: string, o: { ascending: boolean }) {
        orderKey = k;
        ascending = o.ascending;
        return q;
      },
      limit(n: number) {
        limitN = n;
        return q;
      },
      async range(a: number, b: number) {
        return { data: result().slice(a, b + 1), error: null };
      },
      async maybeSingle() {
        const r = result();
        if (r.length > 1) throw Error("Duplicate row");
        return { data: r[0] ?? null, error: null };
      },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(resolve({ data: result(), error: null }));
      },
      async insert(row: Record<string, unknown>) {
        if (table !== "shadow_replay_audit") throw Error("Unauthorized write");
        memory.audits.push({ ...structuredClone(row), id: memory.audits.length + 1 });
        return { error: null };
      },
    };
    return q;
  },
  rpc: () => {
    throw new Error("Unexpected live RPC");
  },
  storage: {
    from: (bucket: string) => ({
      download: async (path: string) => {
        memory.reads.push(`${bucket}/${path}`);
        const data = memory.files.get(`${bucket}/${path}`);
        return data
          ? { data, error: null }
          : { data: null, error: { statusCode: "404", message: "not found" } };
      },
      upload: async (
        path: string,
        blob: Blob,
        options: { upsert: boolean; contentType: string },
      ) => {
        expect(options.upsert).toBe(false);
        expect(options.contentType).toBe("application/json");
        expect(path).toMatch(/\/staging\/integrated-allocation-inputs\/v1\/.*\.json$/);
        memory.uploadAttempts++;
        if (memory.failStorage) return { error: { message: "Synthetic storage outage" } };
        const key = `${bucket}/${path}`;
        if (memory.files.has(key)) return { error: { message: "duplicate" } };
        memory.files.set(key, blob);
        memory.uploadCount++;
        return { error: null };
      },
    }),
  },
} as unknown as SupabaseClient;
const dataset = getMockDataset(),
  baseAnalysis = runAnalysis(dataset);
const stock = dataset.instruments.find((i) => i.market === "KOSDAQ")!,
  etf = dataset.instruments.find((i) => i.instrumentType === "ETF")!;
const stockRow = baseAnalysis.rows.find((r) => r.instrument.symbol === stock.symbol)!,
  etfRow = baseAnalysis.rows.find((r) => r.instrument.symbol === etf.symbol)!;
const krCalendar = await octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
const usCalendar = await octoberModelCalendar("US", OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
const book = (kind: "O1" | "S07" = "O1") => memory.books.get(kind) as Book;
function krInput(date: string) {
  const next = krCalendar.regularSessions.find((d) => d > date)!;
  const availableAt = `${next}T08:00:00+09:00`,
    decisionAt = `${next}T08:10:00+09:00`;
  const prior = krCalendar.regularSessions.filter((d) => d < date).at(-1)!;
  const state = date === "2026-10-12" ? "pending" : date === "2026-10-13" ? "confirmed" : "none";
  const strategy: EtfStrategySnapshot = {
    version: ETF_POLICY.version,
    date,
    previousDate: prior,
    eligible: true,
    score: 85,
    previousScore: state === "pending" ? 79 : 85,
    technical: 85,
    priority: 5,
    health: 15,
    environment: 15,
    environmentSource: "stock_sector",
    region: "US",
    sector: "INDEX",
    annualVolatility: 0.3,
    entryWeight: 0.05,
    underlyingClose: 100,
    underlyingMa60: 90,
    onset: state === "confirmed",
    rawOnset: state === "pending",
    entryState: state,
    originDate: state === "pending" ? date : state === "confirmed" ? prior : null,
    confirmationDate: state === "confirmed" ? date : null,
    confirmationIssues: [],
    averageTradingValue20: 1e9,
    dataStatus: "ready",
    krxReferenceDate: date,
    exit: null,
    issues: [],
  };
  const bar = {
    tradeDate: date,
    open: 1000,
    high: 1000,
    low: 1000,
    close: 1000,
    volume: 1e6,
    tradingValue: 1e9,
    marketCap: null,
    foreignNetBuyValue: null,
    institutionNetBuyValue: null,
  };
  const currentDataset = {
    ...dataset,
    asOfDate: date,
    instruments: [stock, etf],
    tradeDates: krCalendar.regularSessions.filter((d) => d <= date),
    bars: { [stock.symbol]: [bar], [etf.symbol]: [bar] },
  };
  const analysis = {
    ...baseAnalysis,
    asOfDate: date,
    calculatedAt: availableAt,
    rows: [
      {
        ...stockRow,
        hardFilterPassed: true,
        hardFilterStatus: "PASS" as const,
        pendingRules: [],
        operatingScore10: 8,
        scoreDelta1d: date === "2026-10-12" ? 5 : 0,
        ...getOperationalSignals("KOSDAQ", date === "2026-10-12" ? 7.5 : 8, 8, true, date),
      },
      { ...etfRow, etfStrategy: strategy },
    ],
  };
  return { dataset: currentDataset, analysis, sourceHash: H, availableAt, decisionAt };
}
function usRow(symbol: string, x: number, date: string): UsProspectiveInputRow {
  return {
    date,
    symbol,
    name: symbol,
    market: "NASDAQ",
    sector: "IT",
    securityType: "STOCK",
    status: "ACTIVE",
    currency: "USD",
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1e6,
    dollarVolume: 1e8,
    sharesOutstanding: 1e8,
    marketCap: 1e10,
    ret120: x,
    ret252: x,
    beta60Spy: x,
    ichimokuTkGap: x,
    relvol1_20: x,
    adv20Usd: 1e7,
    amihud20: 1 / (x + 100),
    active20: true,
    tossTradable: true,
    isCommonShare: true,
    fxUsdKrw: 9999,
  };
}
function usInput(date: string) {
  const prior = usCalendar.regularSessions.filter((d) => d < date).at(-1)!;
  const analysis = runUsProspectiveAnalysis(
    Array.from({ length: 20 }, (_, i) => usRow(`S${i}`, i === 10 ? 100 : i, date)),
    { lastDate: prior, coreRanks: { S10: date === "2026-10-12" ? 0.5 : 1 }, betaWeakStreak: {} },
  );
  const close = Date.parse(regularCloseAt("US", date));
  return {
    analysis,
    sourceHash: H,
    availableAt: new Date(close + 60000).toISOString(),
    decisionAt: new Date(close + 120000).toISOString(),
  };
}
async function stage(date: string, markets: Array<"KR" | "US"> = ["KR", "US"]) {
  if (markets.includes("KR")) await stageIntegratedKrEvidence(client, uid, krInput(date));
  if (markets.includes("US")) await stageIntegratedUsEvidence(client, uid, usInput(date));
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T01:00:00Z"));
  memory.registries.clear();
  memory.modelRows = [];
  memory.integratedRows = [];
  memory.failAppend = null;
  memory.files.clear();
  memory.reads.length = 0;
  memory.books.clear();
  memory.writes.length = 0;
  memory.uploadCount = 0;
  memory.uploadAttempts = 0;
  memory.failStorage = false;
  memory.failAudit = false;
  memory.audits.length = 0;
  for (const kind of ["O1", "S07"] as const)
    memory.books.set(kind, {
      registry: await integratedRegistry(kind, H),
      head: null,
      ledger: await createIntegratedAllocationShadow(kind, { codeHash: H }),
    } satisfies Book);
});
afterEach(() => vi.useRealTimers());

const now = "2026-11-03T01:00:00Z";
async function stageThrough(through: string) {
  const days = [...new Set([...krCalendar.regularSessions, ...usCalendar.regularSessions])]
    .filter((d) => d >= "2026-10-12" && d <= through)
    .sort();
  for (const d of days)
    await stage(
      d,
      (["KR", "US"] as const).filter((m) =>
        (m === "KR" ? krCalendar : usCalendar).regularSessions.includes(d),
      ),
    );
}

async function seedModels(through: string) {
  for (const kind of [
    "KR_MIXED",
    "KR_KOSPI",
    "KR_KOSDAQ",
    "ETF_V02",
    "KR_KOSPI_CONFIRM1_BEAR",
    "US_A0",
    "US_A2",
    "US_B3",
  ] as AdoptedSeriesKind[]) {
    const series = await freezeRestartSeries({
      kind,
      frozenAt: "2026-10-09T00:00:00Z",
      codeHash: H,
      sourceHash: H,
    });
    memory.registries.set(series.bookId, series);
    const market = series.policy.market,
      calendar = market === "KR" ? krCalendar : usCalendar;
    let previous: OctoberRun | null = null;
    for (const date of calendar.regularSessions.filter((d) => d >= "2026-10-12" && d <= through)) {
      const receipt = (
        await guardModelRun(series, {
          date,
          codeHash: series.codeHash,
          configHash: series.configHash,
          sourceHash: H,
        })
      ).receipt;
      const clock = market === "KR" ? krInput(date) : usInput(date);
      const body = {
        book: "MODEL",
        bookId: series.bookId,
        contractHash: series.contractHash,
        receipt,
        previousStateHash: previous?.stateHash ?? null,
        calendar,
        publication: {
          version: "october-manual-publication-v1",
          sourceHash: H,
          inputHash: H,
          availableAt: clock.availableAt,
          decisionAt: clock.decisionAt,
        },
        result: { fixture: "market-economic-engine-not-under-test" },
      };
      const run = { ...body, stateHash: await hashSeriesValue(body) } as unknown as OctoberRun;
      memory.modelRows.push({
        user_id: uid,
        series_id: series.bookId,
        session_date: date,
        previous_session_date: previous?.receipt.date ?? null,
        state_hash: run.stateHash,
        payload: run,
      });
      previous = run;
    }
  }
}
async function freshGeneration(p: string) {
  const file = memory.files.get(`cloudtrend-data/${p}`);
  return file
    ? {
        kind: "strong" as const,
        objectId: p,
        version: "immutable-test-generation",
        etag: "test-etag",
        size: file.size,
      }
    : null;
}
async function ready() {
  await stageThrough("2026-10-27");
  await seedModels("2026-10-27");
  await replayIntegratedAllocationAvailable(client, uid, "2026-10-22", now, "service");
  memory.writes = [];
  memory.reads = [];
}
it("three trading days across weekend: actual quick→adapter→core→replay publishes six rows once, preserving prior rows", async () => {
  await ready();
  const before = structuredClone(memory.integratedRows);
  const quick = await inspectNoWork(client, uid, "2026-10-27", freshGeneration);
  expect(quick.needsFullInspection).toBe(true);
  const port = await buildReconcilePort(client, uid, now, "2026-10-27", {
    freshGeneration,
    useVerifiedCheckpoint: true,
  });
  expect(port.dates).toEqual(["2026-10-23", "2026-10-26", "2026-10-27"]);
  const result = await reconcile(port, { now, apply: true });
  expect(result.status).toBe("COMPLETE");
  expect(result.recorded).toBe(6);
  expect(result.heads).toEqual({ O1: "2026-10-27", S07: "2026-10-27" });
  expect(memory.integratedRows.slice(0, before.length)).toEqual(before);
  expect(new Set(memory.writes).size).toBe(6);
  // The replay bridge consumes approved cached inputs: one underlying body read per required object.
  const inputs = memory.reads.filter((p) => p.includes("/staging/"));
  expect(inputs.length).toBe(new Set(inputs).size);
  const count = memory.integratedRows.length;
  expect((await inspectNoWork(client, uid, "2026-10-27", freshGeneration)).status).toBe(
    "NO_WORK_METADATA_ONLY",
  );
  const rerun = await reconcile(
    await buildReconcilePort(client, uid, now, "2026-10-27", {
      freshGeneration,
      useVerifiedCheckpoint: true,
    }),
    { now, apply: true },
  );
  expect(rerun.recorded).toBe(0);
  expect(memory.integratedRows).toHaveLength(count);
});
it("real adapter resumes interrupted independent books without duplicate or prior-row replacement", async () => {
  await ready();
  const before = structuredClone(memory.integratedRows);
  memory.failAppend = "S07:2026-10-26";
  await expect(
    reconcile(
      await buildReconcilePort(client, uid, now, "2026-10-27", {
        freshGeneration,
        useVerifiedCheckpoint: true,
      }),
      { now, apply: true },
    ),
  ).rejects.toThrow("Synthetic append interruption");
  expect(book("O1").head!.receipt.date).toBe("2026-10-27");
  expect(book("S07").head!.receipt.date).toBe("2026-10-23");
  const result = await reconcile(
    await buildReconcilePort(client, uid, now, "2026-10-27", {
      freshGeneration,
      useVerifiedCheckpoint: true,
    }),
    { now, apply: true },
  );
  expect(result.recorded).toBe(2);
  expect(result.status).toBe("COMPLETE");
  expect(memory.integratedRows.slice(0, before.length)).toEqual(before);
  expect(new Set(memory.writes).size).toBe(memory.writes.length);
});
it("real adapter restores exact missing middle outbox before chronological three-day publication", async () => {
  await ready();
  const before = structuredClone(memory.integratedRows);
  const key = `cloudtrend-data/${uid}/staging/integrated-allocation-inputs/v1/KR/2026-10-26.json`;
  const envelope = JSON.parse(await memory.files.get(key)!.text());
  memory.files.delete(key);
  const { storeIntegratedAllocationOutbox } =
    await import("../../src/lib/integratedAllocationRecovery.server");
  await storeIntegratedAllocationOutbox(client, uid, {
    market: "KR",
    date: "2026-10-26",
    payload: envelope.payload,
  });
  const result = await reconcile(
    await buildReconcilePort(client, uid, now, "2026-10-27", {
      freshGeneration,
      useVerifiedCheckpoint: true,
    }),
    { now, apply: true },
  );
  expect(result.status).toBe("COMPLETE");
  expect(result.restoredInputs).toBe(1);
  expect(result.recorded).toBe(6);
  expect(JSON.parse(await memory.files.get(key)!.text()).hash).toBe(envelope.hash);
  expect(memory.integratedRows.slice(0, before.length)).toEqual(before);
  expect(new Set(memory.writes).size).toBe(6);
  expect((await inspectNoWork(client, uid, "2026-10-27", freshGeneration)).status).toBe(
    "NO_WORK_METADATA_ONLY",
  );
});
