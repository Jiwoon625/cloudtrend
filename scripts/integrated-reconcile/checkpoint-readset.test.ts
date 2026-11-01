import { checkpointScope, checkpointHistoricGenerations } from "./checkpoint-scope";
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
  downloadFreshObject: vi.fn(async (_client: unknown, bucket: string, path: string) => {
    memory.reads.push(`${bucket}/${path}`);
    const data = memory.files.get(`${bucket}/${path}`);
    return data
      ? { data, error: null }
      : { data: null, error: { statusCode: "404", message: "not found" } };
  }),
}));
vi.mock("../../src/lib/integratedAllocationStore.server", () => ({
  integratedAllocationCodeHash:
    "sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4",
  integratedAllocationRuntimeAdmission: {
    runtimeCodeHash: "sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4",
    frozenCodeHash: "sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4",
    reviewId: "original-integrated-allocation-2026-10-12",
  },
  readIntegratedAllocationBook: vi.fn(
    async (_client: unknown, _uid: string, kind: string) =>
      memory.books.get(kind) ?? { registry: null, ledger: null, head: null },
  ),
  appendIntegratedAllocationPublication: vi.fn(
    async (
      _client: unknown,
      _uid: string,
      publication: IntegratedDailyPublication,
      previous: IntegratedDailyPublication | null,
    ) => {
      const old = memory.books.get(publication.registry.policy.kind) as Book;
      if ((old.head?.stateHash ?? null) !== (previous?.stateHash ?? null))
        throw new Error("Synthetic predecessor conflict");
      const book: Book = {
        registry: publication.registry,
        head: publication,
        ledger: publication.result,
      };
      memory.books.set(publication.registry.policy.kind, book);
      memory.writes.push(`${publication.registry.policy.kind}:${publication.receipt.date}`);
      return { reused: false, book };
    },
  ),
}));
const H = "sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4" as SeriesHash;
const uid = "11111111-1111-4111-8111-111111111111";
const client = {
  from: (table: string) => {
    if (table !== "shadow_replay_audit") throw new Error("Unexpected actual/remote table access");
    const filters: Array<[string, unknown]> = [];
    const jsonFilters: Array<[string, unknown]> = [];
    const contains = (actual: unknown, expected: unknown): boolean =>
      expected !== null && typeof expected === "object"
        ? actual !== null &&
          typeof actual === "object" &&
          Object.entries(expected).every(([k, v]) =>
            contains((actual as Record<string, unknown>)[k], v),
          )
        : actual === expected;
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return query;
      },
      contains: (key: string, value: unknown) => {
        jsonFilters.push([key, value]);
        return query;
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(
          resolve({
            data: memory.audits.filter(
              (row) =>
                filters.every(([key, value]) => row[key] === value) &&
                jsonFilters.every(([key, value]) => contains(row[key], value)),
            ),
            error: null,
          }),
        ),
      insert: async (row: Record<string, unknown>) => {
        if (memory.failAudit) return { error: { message: "Synthetic database outage" } };
        memory.audits.push(structuredClone(row));
        return { error: null };
      },
    };
    return query;
  },
  rpc: () => {
    throw new Error("Unexpected live RPC");
  },
  storage: {
    from: (bucket: string) => ({
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
const path = (market: "KR" | "US", date: string) =>
  `cloudtrend-data/${uid}/staging/integrated-allocation-inputs/v1/${market}/${date}.json`;
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
const savedBooks = () => structuredClone([...memory.books.entries()]);
function resetBooks(saved: Array<[string, unknown]>) {
  memory.books.clear();
  for (const [kind, b] of structuredClone(saved)) memory.books.set(kind, b);
  memory.reads.length = 0;
  memory.writes.length = 0;
}
function hashes() {
  return [book("O1").head!.stateHash, book("S07").head!.stateHash];
}
function readSet() {
  return [...new Set(memory.reads)].sort();
}
function dependencies(through: string, firstUS: string) {
  return [
    ...krCalendar.regularSessions
      .filter((d) => d >= "2026-10-12" && d <= through)
      .map((d) => path("KR", d)),
    ...usCalendar.regularSessions
      .filter((d) => d >= firstUS && d <= through)
      .map((d) => path("US", d)),
  ].sort();
}
function pruneUs(before: string) {
  for (const key of memory.files.keys())
    if (key.includes("/US/") && key.slice(-15, -5) < before) memory.files.delete(key);
}
it("real month-end replay equals full reference using all KR history but only prior/new US", async () => {
  await stageThrough("2026-10-30");
  await replayIntegratedAllocationAvailable(client, uid, "2026-10-28", now);
  const checkpoint = savedBooks();
  const scope = checkpointScope({
    books: { O1: book("O1"), S07: book("S07") },
    calendars: { KR: krCalendar.regularSessions, US: usCalendar.regularSessions },
    throughDate: "2026-10-30",
  })!;
  expect(scope).not.toBeNull();
  expect(
    [
      ...scope.fullKrDates.map((d) => path("KR", d)),
      ...scope.fullUsDates.map((d) => path("US", d)),
    ].sort(),
  ).toEqual(dependencies("2026-10-30", "2026-10-28"));
  await replayIntegratedAllocationAvailable(client, uid, "2026-10-30", now);
  const reference = hashes();
  expect(book("O1").ledger.lastReviewMonth).toBe("2026-10");
  expect(book("O1").ledger.deliveredEntrySignals.length).toBeGreaterThan(0);
  resetBooks(checkpoint);
  pruneUs("2026-10-28");
  const result = await replayIntegratedAllocationAvailable(client, uid, "2026-10-30", now);
  expect(result).toEqual({ recorded: 4, waiting: null });
  expect(hashes()).toEqual(reference);
  expect(readSet()).toEqual(dependencies("2026-10-30", "2026-10-28"));
});
it("divergent O1/S07 checkpoints use union of prior-US dependencies and match reference", async () => {
  await stageThrough("2026-10-30");
  await replayIntegratedAllocationAvailable(client, uid, "2026-10-28", now);
  const olderS07 = structuredClone(book("S07"));
  await replayIntegratedAllocationAvailable(client, uid, "2026-10-29", now);
  const newerO1 = structuredClone(book("O1"));
  await replayIntegratedAllocationAvailable(client, uid, "2026-10-30", now);
  const reference = hashes();
  resetBooks([
    ["O1", newerO1],
    ["S07", olderS07],
  ]);
  pruneUs("2026-10-28");
  expect(await replayIntegratedAllocationAvailable(client, uid, "2026-10-30", now)).toEqual({
    recorded: 3,
    waiting: null,
  });
  expect(hashes()).toEqual(reference);
  expect(readSet()).toEqual(dependencies("2026-10-30", "2026-10-28"));
});
it("null heads require all initial KR/US days and preserve exact replay state on rerun", async () => {
  await stageThrough("2026-10-14");
  memory.reads.length = 0;
  expect(await replayIntegratedAllocationAvailable(client, uid, "2026-10-14", now)).toEqual({
    recorded: 6,
    waiting: null,
  });
  expect(readSet()).toEqual(dependencies("2026-10-14", "2026-10-12"));
  const reference = hashes();
  memory.reads.length = 0;
  expect(await replayIntegratedAllocationAvailable(client, uid, "2026-10-14", now)).toEqual({
    recorded: 0,
    waiting: null,
  });
  expect(readSet()).toEqual([]);
  expect(hashes()).toEqual(reference);
});
it("missing prior-US dependency fails rather than defaulting capacity or skipping predecessor", async () => {
  await stageThrough("2026-10-30");
  await replayIntegratedAllocationAvailable(client, uid, "2026-10-28", now);
  const before = hashes();
  memory.files.delete(path("US", "2026-10-28"));
  await expect(replayIntegratedAllocationAvailable(client, uid, "2026-10-30", now)).rejects.toThrow(
    "Point-in-time current/prior US analysis required",
  );
  expect(hashes()).toEqual(before);
});

it("actual verified checkpoint refuses metadata-only scope when old US presence cannot be proven", async () => {
  await stageThrough("2026-10-30");
  await replayIntegratedAllocationAvailable(client, uid, "2026-10-28", now);
  const scope = checkpointScope({
    books: { O1: book("O1"), S07: book("S07") },
    calendars: { KR: krCalendar.regularSessions, US: usCalendar.regularSessions },
    throughDate: "2026-10-30",
  })!;
  expect(scope.metadataOnlyUsDates).toContain("2026-10-12");
  const probe = async (p: string) =>
    memory.files.has(`cloudtrend-data/${p}`)
      ? { kind: "strong" as const, objectId: p, version: "one", etag: "etag", size: 123 }
      : null;
  expect(await checkpointHistoricGenerations(scope, uid, probe)).not.toBeNull();
  memory.files.delete(path("US", "2026-10-12"));
  expect(await checkpointHistoricGenerations(scope, uid, probe)).toBeNull();
});
it("calendar helper includes prior US for KR-only holiday without bypassing unresolved session-hour guards", () => {
  // Scope-only synthetic checkpoint: NOT a claim that Nov19 production hours are admitted.
  const throughDate = "2026-11-26",
    prior = "2026-11-25";
  const markets = Object.fromEntries(
    (["K", "E", "U"] as const).map((m) => {
      const sessions = (m === "U" ? usCalendar : krCalendar).regularSessions.filter(
        (d) => d >= "2026-10-12" && d <= prior,
      );
      return [m, { sessions, lastSessionDate: sessions.at(-1)! }];
    }),
  ) as Book["ledger"]["markets"];
  const checkpoint = { head: { stateHash: H, receipt: { date: prior } }, ledger: { markets } };
  const scope = checkpointScope({
    books: { O1: checkpoint, S07: checkpoint },
    calendars: { KR: krCalendar.regularSessions, US: usCalendar.regularSessions },
    throughDate,
  })!;
  expect(scope.pendingDates).toEqual([throughDate]);
  expect(scope.fullUsDates).toEqual([prior]);
  expect(scope.fullKrDates.at(-1)).toBe(throughDate);
});
