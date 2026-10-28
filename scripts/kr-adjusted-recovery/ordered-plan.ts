/* eslint-disable @typescript-eslint/no-explicit-any */
/** Pure complete model continuation planning. No client, archive write, approval or execution. */
import {
  canonicalSeriesJson,
  hashSeriesValue,
  verifyFrozenSeries,
  type SeriesHash,
  type FrozenModelSeries,
} from "../../src/lib/ledger/modelSeries";
import {
  recordOctoberPublication,
  assertStoredOctoberRun,
  type OctoberRun,
  type PreparedOctoberPublication,
} from "../../src/lib/ledger/octoberShadowPipeline";
import type { OctoberShadowStore } from "../../src/lib/ledger/octoberShadowRepository.server";
import type { KrDailyInputArchive } from "../../src/lib/ledger/octoberShadowArchive";
import type { MarketDataset } from "../../src/lib/engine/dataset";
import type { ScoringConfig } from "../../src/lib/engine/scoring";
import {
  sliceKrDatasetForReplay,
  analyzeKrReplayDataset,
} from "../../src/lib/shadowReplayCalculation";
import { buildSnapshot } from "../../src/lib/screeningSnapshot";
import { currentDateEvidence } from "../kr-vintage-preflight-dated-evidence";
import { nextKrRegularSession } from "../../src/lib/ledger/krShadowDecision";
import {
  verifyKrSourceVintagePrivateApproval,
  type KrSourceVintagePrivateApprovalV2,
} from "../../src/lib/ledger/krSourceVintage";
import {
  adaptIntegratedKrEvidence,
  adaptIntegratedUsSession,
  type IntegratedKrEvidence,
} from "../../src/lib/integratedAllocationReplayAdapter";
import {
  prepareIntegratedDailyPublication,
  type IntegratedDailyPublication,
} from "../../src/lib/integratedAllocationPublication";
import {
  prepareIntegratedEquivalenceProof,
  type IntegratedEquivalenceInputs,
  type IntegratedEquivalenceProof,
} from "../../src/lib/integratedAllocationEquivalence";
import {
  verifyKrRetrospectiveAuthority,
  type KrRetrospectiveAuthority,
} from "../../src/lib/ledger/krRetrospectivePublication";
import { verifyPreparationPayload } from "./verify";
import { requireCheck } from "../kr-vintage-preflight/transport";
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const KINDS = ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "ETF_V02", "KR_KOSPI_CONFIRM1_BEAR"];
export interface OrderedRecoveryInput {
  preparation: any;
  preparationHash: SeriesHash;
  dataset: MarketDataset;
  config: ScoringConfig;
  runtimeCodeHash: SeriesHash;
  vintageAuthorityCandidate: KrSourceVintagePrivateApprovalV2;
  retrospectiveAuthorityCandidate: KrRetrospectiveAuthority;
  predecessors: Array<{ series: FrozenModelSeries; run: OctoberRun; payloadHash: SeriesHash }>;
  archives: Array<{ hash: SeriesHash; payload: KrDailyInputArchive }>;
  integrated26: IntegratedEquivalenceInputs;
  integrated26Proof: IntegratedEquivalenceProof;
  integratedUsNext: IntegratedEquivalenceInputs["usCurrent"];
  integratedUsNextHash: SeriesHash;
}
/** In-memory adapter deliberately has no path to any external writer. */
export async function createRecoveryMemoryStore(
  input: Pick<OrderedRecoveryInput, "predecessors" | "archives">,
) {
  const series = new Map<string, FrozenModelSeries>(),
    runs = new Map<string, OctoberRun>(),
    archives = new Map<string, KrDailyInputArchive>(),
    prepared = new Map<string, PreparedOctoberPublication>();
  const initial = new Map<string, string>(),
    appended: OctoberRun[] = [],
    newArchives: KrDailyInputArchive[] = [];
  for (const pin of input.predecessors) {
    await verifyFrozenSeries(pin.series);
    await assertStoredOctoberRun(pin.series, pin.run);
    requireCheck(
      (await hashSeriesValue(pin.run)) === pin.payloadHash && !series.has(pin.series.bookId),
    );
    series.set(pin.series.bookId, structuredClone(pin.series));
    const key = pin.series.bookId + ":" + pin.run.receipt.date;
    runs.set(key, structuredClone(pin.run));
    initial.set(key, canonicalSeriesJson(pin.run));
  }
  const predecessorDate = input.predecessors[0]?.run.receipt.date;
  requireCheck(
    predecessorDate && input.predecessors.every((p) => p.run.receipt.date === predecessorDate),
  );
  const first = nextKrRegularSession(predecessorDate);
  requireCheck(first);
  const second = nextKrRegularSession(first);
  requireCheck(second);
  const targets = new Set([first, second]),
    archiveDates = new Set<string>();
  for (const a of input.archives) {
    requireCheck(!archiveDates.has(a.payload.date) && a.payload.date <= predecessorDate);
    archiveDates.add(a.payload.date);
    requireCheck(
      (await hashSeriesValue(a.payload)) === a.hash && !archives.has(a.payload.date + ":" + a.hash),
    );
    archives.set(a.payload.date + ":" + a.hash, structuredClone(a.payload));
  }
  const latest = (id: string) =>
    [...runs.values()]
      .filter((r) => r.bookId === id)
      .sort((a, b) => a.receipt.date.localeCompare(b.receipt.date))
      .at(-1) ?? null;
  const store: OctoberShadowStore = {
    readSeries: async (id) => structuredClone(series.get(id) ?? null),
    insertSeries: async () => {
      throw new Error("RECOVERY_CANNOT_INITIALIZE_SERIES");
    },
    readLatest: async <T>(id: string) => structuredClone(latest(id)) as T | null,
    readSession: async <T>(id: string, date: string) =>
      structuredClone(runs.get(id + ":" + date) ?? null) as T | null,
    readKrInput: async (date, hash) => {
      const v = archives.get(date + ":" + hash);
      requireCheck(v);
      return structuredClone(v);
    },
    putKrInput: async (value) => {
      const hash = await hashSeriesValue(value),
        key = value.date + ":" + hash;
      if (!archives.has(key)) {
        requireCheck(
          targets.has(value.date) &&
            ![...archives.keys()].some((k) => k.startsWith(value.date + ":")),
        );
        archives.set(key, structuredClone(value));
        newArchives.push(structuredClone(value));
      }
      return { date: value.date, hash };
    },
    readPrepared: async (market, date) =>
      structuredClone(prepared.get(market + ":" + date) ?? null),
    prepare: async (value) => {
      const { preparedHash, ...body } = value;
      requireCheck(
        value.market === "KR" &&
          targets.has(value.date) &&
          (await hashSeriesValue(body)) === preparedHash,
      );
      const key = value.market + ":" + value.date,
        old = prepared.get(key);
      requireCheck(!old || same(old, value));
      prepared.set(key, structuredClone(value));
      return structuredClone(value);
    },
    append: async (seriesValue, run, previous) => {
      const key = run.bookId + ":" + run.receipt.date,
        old = runs.get(key);
      if (old) {
        requireCheck(same(old, run));
        return { reused: true, stateHash: old.stateHash };
      }
      requireCheck(
        same(series.get(seriesValue.bookId), seriesValue) &&
          previous !== null &&
          run.previousStateHash === previous.stateHash &&
          run.receipt.date === nextKrRegularSession(previous.receipt.date) &&
          (latest(seriesValue.bookId)?.stateHash ?? null) === previous.stateHash,
      );
      await assertStoredOctoberRun(seriesValue, run as unknown as OctoberRun);
      runs.set(key, structuredClone(run as unknown as OctoberRun));
      appended.push(structuredClone(run as unknown as OctoberRun));
      return { reused: false, stateHash: run.stateHash };
    },
  };
  return {
    store,
    appended,
    newArchives,
    prepared,
    assertPrefix: () => {
      for (const [key, value] of initial)
        requireCheck(canonicalSeriesJson(runs.get(key)) === value);
    },
  };
}
function modeledClock(date: string) {
  const next = nextKrRegularSession(date);
  requireCheck(next);
  return { availableAt: `${next}T08:00:00+09:00`, decisionAt: `${next}T08:10:00+09:00` };
}
export async function planOrderedKrRecovery(input: OrderedRecoveryInput) {
  const p = input.preparation,
    scope = p.scope;
  requireCheck(
    (await verifyPreparationPayload(p, p.planHash, p.capsuleHash)) === input.preparationHash,
  );
  requireCheck(
    (await hashSeriesValue(p)) === input.preparationHash &&
      p.operationalApproval === false &&
      p.historicalAvailabilityClaim === false,
  );
  requireCheck(
    p.runtimeHashes.october === input.runtimeCodeHash &&
      (await hashSeriesValue(input.dataset)) === p.candidate.datasetHash,
  );
  requireCheck(
    same(
      input.predecessors.map((x) => x.series.policy.kind),
      KINDS,
    ) && input.predecessors.every((x) => x.run.receipt.date === scope.predecessorDate),
  );
  for (const item of input.predecessors) {
    const pin = p.modelPins.find((m: any) => m.seriesId === item.series.bookId);
    requireCheck(
      pin && pin.stateHash === item.run.stateHash && pin.payloadHash === item.payloadHash,
    );
  }
  requireCheck(input.archives.length === p.archiveReferences.length);
  for (const a of input.archives)
    requireCheck(
      p.archiveReferences.some((r: any) => r.date === a.payload.date && r.payloadHash === a.hash),
    );
  requireCheck(
    same(input.vintageAuthorityCandidate.receipt, p.vintageReviewProposal) &&
      same(input.vintageAuthorityCandidate.predecessor, {
        registry: p.vintageV1.registry,
        receipt: p.vintageV1.receipt,
      }),
  );
  await verifyKrSourceVintagePrivateApproval(input.vintageAuthorityCandidate);
  requireCheck(
    same(await prepareIntegratedEquivalenceProof(input.integrated26), input.integrated26Proof) &&
      same(input.integrated26Proof, p.integrated26),
  );
  requireCheck(
    (await hashSeriesValue(input.integratedUsNext)) === input.integratedUsNextHash &&
      input.integratedUsNext.analysis.date === scope.dates[1],
  );
  const retrospective = await verifyKrRetrospectiveAuthority(input.retrospectiveAuthorityCandidate);
  requireCheck(
    retrospective.receipt.preparationHash === input.preparationHash &&
      retrospective.receipt.capsuleHash === p.capsuleHash &&
      retrospective.receipt.runtimeCodeHash === input.runtimeCodeHash &&
      retrospective.receipt.preparationRuntimeCodeHash === p.runtimeHashes.october &&
      retrospective.receipt.captureManifestHash === p.captureManifestHash &&
      retrospective.receipt.sourceManifestHash === p.sourceRosterHash &&
      retrospective.receipt.captureFinishedAt === p.captureObservedAt &&
      retrospective.receipt.originFinalPublicationHash === p.finalPublication.publicationHash &&
      retrospective.receipt.originFinalActivatedAt === p.clockSemantics.sourceRegisteredAt &&
      retrospective.receipt.predecessorDate === scope.predecessorDate &&
      same(
        retrospective.receipt.dates.map((d) => d.date),
        scope.dates,
      ),
  );
  for (const pin of retrospective.receipt.predecessorHeads)
    requireCheck(
      input.predecessors.some(
        (x) => x.series.bookId === pin.bookId && x.run.stateHash === pin.stateHash,
      ),
    );
  const memory = await createRecoveryMemoryStore(input),
    codeHash = input.predecessors[0]!.series.codeHash;
  requireCheck(input.predecessors.every((x) => x.series.codeHash === codeHash));
  const previousAnalysis = analyzeKrReplayDataset(
    sliceKrDatasetForReplay(input.dataset, scope.predecessorDate),
    input.config,
  );
  let previousSnapshot = {
    ...buildSnapshot(previousAnalysis.analysis),
    savedAt: modeledClock(scope.predecessorDate).availableAt,
  };
  for (const date of scope.dates) {
    const { analysis, dataset } = analyzeKrReplayDataset(
        sliceKrDatasetForReplay(input.dataset, date),
        input.config,
      ),
      clock = modeledClock(date);
    const snapshot = { ...buildSnapshot(analysis), savedAt: clock.availableAt },
      sourceHash = await hashSeriesValue(currentDateEvidence(dataset, snapshot));
    const evidence = p.candidate.evidence.find((e: any) => e.payload.date === date);
    requireCheck(evidence && evidence.payload.clock.sourceHash === sourceHash);
    const current = new Set(snapshot.entries.map((e) => e.symbol)),
      priorSymbols = previousSnapshot.entries.map((e) => e.symbol).filter((s) => current.has(s));
    await recordOctoberPublication(memory.store, {
      market: "KR",
      sourceVintageApproval: input.vintageAuthorityCandidate,
      reviewedRetrospective: input.retrospectiveAuthorityCandidate,
      dataset,
      analysis,
      snapshot,
      config: input.config,
      codeHash,
      runtimeCodeHash: input.runtimeCodeHash,
      sourceHash,
      ...clock,
      confirmedRegularClose: true,
      failedSymbols: 0,
      universeEvidence: {
        asOfDate: previousSnapshot.asOfDate,
        sourceHash: await hashSeriesValue(previousSnapshot),
        symbols: [...new Set(priorSymbols.length ? priorSymbols : [...current])].sort(),
      },
      sourceEvidence: [],
    });
    previousSnapshot = snapshot;
  }
  requireCheck(
    memory.appended.length === 10 && memory.prepared.size === 2 && memory.newArchives.length === 2,
  );
  memory.assertPrefix();
  const candidateNext = p.candidate.evidence.find((e: any) => e.payload.date === scope.dates[1])
    .payload as IntegratedKrEvidence;
  const history = [...input.integrated26.history, input.integrated26.original],
    integrated: IntegratedDailyPublication[] = [];
  for (const book of input.integrated26.books) {
    const previous = book.completed,
      sessions = [
        adaptIntegratedKrEvidence(previous.result, {
          market: "K",
          evidence: candidateNext,
          history,
        }),
        adaptIntegratedKrEvidence(previous.result, {
          market: "E",
          evidence: candidateNext,
          history,
        }),
        adaptIntegratedUsSession(previous.result, {
          analysis: input.integratedUsNext.analysis,
          previousAnalysis: input.integrated26.usCurrent.analysis,
          clock: input.integratedUsNext.clock,
        }),
      ];
    integrated.push(
      await prepareIntegratedDailyPublication({
        registry: previous.registry,
        previous,
        date: scope.dates[1],
        sessions,
        now: p.preparedAt,
      }),
    );
  }
  requireCheck(
    integrated.length === 2 && integrated.every((x) => x.receipt.date === scope.dates[1]),
  );
  const result = {
    version: "kr-adjusted-ordered-model-plan-v1",
    preparationHash: input.preparationHash,
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    scope,
    originalPrefixPreserved: true,
    retainedIntegrated26: input.integrated26.books.map((b) => ({
      kind: b.kind,
      stateHash: b.completed.stateHash,
    })),
    retrospectiveAuthorityCandidate: input.retrospectiveAuthorityCandidate,
    retrospectiveAuthorityCandidateHash: retrospective.registryHash,
    vintageAuthorityCandidateHash: await hashSeriesValue(input.vintageAuthorityCandidate),
    preparedPublications: [...memory.prepared.values()],
    newKrArchives: memory.newArchives,
    newAdoptedSessions: memory.appended,
    newIntegratedSessions: integrated,
    expectedNewModelSessions: 12,
    usNextHash: input.integratedUsNextHash,
  };
  return { result, hash: await hashSeriesValue(result) };
}
