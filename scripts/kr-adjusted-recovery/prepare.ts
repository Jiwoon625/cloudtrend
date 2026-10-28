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
export async function prepareRecovery(context: any) {
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
  requireCheck(
    preparation.planHash === (await hashSeriesValue(plan)) &&
      plan.capsuleHash === preparation.capsuleHash &&
      input.calculatedAt === plan.preparedAt &&
      plan.scope.symbol === symbol,
  );
  const originalV1 = { registry: plan.vintageV1.registry, receipt: plan.vintageV1.receipt };
  await verifyKrSourceVintagePrivateApproval(originalV1);
  const archivePairs: any[] = [],
    retainedPairs: any[] = [],
    missingHistoricalRows: any[] = [],
    models = preparation.models.map((m: any) => ({ ...m, payload: read(m.ref) }));
  for (const reference of preparation.archives) {
    const archive = read(reference.ref);
    requireCheck(
      (await hashSeriesValue(archive)) === reference.payloadHash && archive.date === reference.date,
    );
    for (const [s, bars] of Object.entries(archive.inputs.bars) as [string, any[]][])
      for (const archived of bars) {
        const incoming = (
          (reference.date >= "2026-10-12" ? candidateDataset.observedBars?.[s] : undefined) ??
          candidateDataset.bars[s] ??
          []
        ).find((b: any) => b.tradeDate === archived.tradeDate);
        if (!incoming) {
          requireCheck(s !== symbol);
          missingHistoricalRows.push({
            symbol: s,
            date: archived.tradeDate,
            archiveSourceId: reference.sourceId,
          });
          continue;
        }
        const old = krExecutionBar(archived),
          next = krExecutionBar(incoming);
        if (equal(old, next)) continue;
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
        if (s === symbol) archivePairs.push(pair);
        else {
          requireCheck(
            plan.vintageV1.receipt.reviews.some(
              (r: any) =>
                r.symbol === s &&
                r.date === pair.date &&
                r.archivedHash === pair.archivedHash &&
                r.incomingHash === pair.incomingHash,
            ),
          );
          retainedPairs.push(pair);
        }
      }
  }
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
    requireCheck(
      (await hashSeriesValue(model.payload)) === model.payloadHash &&
        model.payload.stateHash === model.stateHash &&
        model.payload.receipt.date === plan.scope.predecessorDate,
    );
    const result = model.payload.result;
    requireCheck(result && typeof result === "object" && Object.keys(result).length > 0);
    requireCheck(!containsTargetSymbol(result, symbol));
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
  requireCheck(
    correctionRows.length > 0 &&
      correctionRows.every(
        (r) => r.type === "STOCK" && r.symbol === symbol && r.date <= plan.scope.predecessorDate,
      ),
  );
  const csv = toCanonicalCsv(correctionRows),
    validation = await validateSourceText(csv, "reviewed-history-correction.csv");
  requireCheck(validation.valid);
  const merged = parseManualMarketDataWithReferences([...values, validation.canonicalCsv]).dataset;
  requireCheck(equal(merged, candidateDataset));
  const books = ["O1", "S07"].map((kind) => ({
    kind,
    previous: read(input.integrated.books[kind].previous),
    completed: read(input.integrated.books[kind].completed),
  }));
  for (const book of books) {
    requireCheck(!containsTargetSymbol(book.previous.result, symbol));
    requireCheck(!containsTargetSymbol(book.completed.result, symbol));
  }
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
  const nextDate = plan.scope.dates[1],
    following = nextKrRegularSession(nextDate);
  requireCheck(following);
  const clock = {
    modelAvailableAt: `${following}T08:00:00+09:00`,
    modelDecisionAt: `${following}T08:10:00+09:00`,
    openAt: regularOpenAt("KR", nextDate),
    closeAt: regularCloseAt("KR", nextDate),
  };
  const next = analyzeKrReplayDataset(sliceKrDatasetForReplay(candidateDataset, nextDate), config);
  const nextSnapshot = { ...buildSnapshot(next.analysis), savedAt: clock.modelAvailableAt };
  const nextDated = currentDateEvidence(next.dataset, nextSnapshot),
    nextSourceHash = await hashSeriesValue(nextDated);
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
  const finalSource = read(preparation.finalSource);
  const kospi = await prepareKospiFinalRetrospective({
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
  });
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
  return JSON.parse(JSON.stringify(receipt));
}
