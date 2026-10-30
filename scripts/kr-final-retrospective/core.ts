/** Pure bounded planning. No client, filesystem, credentials or live mutation. */
import type { ModelJournalRun } from "../../src/lib/ledger/modelJournal";
import { canonicalSeriesJson, hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import {
  KR_RETROSPECTIVE_POLICY,
  verifyKrRetrospectiveAuthority,
  type KrRetrospectiveAuthority,
} from "../../src/lib/ledger/krRetrospectivePublication";
import { verifyKrSourceVintagePrivateApproval } from "../../src/lib/ledger/krSourceVintage";
import { recordOctoberPublication } from "../../src/lib/ledger/octoberShadowPipeline";
import { nextKrRegularSession } from "../../src/lib/ledger/krShadowDecision";
import {
  analyzeKrReplayDataset,
  sliceKrDatasetForReplay,
} from "../../src/lib/shadowReplayCalculation";
import { buildSnapshot } from "../../src/lib/screeningSnapshot";
import { currentDateEvidence } from "../kr-vintage-preflight-dated-evidence";
import { createRecoveryMemoryStore } from "../kr-adjusted-recovery/ordered-plan";
import { prepareKospiFinalRetrospective } from "../kospi-final-retrospective-preparation";
import { kospiRetrospectiveApprovalCandidate } from "../kospi-final-retrospective-apply";
import { FINAL_COMPUTE_STAGES, type FinalCapture, type FinalComputeStage } from "./contracts";
import { captureCanonicalProof, hydrateFinalCapture } from "./capture-codec";
import { KOSPI_SHADOW_NAMESPACE } from "../../src/lib/kospiShadowStore";
import { KOSPI_SHADOW_CORRECTION_REVISION_ID } from "../../src/lib/kospiShadowSeries";

export const KINDS = ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "ETF_V02", "KR_KOSPI_CONFIRM1_BEAR"];
export const DATES = ["2026-10-28", "2026-10-29"];
export const PREDECESSOR = "2026-10-27";
export const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
export function check(v: unknown, code: string): asserts v {
  if (!v) throw new Error(`FINAL_RETROSPECTIVE_${code}`);
}
const H = /^sha256:[a-f0-9]{64}$/;
/** These clocks are modeled decisions ONLY, never assertions of historical availability. */
function modeledClock(date: string) {
  const next = nextKrRegularSession(date);
  check(next, "SESSION_DATE");
  return { availableAt: `${next}T08:00:00+09:00`, decisionAt: `${next}T08:10:00+09:00` };
}
export async function prepareFinalRetrospective(
  storedCapture: FinalCapture,
  phase: (stage: FinalComputeStage) => void = () => {},
) {
  phase("HYDRATE");
  const c = await hydrateFinalCapture(storedCapture);
  phase("IDENTITY");
  check(
    c.version === "kr-final-retrospective-capture-v1" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(c.owner),
    "CAPTURE_IDENTITY",
  );
  check(
    /^[a-f0-9]{40}$/.test(c.codeCommit) &&
      same(Object.keys(c.runtimeHashes).sort(), ["kospi", "october"]) &&
      Object.values(c.runtimeHashes).every((h) => H.test(h)),
    "RUNTIME",
  );
  check(
    c.dataset.isLive &&
      c.dataset.asOfDate === DATES[1] &&
      c.finalPublication.asOfDate === DATES[1] &&
      H.test(c.finalPublication.hash),
    "FINAL_HORIZON",
  );
  check(
    Number.isFinite(Date.parse(c.computedAt)) &&
      Date.parse(c.computedAt) >= Date.parse(c.capturedAt) &&
      Date.parse(c.capturedAt) >= Date.parse(c.finalPublication.activatedAt) &&
      Date.parse(c.finalPublication.activatedAt) >= Date.parse(DATES[1] + "T06:30:00Z"),
    "ACTUAL_CLOCKS",
  );
  check(
    same(
      c.predecessors.map((x) => x.series.policy.kind),
      KINDS,
    ) && c.predecessors.every((x) => x.run.receipt.date === PREDECESSOR),
    "EXACT_FIVE_PREDECESSORS",
  );
  phase("SOURCE_AUTHORITY");
  await verifyKrSourceVintagePrivateApproval(c.sourceVintageApproval);
  phase("CAPTURE_HASHES");
  // The stored compact identity and fully restored original identity are distinct.
  const captureHash = captureCanonicalProof(storedCapture).hash;
  const decodedCaptureHash = captureCanonicalProof(c).hash;
  const sourceManifestHash = await hashSeriesValue(c.sourceManifest);
  const captureManifestHash = await hashSeriesValue(c.captureManifest);
  const datasetHash = captureCanonicalProof(c.dataset).hash;
  const configHash = await hashSeriesValue(c.config);
  // This derived analytical basis is NOT a registered source. Registered originals remain untouched.
  const basis = {
    version: "kr-final-retrospective-derived-basis-v1",
    sourceManifestHash,
    captureManifestHash,
    datasetHash,
    configHash,
    historicalAvailabilityClaim: false,
    sourceRegistryMutation: false,
  };
  const basisHash = await hashSeriesValue(basis);
  const preparation = {
    version: "kr-final-retrospective-preparation-v1",
    captureHash,
    decodedCaptureHash,
    owner: c.owner,
    codeCommit: c.codeCommit,
    runtimeHashes: c.runtimeHashes,
    scope: { predecessorDate: PREDECESSOR, dates: DATES, kinds: KINDS },
    basis,
    basisHash,
    computedAt: c.computedAt,
    capturedAt: c.capturedAt,
    preservationBaseline: c.preservationBaseline,
    historicalAvailabilityClaim: false,
    operationalApproval: false,
  };
  const preparationHash = await hashSeriesValue(preparation);
  const analyses = DATES.map((date, index) => {
    phase(index === 0 ? "ANALYZE_28" : "ANALYZE_29");
    return analyzeKrReplayDataset(sliceKrDatasetForReplay(c.dataset, date), c.config);
  });
  phase("SNAPSHOTS");
  const snapshots = analyses.map((x, i) => ({
    ...buildSnapshot(x.analysis),
    savedAt: modeledClock(DATES[i]!).availableAt,
  }));
  phase("DATE_PROOFS");
  const dateProofs = await Promise.all(
    analyses.map(async (x, i) => ({
      date: DATES[i]!,
      sourceHash: await hashSeriesValue(currentDateEvidence(x.dataset, snapshots[i]!)),
      datasetHash: captureCanonicalProof(x.dataset).hash,
      configHash,
      evidenceStoredAt: c.computedAt,
      modelAvailableAt: modeledClock(DATES[i]!).availableAt,
      modelDecisionAt: modeledClock(DATES[i]!).decisionAt,
    })),
  );
  phase("RETROSPECTIVE_AUTHORITY");
  const receipt: KrRetrospectiveAuthority["receipt"] = {
    version: "kr-reviewed-retrospective-source-v1",
    owner: c.owner,
    preparationHash,
    capsuleHash: captureHash,
    captureManifestHash,
    sourceManifestHash,
    captureFinishedAt: c.capturedAt,
    originFinalPublicationHash: c.finalPublication.hash,
    originFinalActivatedAt: c.finalPublication.activatedAt,
    derivedBasisSourceStatus: "NOT_REGISTERED_AT_PREPARATION",
    preparationRuntimeCodeHash: c.runtimeHashes.october,
    runtimeCodeHash: c.runtimeHashes.october,
    predecessorDate: PREDECESSOR,
    predecessorHeads: c.predecessors.map((x) => ({
      bookId: x.series.bookId,
      stateHash: x.run.stateHash,
    })),
    dates: dateProofs,
    historicalAvailabilityClaim: false,
  };
  const registry: KrRetrospectiveAuthority["registry"] = {
    version: "kr-reviewed-retrospective-registry-v1",
    status: "APPROVED",
    policy: KR_RETROSPECTIVE_POLICY,
    receiptHash: await hashSeriesValue(receipt),
  };
  const retrospectiveAuthorityCandidate = {
    receipt,
    registry,
    authoritativeRegistryHash: await hashSeriesValue(registry),
  };
  await verifyKrRetrospectiveAuthority(retrospectiveAuthorityCandidate);
  // Existing target-date archives may have been staged by another completed
  // consumer (e.g. integrated). Preserve them in the captured full inventory;
  // they are not predecessor inputs and must never be overwritten or relabeled.
  phase("ARCHIVE_VERIFY");
  for (const archive of c.archives)
    check((await hashSeriesValue(archive.payload)) === archive.hash, "CAPTURED_ARCHIVE_HASH");
  // Only exact immutable predecessor references are analytical inputs. Other
  // valid variants remain captured/preserved, but date equality grants no use.
  const referencedArchives = new Map<string, FinalCapture["archives"][number]>();
  for (const { run } of c.predecessors) {
    if (!("frozenInputArchive" in run) || !run.frozenInputArchive) continue;
    for (const ref of run.frozenInputArchive.days) {
      const matches = c.archives.filter(
        (archive) => archive.payload.date === ref.date && archive.hash === ref.hash,
      );
      check(matches.length === 1, "PREDECESSOR_ARCHIVE_REFERENCE");
      referencedArchives.set(`${ref.date}:${ref.hash}`, matches[0]!);
    }
  }
  phase("PREDECESSOR_MEMORY");
  const memory = await createRecoveryMemoryStore({
    predecessors: c.predecessors,
    archives: [...referencedArchives.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, archive]) => archive),
  });
  const codeHash = c.predecessors[0]!.series.codeHash;
  check(
    c.predecessors.every((x) => x.series.codeHash === codeHash),
    "FROZEN_RUNTIME",
  );
  // Diagnostics wrap only the local in-memory adapter; preserve arguments/results.
  const originalReadLatest = memory.store.readLatest;
  memory.store.readLatest = async <T extends ModelJournalRun>(id: string): Promise<T | null> => {
    const index = c.predecessors.findIndex((x) => x.series.bookId === id);
    if (index >= 0 && index < 5) phase(`MODEL_READ_${index}` as FinalComputeStage);
    return originalReadLatest<T>(id);
  };
  const originalAppend = memory.store.append;
  memory.store.append = async (...args) => {
    const index = c.predecessors.findIndex((x) => x.series.bookId === args[0].bookId);
    if (index >= 0 && index < 5) phase(`MODEL_APPEND_${index}` as FinalComputeStage);
    return originalAppend(...args);
  };
  phase("PRIOR_ANALYSIS");
  const prior = analyzeKrReplayDataset(sliceKrDatasetForReplay(c.dataset, PREDECESSOR), c.config);
  let previousSnapshot = {
    ...buildSnapshot(prior.analysis),
    savedAt: modeledClock(PREDECESSOR).availableAt,
  };
  for (let i = 0; i < DATES.length; i++) {
    const date = DATES[i]!,
      { dataset, analysis } = analyses[i]!,
      snapshot = snapshots[i]!;
    const current = new Set(snapshot.entries.map((e) => e.symbol));
    const priorSymbols = previousSnapshot.entries
      .map((e) => e.symbol)
      .filter((s) => current.has(s));
    phase(i === 0 ? "ADOPTED_28" : "ADOPTED_29");
    await recordOctoberPublication(memory.store, {
      market: "KR",
      sourceVintageApproval: c.sourceVintageApproval,
      reviewedRetrospective: retrospectiveAuthorityCandidate,
      dataset,
      analysis,
      snapshot,
      config: c.config,
      codeHash,
      runtimeCodeHash: c.runtimeHashes.october,
      sourceHash: dateProofs[i]!.sourceHash,
      ...modeledClock(date),
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
  phase("PREFIX_CHECK");
  memory.assertPrefix();
  check(
    memory.appended.length === 10 && memory.prepared.size === 2 && memory.newArchives.length === 2,
    "EXACT_MODEL_SCOPE",
  );
  phase("LEGACY_CAPTURE");
  const originalApprovalPath = `${c.owner}/${KOSPI_SHADOW_NAMESPACE}/correction-approvals/${KOSPI_SHADOW_CORRECTION_REVISION_ID}.json`;
  check(c.legacyObjects[originalApprovalPath], "ORIGINAL_CORRECTION_APPROVAL");
  for (const value of Object.values(c.legacyObjects))
    check((await hashSeriesValue(value.payload)) === value.hash, "LEGACY_CAPTURE_HASH");
  // Preparation accepts journal objects only; APPLY additionally requires the
  // original immutable correction approval, retained separately in the envelope.
  const legacyJournal = Object.fromEntries(
    Object.entries(c.legacyObjects).filter(([path]) => path !== originalApprovalPath),
  );
  phase("LEGACY_PREPARE");
  const legacy = await prepareKospiFinalRetrospective(
    {
      baselineDataset: c.dataset,
      adjustedDataset: c.dataset,
      scoringConfig: c.config,
      objects: legacyJournal,
      authority: {
        owner: c.owner,
        predecessorDate: PREDECESSOR,
        targetDates: DATES,
        baselineSourceHash: sourceManifestHash,
        adjustedBasisHash: basisHash,
        sourceManifestHash,
        captureManifestHash,
        baselineCollectedAt: c.finalPublication.activatedAt,
        adjustedCapturedAt: c.capturedAt,
        computedAt: c.computedAt,
        codeVersion: c.codeCommit,
        runtimeCodeHash: c.runtimeHashes.kospi,
      },
    },
    (stage) => {
      if ((FINAL_COMPUTE_STAGES as readonly string[]).includes(stage))
        phase(stage as FinalComputeStage);
    },
  );
  phase("LEGACY_BOUNDARY");
  check(legacy.status === "PREPARED_FOR_INDEPENDENT_REVIEW", "LEGACY_BOUNDARY_BLOCKED");
  // Compatibility envelope for the existing narrow helper; no old adjusted operation or authority is reused.
  phase("PLAN_ASSEMBLE");
  const legacyReceipt = {
    version: "kr-adjusted-recovery-preparation-v1" as const,
    kind: "RECOVERY_PREPARATION_ONLY" as const,
    operationalApproval: false as const,
    historicalAvailabilityClaim: false as const,
    independentFinalPreparation: preparation,
    kospi: {
      capturedObjects: Object.entries(c.legacyObjects).map(([path, x]) => ({ path, ...x })),
      result: legacy,
    },
  };
  const legacyReceiptHash = await hashSeriesValue(legacyReceipt);
  const legacyApprovalCandidate = kospiRetrospectiveApprovalCandidate(legacyReceiptHash, legacy);
  return {
    version: "kr-final-retrospective-plan-v1" as const,
    operationalApproval: false as const,
    historicalAvailabilityClaim: false as const,
    preparation,
    preparationHash,
    captureHash,
    sourceManifest: c.sourceManifest,
    captureManifest: c.captureManifest,
    predecessors: c.predecessors,
    sourceVintageApproval: c.sourceVintageApproval,
    retrospectiveAuthorityCandidate,
    newAdoptedSessions: memory.appended,
    newArchives: memory.newArchives,
    preparedPublications: [...memory.prepared.values()],
    legacyReceipt,
    legacyReceiptHash,
    legacyApprovalCandidate,
    legacyApprovalHash: await hashSeriesValue(legacyApprovalCandidate),
    expectedNewModelSessions: 10,
    expectedNewLegacySessions: 2,
    sourceRegistryMutation: false,
    integratedMutation: false,
    actualMutation: false,
  };
}
export type FinalPlan = Awaited<ReturnType<typeof prepareFinalRetrospective>>;
