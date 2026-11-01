import { validateHistoricalKrLineage, type HistoricalLineageInput } from "./historical-lineage";
import {
  freezeRestartSeries,
  guardModelRun,
  type AdoptedSeriesKind,
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
import { hashSeriesValue, type SeriesHash } from "../../src/lib/ledger/modelSeries";
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
  publications: [] as IntegratedDailyPublication[],
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
      memory.publications.push(publication);
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
  memory.publications.length = 0;
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

async function lineageFixture(): Promise<HistoricalLineageInput> {
  for (const d of ["2026-10-12", "2026-10-13", "2026-10-14"]) await stage(d);
  await replayIntegratedAllocationAvailable(client, uid, "2026-10-14", "2026-11-03T01:00:00Z");
  const date = "2026-10-13",
    stageEnvelope = JSON.parse(await memory.files.get(path("KR", date))!.text());
  const models: HistoricalLineageInput["models"] = [];
  const changed = `sha256:${"b".repeat(64)}` as SeriesHash;
  for (const kind of [
    "KR_MIXED",
    "KR_KOSPI",
    "KR_KOSDAQ",
    "ETF_V02",
    "KR_KOSPI_CONFIRM1_BEAR",
  ] as AdoptedSeriesKind[]) {
    const series = await freezeRestartSeries({
      kind,
      frozenAt: "2026-10-09T00:00:00Z",
      codeHash: H,
      sourceHash: H,
    });
    const receipt = (
      await guardModelRun(series, {
        date,
        codeHash: H,
        configHash: series.configHash,
        sourceHash: changed,
      })
    ).receipt;
    const at = "2026-11-01T01:00:00Z";
    const reviewedRetrospective = {
      version: "kr-reviewed-retrospective-publication-v1",
      historicalAvailabilityClaim: false,
      derivedBasisSourceStatus: "NOT_REGISTERED_AT_PREPARATION",
      registryHash: H,
      receiptHash: H,
      preparationHash: H,
      capsuleHash: H,
      originFinalPublicationHash: H,
      preparationRuntimeCodeHash: H,
      runtimeCodeHash: H,
      captureFinishedAt: at,
      originFinalActivatedAt: at,
      evidenceStoredAt: at,
      modelAvailableAt: at,
      modelDecisionAt: at,
    };
    const body = {
      book: "MODEL",
      bookId: series.bookId,
      contractHash: series.contractHash,
      receipt,
      previousStateHash: null,
      calendar: krCalendar,
      publication: {
        version: "october-manual-publication-v1",
        inputHash: H,
        sourceHash: changed,
        availableAt: at,
        decisionAt: at,
        reviewedRetrospective,
      },
      result: { fixture: "synthetic-retrospective-model-proof-not-economically-replayed" },
    };
    models.push({
      series,
      run: { ...body, stateHash: await hashSeriesValue(body) } as unknown as OctoberRun,
    });
  }
  const chains = Object.fromEntries(
    (["O1", "S07"] as const).map((kind) => {
      const rows = memory.publications
        .filter((p) => p.registry.policy.kind === kind)
        .map((p, i, all) => ({
          series_id: p.bookId,
          session_date: p.receipt.date,
          previous_session_date: all[i - 1]?.receipt.date ?? null,
          state_hash: p.stateHash,
          payload: p,
        }));
      return [kind, { checkpointHash: rows.at(-1)!.state_hash, rows }];
    }),
  ) as HistoricalLineageInput["chains"];
  const prior = JSON.parse(await memory.files.get(path("KR", "2026-10-12"))!.text()).payload;
  return structuredClone({
    uid,
    date,
    stage: stageEnvelope,
    history: [prior],
    models,
    chains,
    audits: memory.audits,
  }) as HistoricalLineageInput;
}
it("proves synthetic retrospective model/source mismatch only via both actual original integrated chains", async () => {
  const input = await lineageFixture();
  expect(input.models[0].run.publication.sourceHash).not.toBe(input.stage.payload.clock.sourceHash);
  const proof = await validateHistoricalKrLineage(input);
  expect(proof.stageHash).toBe(input.stage.hash);
  expect(proof.checkpointHashes.O1).toBe(input.chains.O1.checkpointHash);
  expect(proof.proofHash).toMatch(/^sha256:[a-f0-9]{64}$/);
});
it("refuses pending date beyond either verified checkpoint", async () => {
  const input = await lineageFixture();
  input.chains.O1.rows = input.chains.O1.rows.slice(0, 1);
  input.chains.O1.checkpointHash = input.chains.O1.rows[0].state_hash;
  await expect(validateHistoricalKrLineage(input)).rejects.toThrow("pending date");
});
it("refuses missing prepared audit", async () => {
  const input = await lineageFixture();
  input.audits = [];
  await expect(validateHistoricalKrLineage(input)).rejects.toThrow("prepared audit");
});
it("refuses changed stage payload with old envelope hash", async () => {
  const input = await lineageFixture();
  input.stage.payload.clock.availableAt = "2026-10-14T08:01:00+09:00";
  await expect(validateHistoricalKrLineage(input)).rejects.toThrow("stage envelope");
});
it("refuses correctly rehashed/audited stage that differs from original adapted input receipt", async () => {
  const input = await lineageFixture(),
    old = input.stage.hash;
  input.stage.payload.clock.availableAt = "2026-10-14T08:01:00+09:00";
  input.stage.hash = await hashSeriesValue(input.stage.payload);
  for (const audit of input.audits) {
    const attempt = (audit.details as { integratedRuntimeAttempt?: { subjectHash: string } })
      .integratedRuntimeAttempt;
    if (attempt?.subjectHash === old) attempt.subjectHash = input.stage.hash;
  }
  await expect(validateHistoricalKrLineage(input)).rejects.toThrow("adapted input mismatch");
});
it("refuses corrupted integrated publication receipt", async () => {
  const input = await lineageFixture();
  input.chains.S07.rows[1].payload.receipt.runHash = H;
  await expect(validateHistoricalKrLineage(input)).rejects.toThrow("publication integrity");
});
it("refuses nonretrospective models even if their canonical state hash is updated", async () => {
  const input = await lineageFixture(),
    run = input.models[0].run;
  delete run.publication.reviewedRetrospective;
  const { stateHash: _old, ...body } = run;
  run.stateHash = await hashSeriesValue(body);
  await expect(validateHistoricalKrLineage(input)).rejects.toThrow("retrospective marker");
});
it("refuses fewer than all five retrospective model proofs", async () => {
  const input = await lineageFixture();
  input.models.pop();
  await expect(validateHistoricalKrLineage(input)).rejects.toThrow("all five model kinds");
});
it("refuses a rehashed invalid retrospective marker", async () => {
  const input = await lineageFixture(),
    run = input.models[0].run;
  run.publication.reviewedRetrospective!.registryHash = "not-a-hash" as SeriesHash;
  const { stateHash: _old, ...body } = run;
  run.stateHash = await hashSeriesValue(body);
  await expect(validateHistoricalKrLineage(input)).rejects.toThrow("retrospective hash references");
});
it("refuses ambiguous matching prepared audits", async () => {
  const input = await lineageFixture();
  const matching = input.audits.find(
    (a) =>
      a.market === "KR" &&
      a.signal_date === input.date &&
      (a.details as { integratedRuntimeAttempt?: { kind: string } }).integratedRuntimeAttempt
        ?.kind === "EVIDENCE_PREPARED",
  )!;
  input.audits.push(structuredClone(matching));
  await expect(validateHistoricalKrLineage(input)).rejects.toThrow("unambiguous prepared audit");
});
it("refuses truncated historical checkpoint chain", async () => {
  const input = await lineageFixture();
  input.chains.S07.rows.splice(0, 1);
  await expect(validateHistoricalKrLineage(input)).rejects.toThrow("complete checkpoint chain");
});
it("refuses changed expected checkpoint hash", async () => {
  const input = await lineageFixture();
  input.chains.O1.checkpointHash = `sha256:${"c".repeat(64)}`;
  await expect(validateHistoricalKrLineage(input)).rejects.toThrow();
});
it("refuses uniformly malformed current source hashes despite rehashed model envelopes", async () => {
  const input = await lineageFixture();
  for (const { run } of input.models) {
    run.publication.sourceHash = "not-a-hash" as SeriesHash;
    const { stateHash: _old, ...body } = run;
    run.stateHash = await hashSeriesValue(body);
  }
  await expect(validateHistoricalKrLineage(input)).rejects.toThrow(
    "invalid current market source hash",
  );
});
