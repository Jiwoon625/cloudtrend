/* eslint-disable @typescript-eslint/no-explicit-any */
/** Credential-free candidate preparation. Result is not an approval. */
import { canonicalSeriesJson, hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { krExecutionBar } from "../../src/lib/ledger/octoberShadowArchive";
import {
  verifyKrSourceVintagePrivateApproval,
  reconcileKrHistoricalSourceVintage,
} from "../../src/lib/ledger/krSourceVintage";
import { prepareIntegratedEquivalenceProof } from "../../src/lib/integratedAllocationEquivalence";
import { prepareKospiFinalRetrospective } from "../kospi-final-retrospective-preparation";
import { parseManualMarketDataWithReferences } from "../../src/lib/krxReviewReferenceParser";
import {
  toCanonicalCsv,
  validateSourceText,
  type CanonicalSourceRow,
} from "../../src/lib/sourceData";
import {
  sliceKrDatasetForReplay,
  analyzeKrReplayDataset,
} from "../../src/lib/shadowReplayCalculation";
import { buildSnapshot } from "../../src/lib/screeningSnapshot";
import { currentDateEvidence } from "../kr-vintage-preflight-dated-evidence";
import { prepareIntegratedKrEvidence } from "../../src/lib/integratedAllocationReplayAdapter";
import { nextKrRegularSession } from "../../src/lib/ledger/krShadowDecision";
import { regularOpenAt, regularCloseAt } from "../../src/lib/ledger/octoberShadowCalendar";
import octoberRuntime from "../../src/lib/ledger/octoberShadowEngineManifest.generated.json";
import integratedRuntime from "../../src/lib/integratedAllocationRuntime.generated.json";
import kospiRuntime from "../../src/lib/kospiShadowPublicationRuntime.generated.json";
import { requireCheck, rawHash } from "../kr-vintage-preflight/transport";
import {
  verifyArchivePrefixBodies,
  nonTargetDatasetIdentity,
  classifyPreExistingObservation,
} from "./archive-domain";
import type { ComputationPhase } from "../kr-vintage-preflight/phases";
const equal = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
export function containsTargetSymbol(value: unknown, symbol: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value) && (value as any).symbol === symbol) return true;
  return Object.entries(value).some(
    ([key, v]) =>
      (["positions", "pendingExits", "pendingEntries", "awaiting"].includes(key) &&
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        Object.hasOwn(v, symbol)) ||
      containsTargetSymbol(v, symbol),
  );
}
export async function prepareRecovery(
  context: any,
  phase: (value: ComputationPhase) => void = () => {},
) {
  phase("PREPARATION_CONTEXT");
  const {
    input,
    dataset,
    candidateDataset,
    config,
    scope,
    plan: overlay,
    rawOperands,
    frozen,
    candidateEvidence,
    captureManifest,
    values,
    history,
    priorUs,
    us,
    report,
    read,
  } = context;
  const preparation = input.recoveryPreparation,
    plan = read(preparation.plan),
    symbol = scope.symbol;
  phase("PREPARATION_PLAN_IDENTITY");
  requireCheck(
    preparation.planHash === (await hashSeriesValue(plan)) &&
      plan.capsuleHash === preparation.capsuleHash &&
      input.calculatedAt === plan.preparedAt &&
      plan.scope.symbol === symbol,
  );
  const originalV1 = { registry: plan.vintageV1.registry, receipt: plan.vintageV1.receipt };
  phase("RETAINED_VINTAGE_APPROVAL");
  await verifyKrSourceVintagePrivateApproval(originalV1);
  phase("ADOPTED_MODEL_READ");
  const archivePairs: any[] = [],
    retainedPairs: any[] = [],
    missingHistoricalRows: any[] = [],
    models = preparation.models.map((m: any) => ({ ...m, payload: read(m.ref) }));
  phase("ARCHIVE_EXECUTION_DOMAIN");
  const domainModels = preparation.models.map((m: any) => ({
    pin: plan.models.find((p: any) => p.seriesId === m.seriesId),
    series: read(m.seriesRef),
    run: read(m.ref),
  }));
  const archiveBodies = preparation.archives.map((reference: any) => ({
    reference,
    payload: read(reference.ref),
  }));
  const executionPrefixReferences = await verifyArchivePrefixBodies(domainModels, archiveBodies);
  phase("NON_TARGET_DATASET_IDENTITY");
  const datasetIdentity = await nonTargetDatasetIdentity(dataset, candidateDataset, symbol);
  const preExistingUnreferenced: any[] = [],
    scannedArchives: any[] = [];
  for (const reference of preparation.archives) {
    phase("ARCHIVE_PAYLOAD_IDENTITY");
    const archive = read(reference.ref);
    const scan = {
      sourceId: reference.sourceId,
      total: 0,
      unchanged: 0,
      targetChanged: 0,
      v1Retained: 0,
      preExistingUnreferenced: 0,
      missing: 0,
    };
    scannedArchives.push(scan);
    requireCheck(
      (await hashSeriesValue(archive)) === reference.payloadHash && archive.date === reference.date,
    );
    for (const [s, bars] of Object.entries(archive.inputs.bars) as [string, any[]][])
      for (const archived of bars) {
        scan.total++;
        phase("ARCHIVE_TARGET_COVERAGE");
        const incoming = (
          (reference.date >= "2026-10-12" ? candidateDataset.observedBars?.[s] : undefined) ??
          candidateDataset.bars[s] ??
          []
        ).find((b: any) => b.tradeDate === archived.tradeDate);
        if (!incoming) {
          const baselineMissing = !(
            (reference.date >= "2026-10-12" ? dataset.observedBars?.[s] : undefined) ??
            dataset.bars[s] ??
            []
          ).some((b: any) => b.tradeDate === archived.tradeDate);
          requireCheck(s !== symbol && baselineMissing);
          scan.missing++;
          missingHistoricalRows.push({
            symbol: s,
            date: archived.tradeDate,
            archiveSourceId: reference.sourceId,
            classification: "PRE_EXISTING_ABSENCE_NOT_APPROVED",
            baselineAndCandidateAbsent: true,
            operationalApproval: false,
          });
          continue;
        }
        phase("ARCHIVE_BAR_COMPARISON");
        const old = krExecutionBar(archived),
          next = krExecutionBar(incoming);
        if (equal(old, next)) {
          scan.unchanged++;
          continue;
        }
        const pair = {
          symbol: s,
          date: archived.tradeDate,
          archiveSourceId: reference.sourceId,
          archiveHash: reference.sourceHash,
          archived: old,
          incoming: next,
          archivedHash: await hashSeriesValue(old),
          incomingHash: await hashSeriesValue(next),
          fields: [...new Set([...Object.keys(old), ...Object.keys(next)])]
            .filter((k) => !equal((old as any)[k] ?? null, (next as any)[k] ?? null))
            .sort(),
        };
        if (s === symbol) {
          archivePairs.push(pair);
          scan.targetChanged++;
        } else {
          phase("ARCHIVE_RETAINED_PAIR_APPROVAL");
          const matches = plan.vintageV1.receipt.reviews.filter(
            (r: any) =>
              r.symbol === s &&
              r.date === pair.date &&
              r.archivedHash === pair.archivedHash &&
              r.incomingHash === pair.incomingHash,
          );
          if (matches.length === 1) {
            retainedPairs.push(pair);
            scan.v1Retained++;
          } else {
            requireCheck(matches.length === 0);
            phase("ARCHIVE_PREEXISTING_UNREFERENCED_PROOF");
            const baseline = (
              (reference.date >= "2026-10-12" ? dataset.observedBars?.[s] : undefined) ??
              dataset.bars[s] ??
              []
            ).find((b: any) => b.tradeDate === archived.tradeDate);
            preExistingUnreferenced.push(
              await classifyPreExistingObservation(
                pair,
                baseline,
                domainModels,
                executionPrefixReferences,
              ),
            );
            scan.preExistingUnreferenced++;
          }
        }
      }
  }
  phase("ARCHIVE_CHANGED_PAIR_SET");
  requireCheck(
    archivePairs.length === plan.archives.length &&
      equal(archivePairs.map((p) => p.date).sort(), plan.archives.map((a: any) => a.date).sort()),
  );
  const additions = archivePairs.map((p) => ({
    id: "reviewed-kr-vintage-v2",
    symbol,
    date: p.date,
    notBefore: scope.targetDate,
    archivedHash: p.archivedHash,
    incomingHash: p.incomingHash,
    evidenceUrl: plan.corporateActionEvidenceUrl,
  }));
  for (const model of models) {
    phase("ADOPTED_MODEL_PIN");
    requireCheck(
      (await hashSeriesValue(model.payload)) === model.payloadHash &&
        model.payload.stateHash === model.stateHash &&
        model.payload.receipt.date === plan.scope.predecessorDate,
    );
    phase("ADOPTED_TARGET_EXPOSURE");
    const result = model.payload.result;
    requireCheck(result && typeof result === "object" && Object.keys(result).length > 0);
    requireCheck(!containsTargetSymbol(result, symbol));
    phase("ADOPTED_VINTAGE_RECONCILIATION");
    if (["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ"].some((k) => model.seriesId.endsWith(":" + k)))
      for (const p of archivePairs)
        await reconcileKrHistoricalSourceVintage({
          symbol,
          archived: p.archived,
          incoming: p.incoming,
          publicationDate: scope.targetDate,
          previousResult: result,
          reviews: additions,
        });
  }
  // HISTORY_ONLY is an explicit transformed source, not a collector FINAL declaration.
  phase("HISTORY_CORRECTION_ROWS");
  const correctionRows: CanonicalSourceRow[] = [];
  for (const item of overlay.rows) {
    const old = dataset.observedBars[symbol].find((b: any) => b.tradeDate === item.date);
    if (equal(old, item.bar)) continue;
    requireCheck(item.date <= plan.scope.predecessorDate);
    const original = rawOperands.get(item.date);
    requireCheck(original && original.fields.symbol === symbol);
    const row = { ...original.fields };
    for (const field of [
      "open",
      "high",
      "low",
      "close",
      "volume",
      "tradingValue",
      "foreignNetBuyValue",
      "institutionNetBuyValue",
    ])
      row[field] = item.bar[field] === null ? "" : String(item.bar[field]);
    correctionRows.push(row as CanonicalSourceRow);
  }
  phase("HISTORY_CORRECTION_SCOPE");
  requireCheck(
    correctionRows.length > 0 &&
      correctionRows.every(
        (r) => r.type === "STOCK" && r.symbol === symbol && r.date <= plan.scope.predecessorDate,
      ),
  );
  phase("HISTORY_CORRECTION_CSV_VALIDATION");
  const csv = toCanonicalCsv(correctionRows),
    validation = await validateSourceText(csv, "reviewed-history-correction.csv");
  requireCheck(validation.valid);
  phase("HISTORY_CORRECTION_REPARSE_EQUALITY");
  const merged = parseManualMarketDataWithReferences([...values, validation.canonicalCsv]).dataset;
  requireCheck(equal(merged, candidateDataset));
  phase("INTEGRATED_EXPOSURE_READ");
  const books = ["O1", "S07"].map((kind) => ({
    kind,
    previous: read(input.integrated.books[kind].previous),
    completed: read(input.integrated.books[kind].completed),
  }));
  phase("INTEGRATED_TARGET_EXPOSURE");
  for (const book of books) {
    requireCheck(!containsTargetSymbol(book.previous.result, symbol));
    requireCheck(!containsTargetSymbol(book.completed.result, symbol));
  }
  traceIntegratedEquivalenceInputs(context, plan, books, phase);
  phase("INTEGRATED_EXACT_EQUIVALENCE_PROOF");
  const equivalence = await prepareIntegratedEquivalenceProof({
    date: scope.targetDate,
    calculatedAt: plan.preparedAt,
    original: frozen,
    candidate: candidateEvidence,
    history,
    usPrevious: priorUs,
    usCurrent: us,
    books,
  } as any);
  phase("NEXT_EVIDENCE_SESSION_CLOCK");
  const nextDate = plan.scope.dates[1],
    following = nextKrRegularSession(nextDate);
  requireCheck(following);
  const clock = {
    modelAvailableAt: `${following}T08:00:00+09:00`,
    modelDecisionAt: `${following}T08:10:00+09:00`,
    openAt: regularOpenAt("KR", nextDate),
    closeAt: regularCloseAt("KR", nextDate),
  };
  phase("NEXT_EVIDENCE_ANALYSIS");
  const next = analyzeKrReplayDataset(sliceKrDatasetForReplay(candidateDataset, nextDate), config);
  const nextSnapshot = { ...buildSnapshot(next.analysis), savedAt: clock.modelAvailableAt };
  phase("NEXT_EVIDENCE_DATED_HASH");
  const nextDated = currentDateEvidence(next.dataset, nextSnapshot),
    nextSourceHash = await hashSeriesValue(nextDated);
  phase("NEXT_EVIDENCE_ADAPTATION");
  const nextEvidence = prepareIntegratedKrEvidence(next.dataset, next.analysis, {
    ...candidateEvidence.clock,
    openAt: clock.openAt,
    closeAt: clock.closeAt,
    availableAt: clock.modelAvailableAt,
    decisionAt: clock.modelDecisionAt,
    sourceHash: nextSourceHash,
  });
  const objects: any = {},
    allObjectProofs = [];
  const correctionPath =
    preparation.owner +
    "/shadow/kospi-confirm1-bear-rsaccel-v1/correction-approvals/october14-retrospective-v1.json";
  let legacyApproval: any;
  phase("LEGACY_OBJECT_HASHES");
  for (const item of preparation.objects) {
    const payload = read(item.ref);
    requireCheck((await hashSeriesValue(payload)) === item.hash);
    allObjectProofs.push({ ...item, ref: undefined, payload });
    if (item.path === correctionPath) legacyApproval = payload;
    else objects[item.path] = { hash: item.hash, payload };
  }
  const revision =
    objects[
      preparation.owner +
        "/shadow/kospi-confirm1-bear-rsaccel-v1/revisions/october14-retrospective-v1/revision.json"
    ]?.payload;
  phase("LEGACY_CORRECTION_APPROVAL");
  requireCheck(
    legacyApproval &&
      revision &&
      legacyApproval.revisionId === revision.revisionId &&
      legacyApproval.predecessorDate === revision.predecessorDate &&
      legacyApproval.correctionDate === revision.correctionDate &&
      legacyApproval.expectedPredecessorHash === revision.expectedPredecessorHash &&
      legacyApproval.expectedOriginalTargetHash === revision.expectedOriginalTargetHash &&
      legacyApproval.expectedCorrectedSourceHash === revision.correctedSourceHash,
  );
  phase("LEGACY_FINAL_SOURCE_READ");
  const finalSource = read(preparation.finalSource);
  phase("LEGACY_PREPARATION_INPUT");
  const kospi = await prepareKospiFinalRetrospective(
    {
      baselineDataset: dataset,
      adjustedDataset: candidateDataset,
      scoringConfig: config,
      objects,
      authority: {
        owner: preparation.owner,
        predecessorDate: plan.scope.predecessorDate,
        targetDates: plan.scope.dates,
        baselineSourceHash: scope.expectedRun.dataVersion,
        adjustedBasisHash: await hashSeriesValue(candidateDataset),
        sourceManifestHash: await hashSeriesValue(read(input.frozenSourceRoster)),
        captureManifestHash: scope.captureManifestHash,
        baselineCollectedAt: new Date(
          finalSource.activated_at ?? read(input.frozenRun).completed_at,
        ).toISOString(),
        adjustedCapturedAt: captureManifest.finishedAt,
        computedAt: plan.preparedAt,
        codeVersion: preparation.codeVersion,
        runtimeCodeHash: kospiRuntime.codeHash,
      },
    },
    phase,
  );
  phase("PREPARATION_RECEIPT_ASSEMBLY");
  const receipt = {
    version: "kr-adjusted-recovery-preparation-v1",
    kind: "RECOVERY_PREPARATION_ONLY",
    status: "REVIEW_REQUIRED",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    planHash: preparation.planHash,
    capsuleHash: preparation.capsuleHash,
    scope: plan.scope,
    preparedAt: plan.preparedAt,
    codeCommit: preparation.codeVersion,
    runtimeHashes: {
      october: octoberRuntime.codeHash,
      integrated: integratedRuntime.codeHash,
      kospi: kospiRuntime.codeHash,
    },
    fieldPolicy: input.fieldPolicy,
    captureManifestHash: scope.captureManifestHash,
    captureObservedAt: captureManifest.finishedAt,
    sourceRosterHash: await hashSeriesValue(read(input.frozenSourceRoster)),
    finalPublication: plan.finalPublication,
    modelPins: plan.models,
    archiveReferences: plan.archives,
    archivePairs,
    retainedPairs,
    archiveObservationInventory: {
      version: "kr-preexisting-archive-observation-inventory-v1",
      classificationPolicy: "PRE_EXISTING_UNREFERENCED_NOT_APPROVED",
      operationalApproval: false,
      targetSymbol: symbol,
      models: domainModels,
      executionPrefixReferences,
      datasetIdentity,
      preExistingUnreferenced,
      scannedArchives,
      coverageComplete: missingHistoricalRows.length === 0,
    },
    historicalCoverage: {
      targetComplete: true,
      missingOtherRows: missingHistoricalRows,
      allOtherArchivedRowsCovered: missingHistoricalRows.length === 0,
    },
    exposureCheck: {
      capturedAdoptedResultTrees: "NO_TARGET_EXPOSURE",
      cumulativeKrAndIntegratedHistory: "NO_TARGET_EXPOSURE",
      etfAndConfirmationPastDayLocalRecords: "NOT_CAPTURED_NOT_CLAIMED",
      completeHistoricalApproval: false,
    },
    clockSemantics: {
      mode: "RETROSPECTIVE_MODEL_CLOCK",
      historicalAvailabilityClaim: false,
      originalCompletedEvidenceClockRetainedForCounterfactual: true,
      sourceRegisteredAt: finalSource.activated_at,
      adjustedCaptureObservedAt: captureManifest.finishedAt,
      modelEvaluationAt: plan.preparedAt,
      evaluationClockIsFixedNotWallClock: true,
      actualExecutionTimingEvidence: "AUTHENTICATED_ACTIONS_JOB_TIMESTAMPS_AND_ARCHIVE_RECORDED_AT",
      modeledNextAvailableAt: clock.modelAvailableAt,
      modeledNextDecisionAt: clock.modelDecisionAt,
    },
    vintageV1: plan.vintageV1,
    vintageReviewProposal: {
      version: "kr-source-vintage-review-v2",
      reviewId: "reviewed-kr-vintage-v2",
      parentReceiptHash: plan.vintageV1.receiptHash,
      reviews: [...plan.vintageV1.receipt.reviews, ...additions],
    },
    candidate: {
      datasetHash: await hashSeriesValue(candidateDataset),
      overlay,
      overlayHash: await hashSeriesValue(overlay),
      historyCorrection: {
        role: "HISTORY_ONLY",
        disposition: "FROZEN_BUNDLE_RECONSTRUCTION_ONLY_NOT_CURRENT_SOURCE_REGISTRATION",
        requiresCurrentActiveFieldMaskReview: true,
        symbol,
        minDate: validation.stats.minDate,
        maxDate: validation.stats.maxDate,
        rowCount: validation.stats.rowCount,
        fileHash: rawHash(csv),
        dataHash: validation.dataHash,
        schemaHash: validation.schemaHash,
        csv,
        originalRowProvenance: overlay.rows
          .filter((r: any) => correctionRows.some((c) => c.date === r.date))
          .map((r: any) => ({
            date: r.date,
            oldAnalyticalHash: r.oldAnalyticalHash,
            oldObservedHash: r.oldObservedHash,
            fieldEvidence: r.fieldEvidence,
          })),
      },
      evidence: [
        { hash: await hashSeriesValue(candidateEvidence), payload: candidateEvidence },
        { hash: await hashSeriesValue(nextEvidence), payload: nextEvidence },
      ],
    },
    integrated26: equivalence,
    kospi: {
      generationPins: plan.kospi.objects,
      capturedObjects: allObjectProofs,
      result: kospi,
      stateHashesIndependentlyApproved: false,
    },
    summary: {
      baselineEqual: report.baselineEvidence.equal,
      changedEvidenceLeaves: report.candidateEvidence.changedLeafCount,
      changedSnapshotLeaves: report.snapshotEntries.changedLeafCount,
    },
  };
  phase("PREPARATION_RECEIPT_SERIALIZATION");
  return JSON.parse(JSON.stringify(receipt));
}

/** Diagnostic prechecks only: mirror required proof predicates without altering that runtime. */
export function traceIntegratedEquivalenceInputs(
  context: any,
  plan: any,
  books: any[],
  phase: (value: ComputationPhase) => void,
) {
  const { scope, frozen, candidateEvidence, history, priorUs, us, report } = context;
  phase("EQUIVALENCE_INPUT_DATES");
  requireCheck(
    frozen.date === scope.targetDate &&
      candidateEvidence.date === scope.targetDate &&
      Number.isFinite(Date.parse(plan.preparedAt)) &&
      us.analysis.date === scope.targetDate,
  );
  phase("EQUIVALENCE_BOOK_ORDER");
  requireCheck(
    equal(
      books.map((b) => b.kind),
      ["O1", "S07"],
    ),
  );
  phase("EQUIVALENCE_HISTORY_ORDER");
  requireCheck(
    history.length > 0 &&
      history.every(
        (e: any, i: number) =>
          e.date < scope.targetDate && (i === 0 || e.date > history[i - 1].date),
      ),
  );
  for (const { kind, previous, completed } of books) {
    phase("EQUIVALENCE_BOOK_CHAIN");
    requireCheck(
      previous.registry.policy.kind === kind &&
        completed.registry.policy.kind === kind &&
        completed.receipt.date === scope.targetDate &&
        completed.previousStateHash === previous.stateHash &&
        equal(previous.registry, completed.registry),
    );
    phase("EQUIVALENCE_PREVIOUS_US_DATE");
    requireCheck(priorUs.analysis.date === previous.result.markets.U.lastSessionDate);
    phase("EQUIVALENCE_EXACT_KR_HISTORY");
    requireCheck(
      equal(
        history.map((e: any) => e.date),
        previous.result.markets.K.sessions,
      ),
    );
    phase("EQUIVALENCE_ECONOMIC_INPUTS");
    requireCheck(report.books[kind].sessionInputsEqualExceptSourceHash === true);
    phase("EQUIVALENCE_COMPLETED_BASELINE");
    requireCheck(report.books[kind].baselineReproduced.equal === true);
  }
  phase("EQUIVALENCE_DISTINCT_EVIDENCE");
  requireCheck(!equal(frozen, candidateEvidence));
}
