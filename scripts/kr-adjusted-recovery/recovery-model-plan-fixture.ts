/* eslint-disable @typescript-eslint/no-explicit-any */
/** Synthetic engine-generated recovery fixture. No credentials, IO, client, or private values. */
import assert from "node:assert/strict";
import {
  canonicalSeriesJson,
  hashSeriesValue,
  freezeRestartSeries,
  type SeriesHash,
  type FrozenModelSeries,
} from "../../src/lib/ledger/modelSeries";
import {
  recordOctoberPublication,
  assertStoredOctoberRun,
  type OctoberRun,
  type PreparedOctoberPublication,
  type KrModelPublication,
} from "../../src/lib/ledger/octoberShadowPipeline";
import type { OctoberShadowStore } from "../../src/lib/ledger/octoberShadowRepository.server";
import type { KrDailyInputArchive } from "../../src/lib/ledger/octoberShadowArchive";
import { nextKrRegularSession } from "../../src/lib/ledger/krShadowDecision";
import { DEFAULT_SCORING_CONFIG } from "../../src/lib/engine/scoring";
import { ETF_POLICY, type EtfStrategySnapshot } from "../../src/lib/engine/etfStrategy";
import type { MarketDataset } from "../../src/lib/engine/dataset";
import type { AnalysisResult, ScreeningRow } from "../../src/lib/engine/pipeline";
import {
  KR_RETROSPECTIVE_POLICY,
  type KrRetrospectiveAuthority,
} from "../../src/lib/ledger/krRetrospectivePublication";
import {
  integratedRegistry,
  prepareIntegratedDailyPublication,
  type IntegratedDailyPublication,
} from "../../src/lib/integratedAllocationPublication";
import {
  createIntegratedAllocationShadow,
  type IntegratedAllocationSessionInput,
} from "../../src/lib/integratedAllocationShadow";
import { buildExecutionProvenance } from "./operation-schema";
import type { ExactModelApplyInput, RecoveryApplyApproval } from "./apply-model-plan";
export const H = (letter = "a") => ("sha256:" + letter.repeat(64)) as SeriesHash;
const codeHash = H(),
  sourceHash = H("b");
export const KINDS = [
  "KR_MIXED",
  "KR_KOSPI",
  "KR_KOSDAQ",
  "ETF_V02",
  "KR_KOSPI_CONFIRM1_BEAR",
] as const;
export const DATES = [
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
  "2026-10-16",
  "2026-10-19",
  "2026-10-20",
  "2026-10-21",
  "2026-10-22",
  "2026-10-23",
  "2026-10-26",
  "2026-10-27",
];
export const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
export const clone = <T>(x: T): T => structuredClone(x);
function krSource(date: string): KrModelPublication {
  const bar = {
    tradeDate: date,
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    volume: 1e6,
    tradingValue: 1e8,
    marketCap: null,
    foreignNetBuyValue: null,
    institutionNetBuyValue: null,
  };
  const instruments = [
    {
      symbol: "000001",
      name: "Synthetic KOSPI",
      market: "KOSPI",
      instrumentType: "STOCK",
      sectorCode: "TECH",
      sectorName: "Tech",
    },
    {
      symbol: "000002",
      name: "Synthetic KOSDAQ",
      market: "KOSDAQ",
      instrumentType: "STOCK",
      sectorCode: "TECH",
      sectorName: "Tech",
    },
    {
      symbol: "000003",
      name: "Synthetic ETF",
      market: "KOSPI",
      instrumentType: "ETF",
      sectorCode: "TECH",
      sectorName: "Tech",
    },
  ] as MarketDataset["instruments"];
  const strategy: EtfStrategySnapshot = {
    version: ETF_POLICY.version,
    date,
    previousDate: date === "2026-10-06" ? "2026-10-02" : "2026-10-06",
    eligible: false,
    score: 50,
    previousScore: 50,
    technical: 50,
    priority: 50,
    health: 50,
    environment: 50,
    environmentSource: "stock_sector",
    region: "KR",
    sector: "TECH",
    annualVolatility: 0.2,
    entryWeight: 0.075,
    underlyingClose: 100,
    underlyingMa60: 95,
    onset: false,
    rawOnset: false,
    entryState: "none",
    originDate: null,
    confirmationDate: null,
    confirmationIssues: [],
    averageTradingValue20: 1e8,
    dataStatus: "ready",
    krxReferenceDate: date,
    exit: null,
    issues: [],
  };
  const rows = instruments.map((instrument) => ({
    instrument,
    snapshot: { tradeDate: date },
    operatingScore10: 5,
    priority: { points: 5 },
    ...(instrument.instrumentType === "ETF" ? { etfStrategy: strategy } : {}),
  })) as ScreeningRow[];
  const dataset = {
    provider: "TEST_FIXTURE",
    version: "1",
    asOfDate: date,
    isLive: true,
    capabilities: {
      marketCap: true,
      fundamentals: true,
      etfFacts: true,
      sectors: true,
      investorFlow: true,
      volatilityIndex: true,
      exactTradingValue: true,
    },
    notes: [],
    sectors: [],
    tradeDates: ["2026-10-02", "2026-10-06", ...(date > "2026-10-06" ? [date] : [])],
    kospiGateDates: ["2026-10-02", "2026-10-06", ...(date > "2026-10-06" ? [date] : [])],
    instruments,
    bars: Object.fromEntries(instruments.map((i) => [i.symbol, [bar]])),
    indexSeries: [{ indexCode: "KOSPI", bars: [bar] }],
    financials: {},
    etfFacts: {},
    vkospiSeries: [],
  } as unknown as MarketDataset;
  const next = nextKrRegularSession(date);
  const availableAt = next ? `${next}T08:00:00+09:00` : `${date}T23:50:00+09:00`;
  const decisionAt = next ? `${next}T08:10:00+09:00` : `${date}T23:55:00+09:00`;
  return {
    market: "KR",
    codeHash,
    sourceHash,
    availableAt,
    decisionAt,
    confirmedRegularClose: true,
    failedSymbols: 0,
    dataset,
    config: DEFAULT_SCORING_CONFIG,
    universeEvidence: {
      asOfDate: date === "2026-10-06" ? "2026-10-02" : "2026-10-06",
      sourceHash,
      symbols: instruments.map((i) => i.symbol),
    },
    sourceEvidence: [{ sourceHash, asOfDate: date, registeredAt: availableAt }],
    analysis: {
      asOfDate: date,
      calculatedAt: decisionAt,
      rows,
    } as AnalysisResult,
    snapshot: {
      date,
      asOfDate: date,
      savedAt: availableAt,
      entries: [],
      marketGateStatus: "UNKNOWN",
      totalCount: 0,
      passedCount: 0,
      gradeACount: 0,
      gradeBCount: 0,
    },
  };
}

// Synthetic exact-pair reproduction; no private production observations.
export function publication(date: string): KrModelPublication {
  const p = krSource(date),
    days = DATES.filter((x) => x <= date);
  p.runtimeCodeHash = codeHash;
  p.dataset.tradeDates = ["2026-10-08", ...days];
  p.dataset.kospiGateDates = [...p.dataset.tradeDates];
  p.dataset.observedBars = clone(p.dataset.bars);
  const prior = DATES.filter((x) => x < date).at(-1) ?? "2026-10-08";
  p.universeEvidence.asOfDate = prior;
  for (const row of p.analysis.rows) if (row.etfStrategy) row.etfStrategy.previousDate = prior;
  return p;
}
export interface MemoryData {
  series: Map<string, FrozenModelSeries>;
  sessions: Map<string, OctoberRun>;
  prepared: Map<string, PreparedOctoberPublication>;
  archives: Map<string, KrDailyInputArchive>;
}
export const sessionKey = (id: string, date: string) => id + ":" + date;
export function plainStore(data: MemoryData): OctoberShadowStore {
  const latest = (id: string) =>
    [...data.sessions.values()]
      .filter((x) => x.bookId === id)
      .sort((a, b) => a.receipt.date.localeCompare(b.receipt.date))
      .at(-1) ?? null;
  return {
    readSeries: async (id) => clone(data.series.get(id) ?? null),
    insertSeries: async (value) => {
      assert(!data.series.has(value.bookId));
      data.series.set(value.bookId, clone(value));
    },
    readLatest: async <T>(id: string) => clone(latest(id)) as T | null,
    readSession: async <T>(id: string, date: string) =>
      clone(data.sessions.get(sessionKey(id, date)) ?? null) as T | null,
    readKrInput: async (date, hash) => {
      const v = data.archives.get(date + ":" + hash);
      assert(v);
      return clone(v);
    },
    putKrInput: async (v) => {
      const hash = await hashSeriesValue(v),
        key = v.date + ":" + hash,
        old = data.archives.get(key);
      assert(!old || same(old, v));
      data.archives.set(key, clone(v));
      return { date: v.date, hash };
    },
    readPrepared: async (market, date) => clone(data.prepared.get(market + ":" + date) ?? null),
    prepare: async (v) => {
      const { preparedHash, ...body } = v;
      assert.equal(await hashSeriesValue(body), preparedHash);
      const key = v.market + ":" + v.date,
        old = data.prepared.get(key);
      assert(!old || same(old, v));
      data.prepared.set(key, clone(v));
      return clone(v);
    },
    append: async (series, run, previous) => {
      const key = sessionKey(series.bookId, run.receipt.date),
        old = data.sessions.get(key);
      if (old) {
        assert(same(old, run));
        return { reused: true, stateHash: old.stateHash };
      }
      assert(same(data.series.get(series.bookId), series));
      assert.equal(latest(series.bookId)?.stateHash ?? null, previous?.stateHash ?? null);
      assert.equal(run.previousStateHash, previous?.stateHash ?? null);
      await assertStoredOctoberRun(series, run as unknown as OctoberRun);
      data.sessions.set(key, clone(run as unknown as OctoberRun));
      return { reused: false, stateHash: run.stateHash };
    },
  };
}
const emptyData = (): MemoryData => ({
  series: new Map(),
  sessions: new Map(),
  prepared: new Map(),
  archives: new Map(),
});
async function authority(data: MemoryData): Promise<KrRetrospectiveAuthority> {
  const receipt: KrRetrospectiveAuthority["receipt"] = {
    version: "kr-reviewed-retrospective-source-v1",
    owner: OWNER,
    preparationHash: H("c"),
    capsuleHash: H("d"),
    captureManifestHash: H("e"),
    sourceManifestHash: H("f"),
    captureFinishedAt: "2026-10-28T12:00:00Z",
    originFinalPublicationHash: H("b"),
    originFinalActivatedAt: "2026-10-28T00:00:00Z",
    derivedBasisSourceStatus: "NOT_REGISTERED_AT_PREPARATION",
    preparationRuntimeCodeHash: codeHash,
    runtimeCodeHash: codeHash,
    predecessorDate: "2026-10-23",
    predecessorHeads: KINDS.map((kind) => {
      const bookId = "adopted-shadow-2026-10-12-v1:" + kind;
      return {
        bookId,
        stateHash: data.sessions.get(sessionKey(bookId, "2026-10-23"))!.stateHash,
      };
    }),
    dates: [],
    historicalAvailabilityClaim: false,
  };
  for (const date of DATES.slice(-2)) {
    const p = publication(date);
    receipt.dates.push({
      date,
      sourceHash: p.sourceHash,
      datasetHash: await hashSeriesValue(p.dataset),
      configHash: await hashSeriesValue(p.config),
      evidenceStoredAt: "2026-10-28T13:00:00Z",
      modelAvailableAt: p.availableAt,
      modelDecisionAt: p.decisionAt,
    });
  }
  const registry: KrRetrospectiveAuthority["registry"] = {
    version: "kr-reviewed-retrospective-registry-v1",
    status: "APPROVED",
    policy: KR_RETROSPECTIVE_POLICY,
    receiptHash: await hashSeriesValue(receipt),
  };
  return {
    receipt,
    registry,
    authoritativeRegistryHash: await hashSeriesValue(registry),
  };
}
async function integratedChain(kind: "O1" | "S07") {
  const registry = await integratedRegistry(kind, codeHash),
    results: IntegratedDailyPublication[] = [];
  let previous: IntegratedDailyPublication | null = null;
  for (const date of DATES) {
    const ledger = previous?.result ?? (await createIntegratedAllocationShadow(kind, { codeHash }));
    const sessions: IntegratedAllocationSessionInput[] = (["K", "E", "U"] as const).map(
      (market) => ({
        market,
        date,
        previousSessionDate: ledger.markets[market].lastSessionDate,
        openAt: date + (market === "U" ? "T09:30:00-04:00" : "T09:00:00+09:00"),
        closeAt: date + (market === "U" ? "T16:00:00-04:00" : "T15:30:00+09:00"),
        availableAt: date + (market === "U" ? "T16:01:00-04:00" : "T16:00:00+09:00"),
        decisionAt: date + (market === "U" ? "T16:02:00-04:00" : "T16:10:00+09:00"),
        sourceHash,
        codeHash,
        calendar: { sourceHash, sessions: DATES },
        prices: [],
        rawOnsets: [],
        signals: [],
        signalObservation: "COMPLETE",
        deliveredEntrySignals: [],
      }),
    );
    previous = await prepareIntegratedDailyPublication({
      registry,
      previous,
      date,
      sessions,
      now: "2026-10-28T13:00:00Z",
    });
    results.push(previous);
  }
  return results;
}
async function buildFixture() {
  const data = emptyData(),
    store = plainStore(data);
  for (const kind of KINDS)
    await store.insertSeries(
      await freezeRestartSeries({
        kind,
        frozenAt: "2026-10-09T00:00:00Z",
        codeHash,
        sourceHash,
      }),
    );
  for (const date of DATES.slice(0, -2)) await recordOctoberPublication(store, publication(date));
  const original = clone(data),
    retrospective = await authority(data);
  for (const date of DATES.slice(-2)) {
    const p = publication(date);
    p.reviewedRetrospective = retrospective;
    p.sourceEvidence = [];
    await recordOctoberPublication(store, p);
  }
  const integrated = await Promise.all((["O1", "S07"] as const).map(integratedChain));
  const preparedPublications = DATES.slice(-2).map((d) => data.prepared.get("KR:" + d)!);
  const oldEvidence = {
    date: "2026-10-26",
    synthetic: "retained independently observed evidence",
  };
  const nextEvidence = {
    date: "2026-10-27",
    synthetic: "candidate next evidence",
  };
  const plan: any = {
    version: "kr-adjusted-recovery-full-plan-v1",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    preparationHash: H("c"),
    operationManifestHash: H("d"),
    runtimeHashes: { october: codeHash, integrated: codeHash, kospi: codeHash },
    historyCorrection: {
      role: "HISTORY_ONLY",
      operationalApproval: false,
      synthetic: true,
    },
    retainedIntegrated26EvidenceHash: await hashSeriesValue(oldEvidence),
    integratedNextEvidence: {
      hash: await hashSeriesValue(nextEvidence),
      payload: nextEvidence,
    },
    models: {
      version: "kr-adjusted-ordered-model-plan-v1",
      operationalApproval: false,
      historicalAvailabilityClaim: false,
      originalPrefixPreserved: true,
      expectedNewModelSessions: 12,
      scope: { predecessorDate: "2026-10-23", dates: DATES.slice(-2) },
      retrospectiveAuthorityCandidate: retrospective,
      retrospectiveAuthorityCandidateHash: retrospective.authoritativeRegistryHash,
      vintageAuthorityCandidateHash: H("e"),
      preparedPublications,
      newKrArchives: [...data.archives.values()].filter((a) => DATES.slice(-2).includes(a.date)),
      newAdoptedSessions: preparedPublications.flatMap((p) => p.entries.map((e) => e.run)),
      newIntegratedSessions: integrated.map((chain) => chain.at(-1)!),
      retainedIntegrated26: integrated.map((chain) => ({
        kind: chain.at(-2)!.registry.policy.kind,
        stateHash: chain.at(-2)!.stateHash,
      })),
    },
  };
  plan.executionProvenance = await buildExecutionProvenance(plan);
  return {
    plan,
    original,
    complete: data,
    integrated,
    oldEvidence,
    predecessors: KINDS.map((k) => {
      const series = original.series.get("adopted-shadow-2026-10-12-v1:" + k)!;
      return {
        series,
        run: original.sessions.get(sessionKey(series.bookId, "2026-10-23"))!,
      };
    }),
  };
}
let cached: ReturnType<typeof buildFixture> | undefined;
export async function recoveryFixture() {
  return clone(await (cached ??= buildFixture()));
}
export type RecoveryFixture = Awaited<ReturnType<typeof recoveryFixture>>;
export type Fault = { at: number; mode: "BEFORE" | "AFTER" | "READBACK" };
export async function harness(f: RecoveryFixture) {
  const data = clone(f.original),
    base = plainStore(data),
    evidence = new Map([
      [
        "2026-10-26",
        {
          hash: f.plan.retainedIntegrated26EvidenceHash,
          payload: clone(f.oldEvidence),
        },
      ],
    ]),
    provenance = new Map<SeriesHash, unknown>(),
    integrated = new Map<string, IntegratedDailyPublication>();
  for (const chain of f.integrated)
    for (const v of chain.slice(0, -1))
      integrated.set(v.registry.policy.kind + ":" + v.receipt.date, clone(v));
  const prefix = canonicalSeriesJson([...data.sessions]),
    archivePrefix = canonicalSeriesJson([...data.archives]),
    integratedPrefix = canonicalSeriesJson([...integrated]);
  const attempts: string[] = [],
    commits: string[] = [],
    reads: string[] = [];
  let fault: Fault | null = null,
    lost: string | null = null,
    actualChecks = 0,
    inventoryChecks = 0;
  const read = async <T>(key: string, value: T) => {
    reads.push(key);
    if (lost === key) {
      lost = null;
      throw new Error("SYNTHETIC_READBACK_LOST");
    }
    return clone(value);
  };
  const write = async <T>(key: string, fn: () => Promise<T>) => {
    attempts.push(key);
    const hit = fault?.at === attempts.length;
    if (hit && fault!.mode === "BEFORE") throw new Error("SYNTHETIC_BEFORE_COMMIT");
    const value = await fn();
    commits.push(key);
    if (hit && fault!.mode === "AFTER") throw new Error("SYNTHETIC_COMMITTED_ACK_LOST");
    if (hit && fault!.mode === "READBACK") lost = key;
    return value;
  };
  const store: OctoberShadowStore = {
    ...base,
    readSession: async <T>(id: string, date: string) =>
      read(sessionKey(id, date), await base.readSession(id, date)) as Promise<T | null>,
    putKrInput: async (v) => write("archive:" + v.date, () => base.putKrInput(v)),
    prepare: async (v) => write("prepared:" + v.date, () => base.prepare(v)),
    append: async (s, r, p) =>
      write(sessionKey(s.bookId, r.receipt.date), () => base.append(s, r, p)),
  };
  const approval: RecoveryApplyApproval = {
    version: "kr-adjusted-recovery-apply-approval-v1",
    status: "APPROVED",
    owner: OWNER,
    operationManifestHash: f.plan.operationManifestHash,
    preparationHash: f.plan.preparationHash,
    fullPlanHash: await hashSeriesValue(f.plan),
    runtimeHashes: clone(f.plan.runtimeHashes),
    retrospectiveRegistryHash: f.plan.models.retrospectiveAuthorityCandidateHash,
    vintageAuthorityHash: f.plan.models.vintageAuthorityCandidateHash,
    executionProvenanceHash: await hashSeriesValue(f.plan.executionProvenance),
    historyCorrectionHash: await hashSeriesValue(f.plan.historyCorrection),
    kospiApprovalHash: H("f"),
  };
  const input: ExactModelApplyInput = {
    phase: "APPLY",
    plan: f.plan,
    approval,
    authoritativePlanHash: await hashSeriesValue(f.plan),
    authoritativeApprovalHash: await hashSeriesValue(approval),
    runtimeHashes: clone(f.plan.runtimeHashes),
    owner: OWNER,
    store,
    assertArtifactInventory: async (plan) => {
      inventoryChecks++;
      for (const [key, p] of data.prepared) {
        if (DATES.slice(-2).includes(p.date))
          assert(
            same(
              plan.models.preparedPublications.find((x: any) => x.date === p.date),
              p,
            ),
          );
        else assert(same(f.original.prepared.get(key), p));
      }
      for (const [key, a] of data.archives) {
        if (!f.original.archives.has(key))
          assert(plan.models.newKrArchives.some((x: any) => same(x, a)));
      }
    },
    assertActualLedgersUnchanged: async () => {
      actualChecks++;
    },
    provenance: {
      putImmutable: async (v, h) =>
        write("provenance", async () => {
          const old = provenance.get(h);
          assert(!old || same(old, v));
          provenance.set(h, clone(v));
        }),
      read: async (h) => read("provenance", provenance.get(h)),
    },
    evidence: {
      readKr: async (date) => read("evidence:" + date, evidence.get(date) ?? null),
      putKrImmutable: async (date, payload, hash) =>
        write("evidence:" + date, async () => {
          const v = { payload, hash },
            old = evidence.get(date);
          assert(!old || same(old, v));
          evidence.set(date, clone(v));
        }),
    },
    integrated: {
      read: async (kind) => {
        const v = [...integrated.values()]
          .filter((x) => x.registry.policy.kind === kind)
          .sort((a, b) => a.receipt.date.localeCompare(b.receipt.date))
          .at(-1)!;
        return read("integrated:" + kind, v);
      },
      readSession: async (kind, date) =>
        read("integrated-session:" + kind + ":" + date, integrated.get(kind + ":" + date) ?? null),
      append: async (v, p) =>
        write("integrated:" + v.registry.policy.kind, async () => {
          const old = integrated.get(v.registry.policy.kind + ":" + v.receipt.date);
          assert(!old || same(old, v));
          assert.equal(v.previousStateHash, p.stateHash);
          integrated.set(v.registry.policy.kind + ":" + v.receipt.date, clone(v));
        }),
    },
  };
  return {
    input,
    data,
    evidence,
    provenance,
    integrated,
    attempts,
    commits,
    reads,
    setFault: (v: Fault | null) => {
      fault = v;
    },
    clearFault: () => {
      fault = null;
      lost = null;
    },
    checks: () => ({ actualChecks, inventoryChecks }),
    assertOriginal: () => {
      assert.equal(
        canonicalSeriesJson([...data.sessions].filter(([k]) => f.original.sessions.has(k))),
        prefix,
      );
      assert.equal(
        canonicalSeriesJson([...data.archives].filter(([k]) => f.original.archives.has(k))),
        archivePrefix,
      );
      assert.equal(
        canonicalSeriesJson([...integrated].filter(([k]) => !k.endsWith(":2026-10-27"))),
        integratedPrefix,
      );
      assert(same(evidence.get("2026-10-26")?.payload, f.oldEvidence));
    },
    assertComplete: () => {
      for (const v of f.plan.models.newAdoptedSessions)
        assert(same(data.sessions.get(sessionKey(v.bookId, v.receipt.date)), v));
      for (const v of f.plan.models.newIntegratedSessions)
        assert(same(integrated.get(v.registry.policy.kind + ":" + v.receipt.date), v));
      assert.equal(data.sessions.size, f.original.sessions.size + 10);
      assert.equal(integrated.size, f.integrated.flat().length);
    },
  };
}
export async function repin(h: Awaited<ReturnType<typeof harness>>) {
  h.input.plan.executionProvenance = await buildExecutionProvenance(h.input.plan);
  h.input.authoritativePlanHash = await hashSeriesValue(h.input.plan);
  h.input.approval.fullPlanHash = h.input.authoritativePlanHash;
  h.input.approval.executionProvenanceHash = await hashSeriesValue(
    h.input.plan.executionProvenance,
  );
  h.input.authoritativeApprovalHash = await hashSeriesValue(h.input.approval);
}
