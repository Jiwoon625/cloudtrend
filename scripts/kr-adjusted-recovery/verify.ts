/* eslint-disable @typescript-eslint/no-explicit-any */
import { canonicalSeriesJson, hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { economicSessionInputs } from "../../src/lib/integratedAllocationEquivalence";
import { validateSourceText } from "../../src/lib/sourceData";
import { requireCheck, rawHash } from "../kr-vintage-preflight/transport";
import { diagnoseKospiCompletedBoundary } from "../kospi-boundary-diagnostic";
import { shadowObjectPath } from "../../src/lib/kospiShadowStore";
import { kospiShadowRevisionPath } from "../../src/lib/kospiShadowSeries";
import { verifyArchiveObservationInventory } from "./archive-domain";
import type { ComputationPhase } from "../kr-vintage-preflight/phases";
const equal = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
/** Rehash the generated private receipt after pure-child exit, before any credentialed append. */
export async function verifyPreparationPayload(
  p: any,
  planHash: string,
  capsuleHash: string,
  phase: (value: ComputationPhase) => void = () => {},
) {
  phase("RECEIPT_TYPE_AND_AUTHORITY");
  requireCheck(
    p.version === "kr-adjusted-recovery-preparation-v1" &&
      p.kind === "RECOVERY_PREPARATION_ONLY" &&
      p.status === "REVIEW_REQUIRED" &&
      p.operationalApproval === false &&
      p.historicalAvailabilityClaim === false &&
      p.planHash === planHash &&
      p.capsuleHash === capsuleHash,
  );
  phase("RECEIPT_CLOCK_EXPOSURE_COVERAGE");
  requireCheck(
    p.clockSemantics?.mode === "RETROSPECTIVE_MODEL_CLOCK" &&
      p.clockSemantics.historicalAvailabilityClaim === false &&
      p.clockSemantics.originalCompletedEvidenceClockRetainedForCounterfactual === true &&
      p.clockSemantics.modelEvaluationAt === p.preparedAt &&
      p.clockSemantics.evaluationClockIsFixedNotWallClock === true &&
      p.clockSemantics.actualExecutionTimingEvidence ===
        "AUTHENTICATED_ACTIONS_JOB_TIMESTAMPS_AND_ARCHIVE_RECORDED_AT" &&
      p.clockSemantics.adjustedCaptureObservedAt === p.captureObservedAt &&
      [
        p.preparedAt,
        p.captureObservedAt,
        p.clockSemantics.sourceRegisteredAt,
        p.clockSemantics.modeledNextAvailableAt,
        p.clockSemantics.modeledNextDecisionAt,
      ].every((v) => typeof v === "string" && Number.isFinite(Date.parse(v))) &&
      Date.parse(p.preparedAt) >= Date.parse(p.captureObservedAt) &&
      p.exposureCheck?.capturedAdoptedResultTrees === "NO_TARGET_EXPOSURE" &&
      p.exposureCheck.cumulativeKrAndIntegratedHistory === "NO_TARGET_EXPOSURE" &&
      p.exposureCheck.etfAndConfirmationPastDayLocalRecords === "NOT_CAPTURED_NOT_CLAIMED" &&
      p.exposureCheck.completeHistoricalApproval === false &&
      p.historicalCoverage?.targetComplete === true &&
      Array.isArray(p.historicalCoverage.missingOtherRows) &&
      p.historicalCoverage.allOtherArchivedRowsCovered ===
        (p.historicalCoverage.missingOtherRows.length === 0),
  );
  phase("RECEIPT_ARCHIVE_PAIR_SET");
  requireCheck(
    p.scope.dates.length === 2 &&
      p.modelPins.length === 5 &&
      p.archiveReferences.length === 13 &&
      p.archivePairs.length === 13 &&
      equal(
        p.archivePairs.map((r: any) => r.date).sort(),
        p.archiveReferences.map((r: any) => r.date).sort(),
      ),
  );
  phase("RECEIPT_ARCHIVE_PAIR_HASHES");
  for (const pair of [...p.archivePairs, ...p.retainedPairs])
    requireCheck(
      (await hashSeriesValue(pair.archived)) === pair.archivedHash &&
        (await hashSeriesValue(pair.incoming)) === pair.incomingHash &&
        pair.archivedHash !== pair.incomingHash,
    );
  phase("RECEIPT_RETAINED_APPROVAL_OVERLAY");
  requireCheck(
    (await hashSeriesValue(p.candidate.overlay)) === p.candidate.overlayHash &&
      p.vintageReviewProposal.parentReceiptHash === p.vintageV1.receiptHash &&
      equal(p.vintageReviewProposal.reviews.slice(0, 2), p.vintageV1.receipt.reviews),
  );
  phase("RECEIPT_CORRECTION_DISPOSITION");
  const correction = p.candidate.historyCorrection;
  requireCheck(
    correction.role === "HISTORY_ONLY" &&
      correction.disposition ===
        "FROZEN_BUNDLE_RECONSTRUCTION_ONLY_NOT_CURRENT_SOURCE_REGISTRATION" &&
      correction.requiresCurrentActiveFieldMaskReview === true &&
      correction.symbol === p.scope.symbol &&
      correction.maxDate <= p.scope.predecessorDate &&
      rawHash(correction.csv) === correction.fileHash,
  );
  phase("RECEIPT_CORRECTION_CSV_IDENTITY");
  const v = await validateSourceText(correction.csv, "reviewed-history-correction.csv");
  requireCheck(
    v.valid &&
      v.dataHash === correction.dataHash &&
      v.schemaHash === correction.schemaHash &&
      v.stats.rowCount === correction.rowCount &&
      v.stats.minDate === correction.minDate &&
      v.stats.maxDate === correction.maxDate &&
      v.rows.every(
        (r) =>
          r.symbol === p.scope.symbol && r.type === "STOCK" && r.date <= p.scope.predecessorDate,
      ),
  );
  phase("RECEIPT_DATED_EVIDENCE_HASHES");
  for (const e of p.candidate.evidence) requireCheck(e.hash === (await hashSeriesValue(e.payload)));
  phase("RECEIPT_EQUIVALENCE_LINKAGE");
  const proof = p.integrated26;
  requireCheck(
    proof.candidateEvidenceHash === p.candidate.evidence[0].hash &&
      proof.date === p.scope.dates[0] &&
      equal(
        proof.books.map((b: any) => b.kind),
        ["O1", "S07"],
      ),
  );
  phase("RECEIPT_EXACT_ECONOMIC_PROOF");
  for (const b of proof.books) {
    requireCheck(
      (await hashSeriesValue(b.baselineSessions)) === b.baselineSessionsHash &&
        (await hashSeriesValue(b.candidateSessions)) === b.candidateSessionsHash &&
        equal(
          economicSessionInputs(b.baselineSessions),
          economicSessionInputs(b.candidateSessions),
        ) &&
        (await hashSeriesValue(economicSessionInputs(b.baselineSessions))) ===
          b.economicSessionInputsHash,
    );
  }
  phase("RECEIPT_KOSPI_OBJECT_COUNT");
  requireCheck(
    p.kospi.capturedObjects.length === 19 && p.kospi.stateHashesIndependentlyApproved === false,
  );
  phase("RECEIPT_KOSPI_OBJECT_HASHES");
  for (const o of p.kospi.capturedObjects)
    requireCheck(o.hash === (await hashSeriesValue(o.payload)) && o.stateHashPreapproved === false);
  phase("RECEIPT_KOSPI_BOUNDARY_DIAGNOSTIC");
  await verifyPreparationKospiBoundary(p);
  phase("RECEIPT_KOSPI_PLAN_HASH");
  if (p.kospi.result.plan)
    requireCheck(
      (await hashSeriesValue(p.kospi.result.plan)) === p.kospi.result.planHash &&
        p.kospi.result.plan.immutablePrefixPreserved === true &&
        p.kospi.result.plan.resetCapital === false,
    );
  phase("RECEIPT_ARCHIVE_DOMAIN_PROOF");
  await verifyArchiveObservationInventory(p);
  phase("RECEIPT_CANONICAL_HASH");
  return await hashSeriesValue(p);
}

/** Resolve the private diagnostic only from the exact captured revision inventory. */
export async function verifyPreparationKospiBoundary(p: any) {
  const result = p.kospi.result,
    a = result.authority,
    d = result.boundaryDiagnostic;
  requireCheck(
    a.predecessorDate === p.scope.predecessorDate &&
      equal(a.targetDates, p.scope.dates) &&
      Date.parse(a.baselineCollectedAt) === Date.parse(p.clockSemantics.sourceRegisteredAt) &&
      a.codeVersion === p.codeCommit &&
      a.sourceManifestHash === p.sourceRosterHash &&
      a.captureManifestHash === p.captureManifestHash &&
      a.adjustedBasisHash === p.candidate.datasetHash &&
      a.adjustedCapturedAt === p.captureObservedAt &&
      a.computedAt === p.preparedAt &&
      a.runtimeCodeHash === p.runtimeHashes.kospi,
  );
  const paths = p.kospi.capturedObjects.map((o: any) => o.path).sort();
  const ownerRoot = shadowObjectPath(a.owner, "registry.json").slice(0, -"registry.json".length);
  requireCheck(
    new Set(paths).size === paths.length &&
      equal(paths, p.kospi.generationPins.map((o: any) => o.path).sort()) &&
      paths.every((path: string) => path.startsWith(ownerRoot)),
  );
  const revisionPath = (suffix: string) => kospiShadowRevisionPath(a.owner, suffix);
  const get = (path: string) => {
    const matches = p.kospi.capturedObjects.filter((o: any) => o.path === path);
    requireCheck(matches.length === 1);
    return matches[0];
  };
  const registry = get(revisionPath("registry.json")),
    completed = get(revisionPath(`sessions/${a.predecessorDate}.json`)),
    latest = get(revisionPath("latest.json"));
  requireCheck(
    equal(latest.payload.latest, completed.payload) &&
      equal(latest.payload.registry, registry.payload),
  );
  const priorDate = completed.payload.source.previousSessionDate;
  const predecessor = priorDate ? get(revisionPath(`sessions/${priorDate}.json`)) : null;
  for (const [name, adjusted] of [
    ["baseline", false],
    ["adjusted", true],
  ] as const) {
    const s = d.sessions[name];
    requireCheck(
      s.hash === (await hashSeriesValue(s.payload)) &&
        s.payload.date === a.predecessorDate &&
        s.payload.configHash === registry.payload.configHash &&
        s.payload.codeVersion === a.codeVersion &&
        s.payload.sourceHash === (adjusted ? a.adjustedBasisHash : a.baselineSourceHash) &&
        s.payload.sourceCollectedAt === (adjusted ? a.adjustedCapturedAt : a.baselineCollectedAt),
    );
  }
  const recomputed = await diagnoseKospiCompletedBoundary({
    baselineSession: d.sessions.baseline.payload,
    adjustedSession: d.sessions.adjusted.payload,
    registry,
    completed,
    predecessor,
    guardResults: {
      baseline: result.baselineBoundaryEquivalent,
      adjusted: result.adjustedBoundaryEquivalent,
    },
  });
  requireCheck(equal(d, recomputed));
}
