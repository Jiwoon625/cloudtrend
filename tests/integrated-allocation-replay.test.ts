/** Synthetic in-memory storage/persistence; real stage, adapters, ledger and publication code. No live DB. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import { runAnalysis } from "../src/lib/engine/pipeline";
import { getOperationalSignals } from "../src/lib/engine/operationalStrategy";
import { ETF_POLICY, type EtfStrategySnapshot } from "../src/lib/engine/etfStrategy";
import {
  runUsProspectiveAnalysis,
  type UsProspectiveInputRow,
} from "../src/lib/engine/usProspective";
import {
  createIntegratedAllocationShadow,
  type IntegratedAllocationLedger,
} from "../src/lib/integratedAllocationShadow";
import {
  integratedRegistry,
  prepareIntegratedDailyPublication,
  type IntegratedDailyPublication,
  type IntegratedRegistry,
} from "../src/lib/integratedAllocationPublication";
import {
  stageIntegratedKrEvidence,
  stageIntegratedUsEvidence,
  replayIntegratedAllocationAvailable,
} from "../src/lib/integratedAllocationReplay.server";
import { hashSeriesValue, type SeriesHash } from "../src/lib/ledger/modelSeries";
import {
  octoberModelCalendar,
  OCTOBER_CALENDAR_EVIDENCE,
  regularCloseAt,
} from "../src/lib/ledger/octoberShadowCalendar";
import type { IntegratedKrEvidence } from "../src/lib/integratedAllocationReplayAdapter";
import {
  readIntegratedAllocationOutbox,
  storeIntegratedAllocationOutbox,
} from "../src/lib/integratedAllocationRecovery.server";

type Book = {
  registry: IntegratedRegistry;
  head: IntegratedDailyPublication | null;
  ledger: IntegratedAllocationLedger;
};
const memory = vi.hoisted(() => ({
  files: new Map<string, Blob>(),
  books: new Map<string, unknown>(),
  writes: [] as string[],
  uploadCount: 0,
  uploadAttempts: 0,
  failStorage: false,
  failAudit: false,
  audits: [] as Array<Record<string, unknown>>,
}));
vi.mock("../src/lib/freshStorage", () => ({
  downloadFreshObject: vi.fn(async (_client: unknown, bucket: string, path: string) => {
    const data = memory.files.get(`${bucket}/${path}`);
    return data
      ? { data, error: null }
      : { data: null, error: { statusCode: "404", message: "not found" } };
  }),
}));
vi.mock("../src/lib/integratedAllocationStore.server", () => ({
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
async function payload<T>(market: "KR" | "US", date: string) {
  return JSON.parse(await memory.files.get(path(market, date))!.text()) as {
    hash: SeriesHash;
    payload: T;
  };
}
async function replacePayload(
  market: "KR" | "US",
  date: string,
  value: unknown,
  correctHash = true,
) {
  const hash = correctHash ? await hashSeriesValue(value) : H;
  memory.files.set(path(market, date), new Blob([JSON.stringify({ hash, payload: value })]));
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-03T01:00:00Z"));
  memory.files.clear();
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

it("stages only daily evidence, waits for missing markets, catches up sequentially, and reuses completed global heads", async () => {
  await stage("2026-10-12", ["KR"]);
  const waiting = await replayIntegratedAllocationAvailable(
    client,
    uid,
    "2026-10-14",
    "2026-10-15T01:00:00Z",
  );
  expect(waiting).toMatchObject({ recorded: 0, waiting: "2026-10-12 전체 시장 입력 대기" });
  expect(memory.writes).toHaveLength(0);
  await stage("2026-10-12", ["US"]);
  await stage("2026-10-13");
  await stage("2026-10-14");
  const intrinsic = await payload<IntegratedKrEvidence>("KR", "2026-10-14");
  expect(Object.values(intrinsic.payload.bars).every((b) => b.tradeDate === "2026-10-14")).toBe(
    true,
  );
  expect(intrinsic.payload).not.toHaveProperty("ledger");
  const result = await replayIntegratedAllocationAvailable(
    client,
    uid,
    "2026-10-14",
    "2026-10-15T01:00:00Z",
  );
  expect(result).toEqual({ recorded: 6, waiting: null });
  expect(memory.writes).toEqual([
    "O1:2026-10-12",
    "O1:2026-10-13",
    "O1:2026-10-14",
    "S07:2026-10-12",
    "S07:2026-10-13",
    "S07:2026-10-14",
  ]);
  expect(book("O1").ledger.deliveredEntrySignals).toEqual(book("S07").ledger.deliveredEntrySignals);
  expect(book("O1").ledger.deliveredEntrySignals).toHaveLength(3);
  expect(book("O1").ledger.markets.K.positions[0]?.quantity).toBe("332");
  expect(book("S07").ledger.markets.K.positions[0]?.quantity).toBe("599");
  expect(book("O1").ledger.markets.E.positions).toHaveLength(1);
  expect(book("O1").ledger.markets.U.positions).toHaveLength(1);
  expect(
    await replayIntegratedAllocationAvailable(client, uid, "2026-10-14", "2026-10-15T01:00:00Z"),
  ).toEqual({ recorded: 0, waiting: null });
  expect(memory.writes).toHaveLength(6);
});

it("keeps immutable staging idempotent and rejects changed daily evidence", async () => {
  await stage("2026-10-12");
  const count = memory.uploadCount;
  await stage("2026-10-12");
  expect(memory.uploadCount).toBe(count);
  const changed = krInput("2026-10-12");
  changed.dataset.bars[stock.symbol]![0]!.close = 2000;
  await expect(stageIntegratedKrEvidence(client, uid, changed)).rejects.toThrow(
    "변경할 수 없습니다",
  );
  expect(memory.writes).toHaveLength(0);
});

it("rejects corrupted archive hashes and old runtime code before publishing any day", async () => {
  await stage("2026-10-12");
  const old = (await payload<IntegratedKrEvidence>("KR", "2026-10-12")).payload;
  old.clock.codeHash = `sha256:${"b".repeat(64)}`;
  await replacePayload("KR", "2026-10-12", old);
  await expect(
    replayIntegratedAllocationAvailable(client, uid, "2026-10-12", "2026-10-13T01:00:00Z"),
  ).rejects.toThrow("daily evidence");
  expect(memory.writes).toHaveLength(0);
  await replacePayload("KR", "2026-10-12", old, false);
  await expect(
    replayIntegratedAllocationAvailable(client, uid, "2026-10-12", "2026-10-13T01:00:00Z"),
  ).rejects.toThrow("해시 불일치");
});

it("does not publish today's complete inputs before the official next-morning KR decision", async () => {
  await stage("2026-10-12");
  await expect(
    replayIntegratedAllocationAvailable(client, uid, "2026-10-12", "2026-10-12T23:09:59Z"),
  ).rejects.toThrow("Future allocation evidence");
  expect(memory.writes).toHaveLength(0);
  expect(
    await replayIntegratedAllocationAvailable(client, uid, "2026-10-12", "2026-10-12T23:10:00Z"),
  ).toEqual({ recorded: 2, waiting: null });
});

it("applies the partial October signal month only with the last full market batch and verified delivery times", async () => {
  for (const date of krCalendar.regularSessions.filter(
    (d) => d >= "2026-10-12" && d <= "2026-10-30",
  ))
    await stage(date);
  const result = await replayIntegratedAllocationAvailable(
    client,
    uid,
    "2026-10-30",
    "2026-11-02T01:00:00Z",
  );
  expect(result).toEqual({ recorded: 30, waiting: null });
  expect(book().head?.receipt.date).toBe("2026-10-30");
  expect(book().head?.publication.availableAt).toBe("2026-11-02T08:00:00+09:00");
  const month = book().ledger.receipts.find((r) => r.id === "month:2026-10")!.record.monthReview;
  expect(month).toMatchObject({
    signalMonth: "2026-10",
    targetMonth: "2026-11",
    partialMonth: true,
    coverageStart: "2026-10-12",
    signalCounts: { K: 1, E: 1, U: 1 },
    observationStatus: "COMPLETE",
    applied: true,
  });
  expect(book("S07").ledger.receipts.some((r) => r.id.startsWith("month:"))).toBe(false);
});

it("requires the complete ordered markets and exact global predecessor at publication", async () => {
  await stage("2026-10-12");
  await replayIntegratedAllocationAvailable(client, uid, "2026-10-12", "2026-10-13T01:00:00Z");
  const previous = book().head!;
  await expect(
    prepareIntegratedDailyPublication({
      registry: previous.registry,
      previous,
      date: "2026-10-13",
      sessions: [],
      now: "2026-10-14T01:00:00Z",
    }),
  ).rejects.toThrow("Complete ordered market day");
});

it("retains prepared daily evidence only on storage failure and restores it without scoring again", async () => {
  memory.failStorage = true;
  await stage("2026-10-12");
  expect(memory.files.size).toBe(0);
  expect(
    memory.audits.filter(
      (row) => (row.details as Record<string, unknown>)?.integratedAllocationOutbox,
    ),
  ).toHaveLength(2);
  expect(
    memory.audits.find(
      (row) => (row.details as Record<string, unknown>)?.integratedAllocationOutbox,
    ),
  ).toMatchObject({ status: "WAITING_INPUT", market: "KR" });
  expect(memory.writes).toHaveLength(0);
  const kr = await readIntegratedAllocationOutbox(client, uid, "KR", "2026-10-12");
  expect(kr?.version).toBe("integrated-kr-daily-evidence-v1");
  expect(kr).not.toHaveProperty("ledger");
  expect(
    await storeIntegratedAllocationOutbox(client, uid, {
      market: "KR",
      date: "2026-10-12",
      payload: kr!,
    }),
  ).toMatchObject({ reused: true });
  expect(
    memory.audits.filter(
      (row) => (row.details as Record<string, unknown>)?.integratedAllocationOutbox,
    ),
  ).toHaveLength(2);
  memory.failStorage = false;
  expect(
    await replayIntegratedAllocationAvailable(client, uid, "2026-10-12", "2026-10-13T01:00:00Z"),
  ).toEqual({ recorded: 2, waiting: null });
  expect((await payload("KR", "2026-10-12")).payload).toEqual(kr);
  expect(
    memory.audits.filter(
      (row) => (row.details as Record<string, unknown>)?.integratedAllocationOutbox,
    ),
  ).toHaveLength(2);
  expect(memory.writes).toHaveLength(2);
});

it("stops at the first failed restore and reports when both durable channels fail", async () => {
  memory.failStorage = true;
  await stage("2026-10-12");
  await stage("2026-10-13");
  const attempts = memory.uploadAttempts;
  await expect(
    replayIntegratedAllocationAvailable(client, uid, "2026-10-13", "2026-10-14T01:00:00Z"),
  ).rejects.toThrow("입력 저장 확인 실패");
  expect(memory.uploadAttempts - attempts).toBe(1);
  expect(memory.writes).toHaveLength(0);
  memory.failAudit = true;
  await expect(stage("2026-10-14", ["KR"])).rejects.toThrow(
    "provenance write could not be verified",
  );
  expect(
    memory.audits.filter(
      (row) => (row.details as Record<string, unknown>)?.integratedAllocationOutbox,
    ),
  ).toHaveLength(4);
});

it("rejects conflicting or stale outbox evidence and validates the direct replay date boundary", async () => {
  memory.failStorage = true;
  await stage("2026-10-12", ["KR"]);
  const kr = (await readIntegratedAllocationOutbox(client, uid, "KR", "2026-10-12"))!;
  const changed = structuredClone(kr);
  changed.clock.sourceHash = `sha256:${"b".repeat(64)}`;
  await expect(
    storeIntegratedAllocationOutbox(client, uid, {
      market: "KR",
      date: "2026-10-12",
      payload: changed,
    }),
  ).rejects.toThrow("복구 입력 충돌");
  changed.clock.codeHash = `sha256:${"c".repeat(64)}`;
  await expect(
    storeIntegratedAllocationOutbox(client, uid, {
      market: "KR",
      date: "2026-10-12",
      payload: changed,
    }),
  ).rejects.toThrow("실행 버전 대조 실패");
  expect(
    memory.audits.filter(
      (row) => (row.details as Record<string, unknown>)?.integratedAllocationOutbox,
    ),
  ).toHaveLength(1);
  await expect(replayIntegratedAllocationAvailable(client, uid, "2026-02-30")).rejects.toThrow(
    "기준일이 올바르지 않습니다",
  );
  await expect(replayIntegratedAllocationAvailable(client, uid, "2027-01-01")).rejects.toThrow(
    "달력 범위 밖",
  );
});
