/* eslint-disable @typescript-eslint/no-explicit-any */
/** Complete private plan calculation; no I/O writer, credentials or approval provisioning. */
import fs from "node:fs";
import { hashSeriesValue, type SeriesHash } from "../../src/lib/ledger/modelSeries";
import { KR_SOURCE_VINTAGE_POLICY } from "../../src/lib/ledger/krSourceVintage";
import { KR_RETROSPECTIVE_POLICY } from "../../src/lib/ledger/krRetrospectivePublication";
import {
  analyzeKrReplayDataset,
  sliceKrDatasetForReplay,
} from "../../src/lib/shadowReplayCalculation";
import { nextKrRegularSession } from "../../src/lib/ledger/krShadowDecision";
import { validateSourceBytes } from "../../src/lib/sourceData";
import { parseManualMarketDataWithReferences } from "../../src/lib/krxReviewReferenceParser";
import { classifyKrScreeningPublication } from "../../src/lib/krScreeningPublication";
import { planCurrentHistoryCorrection } from "../kr-current-history-correction";
import { rawHash, requireCheck } from "../kr-vintage-preflight/transport";
import { prepareRecovery } from "./prepare";
import { planOrderedKrRecovery } from "./ordered-plan";
import {
  buildExecutionProvenance,
  same,
  validateOperationManifest,
  verifyFullRecoveryPlan,
} from "./operation-schema";
import octoberRuntime from "../../src/lib/ledger/octoberShadowEngineManifest.generated.json";
import integratedRuntime from "../../src/lib/integratedAllocationRuntime.generated.json";
import kospiRuntime from "../../src/lib/kospiShadowPublicationRuntime.generated.json";
const kinds = ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "ETF_V02", "KR_KOSPI_CONFIRM1_BEAR"];
export async function prepareFullRecoveryPlan(c: any) {
  const op = c.input.operation,
    m = c.read(op.manifest),
    p = c.read(op.preparation);
  await validateOperationManifest(m, op.manifestHash, c.input.recoveryPreparation.owner);
  requireCheck(
    same(m.runtimeHashes, {
      october: octoberRuntime.codeHash,
      integrated: integratedRuntime.codeHash,
      kospi: kospiRuntime.codeHash,
    }) && same(p.runtimeHashes, m.runtimeHashes),
  );
  requireCheck(
    m.codeCommit === c.input.recoveryPreparation.codeVersion && p.codeCommit === m.codeCommit,
  );
  // Reproduce the durable preparation byte-for-byte under the SAME final admitted runtime.
  requireCheck(
    (await hashSeriesValue(p)) === m.preparationHash && same(await prepareRecovery(c), p),
  );
  const refs = c.input.recoveryPreparation,
    registries = op.registries.map((r: any) => ({ id: r.seriesId, payload: c.read(r.ref) }));
  const predecessors = kinds.map((kind) => {
    const pin = refs.models.find((r: any) => r.seriesId.endsWith(":" + kind));
    const series = registries.find((r: any) => r.id === pin.seriesId)?.payload;
    requireCheck(series);
    return { series, run: c.read(pin.ref), payloadHash: pin.payloadHash };
  });
  // Bound cumulative records plus frozen monotonic counters close pre-change executed exposure.
  // This is not a claim that every old daily ETF/confirmation record was downloaded.
  const etf = predecessors.find((x: any) => x.series.policy.kind === "ETF_V02")!;
  const confirmation = predecessors.find(
    (x: any) => x.series.policy.kind === "KR_KOSPI_CONFIRM1_BEAR",
  )!;
  requireCheck(
    etf.run.result.state.cumulativeFees === "0" && confirmation.run.result.state.totalEntries === 0,
  );
  const exposureProof = {
    version: "kr-recovery-bounded-economic-exposure-v1",
    scope: p.scope,
    runtimeCodeHash: m.runtimeHashes.october,
    predecessorHashes: predecessors.map((x: any) => ({
      bookId: x.series.bookId,
      stateHash: x.run.stateHash,
    })),
    pinnedCumulativeKrAndIntegratedRecords: "NO_TARGET_EXPOSURE_OR_INTENT",
    etf: {
      invariant: "POSITIVE_BUY_FEE_MONOTONE_CUMULATIVE_FEES_ZERO",
      cumulativeFees: "0",
      stateHash: etf.run.stateHash,
    },
    confirmation: {
      invariant: "MONOTONE_TOTAL_ENTRIES_ZERO",
      totalEntries: 0,
      stateHash: confirmation.run.stateHash,
    },
    allHistoricalDailyExecutionsScanned: false,
    expiredSignalAbsenceClaim: false,
  };
  const vintage: any = {
    receipt: p.vintageReviewProposal,
    predecessor: { registry: p.vintageV1.registry, receipt: p.vintageV1.receipt },
    registry: {
      version: "kr-source-vintage-approval-v2",
      reviewId: "reviewed-kr-vintage-v2",
      status: "APPROVED",
      receiptHash: await hashSeriesValue(p.vintageReviewProposal),
      parentRegistryHash: p.vintageV1.registryHash,
      policy: KR_SOURCE_VINTAGE_POLICY,
    },
  };
  // APPROVED is the candidate contract shape, not provisioned authority; PLAN never stores it in the live registry.
  const dates = [];
  for (const date of p.scope.dates) {
    const next = nextKrRegularSession(date);
    requireCheck(next);
    const v = analyzeKrReplayDataset(sliceKrDatasetForReplay(c.candidateDataset, date), c.config);
    const e = p.candidate.evidence.find((x: any) => x.payload.date === date);
    requireCheck(e);
    dates.push({
      date,
      sourceHash: e.payload.clock.sourceHash,
      datasetHash: await hashSeriesValue(v.dataset),
      configHash: await hashSeriesValue(c.config),
      evidenceStoredAt: new Date(op.preparationRecordedAt).toISOString(),
      modelAvailableAt: `${next}T08:00:00+09:00`,
      modelDecisionAt: `${next}T08:10:00+09:00`,
    });
  }
  const receipt: any = {
    version: "kr-reviewed-retrospective-source-v1",
    owner: m.owner,
    preparationHash: m.preparationHash,
    capsuleHash: p.capsuleHash,
    captureManifestHash: p.captureManifestHash,
    sourceManifestHash: p.sourceRosterHash,
    captureFinishedAt: p.captureObservedAt,
    originFinalPublicationHash: p.finalPublication.publicationHash,
    originFinalActivatedAt: p.clockSemantics.sourceRegisteredAt,
    derivedBasisSourceStatus: "NOT_REGISTERED_AT_PREPARATION",
    preparationRuntimeCodeHash: p.runtimeHashes.october,
    runtimeCodeHash: m.runtimeHashes.october,
    predecessorDate: p.scope.predecessorDate,
    predecessorHeads: predecessors.map((x: any) => ({
      bookId: x.series.bookId,
      stateHash: x.run.stateHash,
    })),
    dates,
    historicalAvailabilityClaim: false,
  };
  const registry: any = {
    version: "kr-reviewed-retrospective-registry-v1",
    status: "APPROVED",
    policy: KR_RETROSPECTIVE_POLICY,
    receiptHash: await hashSeriesValue(receipt),
  };
  const authority = {
    receipt,
    registry,
    authoritativeRegistryHash: await hashSeriesValue(registry),
  };
  const integrated26: any = {
    date: p.scope.dates[0],
    calculatedAt: p.preparedAt,
    original: c.frozen,
    candidate: c.candidateEvidence,
    history: c.history,
    usPrevious: c.priorUs,
    usCurrent: c.us,
    books: ["O1", "S07"].map((kind) => ({
      kind,
      previous: c.read(c.input.integrated.books[kind].previous),
      completed: c.read(c.input.integrated.books[kind].completed),
    })),
  };
  for (const b of integrated26.books)
    requireCheck(
      same(registries.find((x: any) => x.id === b.completed.bookId)?.payload, b.completed.registry),
    );
  const models = await planOrderedKrRecovery({
    preparation: p,
    preparationHash: m.preparationHash,
    dataset: c.candidateDataset,
    config: c.config,
    runtimeCodeHash: m.runtimeHashes.october,
    vintageAuthorityCandidate: vintage,
    retrospectiveAuthorityCandidate: authority,
    predecessors,
    archives: refs.archives.map((x: any) => ({ hash: x.payloadHash, payload: c.read(x.ref) })),
    integrated26,
    integrated26Proof: p.integrated26,
    integratedUsNext: c.read(op.usNext),
    integratedUsNextHash: m.usNext.payloadHash,
  });
  const bytes = (r: any) => {
    const b = fs.readFileSync(r.path);
    requireCheck(rawHash(b) === r.sha256);
    return b;
  };
  const sources = [];
  for (const s of op.currentSources) {
    const v = await validateSourceBytes({
      bytes: bytes(s.ref),
      filename: s.original_filename,
      contentType: s.content_type,
      streamingCsv: true,
    });
    requireCheck(v.valid && v.dataHash === s.data_hash && v.schemaHash === s.schema_hash);
    const { ref, ...metadata } = s;
    void ref;
    sources.push({
      id: s.id,
      dataHash: s.data_hash,
      schemaHash: s.schema_hash,
      canonicalCsv: v.canonicalCsv,
      publicationSource: metadata,
    });
  }
  const current = parseManualMarketDataWithReferences(sources.map((s) => s.canonicalCsv)).dataset,
    publication = classifyKrScreeningPublication(
      sources.map((s) => s.publicationSource),
      current.asOfDate,
    );
  requireCheck(
    (await hashSeriesValue(publication)) === m.currentPublicationHash &&
      current.asOfDate === m.currentAsOfDate,
  );
  const ids = await Promise.all(
    sources.map(async (s) => ({
      id: s.id,
      dataHash: s.dataHash,
      schemaHash: s.schemaHash,
      canonicalByteHash: rawHash(s.canonicalCsv),
      sourceMetadataHash: await hashSeriesValue(s.publicationSource),
    })),
  );
  const historyCorrection = await planCurrentHistoryCorrection({
    sources,
    expectedOrderedSourcesHash: await hashSeriesValue(ids),
    expectedCurrentDatasetHash: await hashSeriesValue(current),
    publication,
    expectedPublicationHash: m.currentPublicationHash,
    capture: {
      manifestRaw: bytes(c.input.captureManifest),
      normalizedRowsRaw: bytes(c.input.captureRows),
      rawPages: c.input.captureRawPages.map((r: any) => ({ name: r.name, raw: bytes(r) })),
    },
    scope: {
      ...c.scope,
      predecessorDate: p.scope.predecessorDate,
      currentAsOfDate: m.currentAsOfDate,
      reviewedHistoricalDates: (
        current.observedBars?.[c.scope.symbol] ??
        current.bars[c.scope.symbol] ??
        []
      )
        .filter((b: any) => b.tradeDate <= p.scope.predecessorDate)
        .map((b: any) => b.tradeDate)
        .sort(),
    },
    fieldPolicy: c.input.fieldPolicy,
  });
  requireCheck(
    historyCorrection.status === "CANDIDATE_REVIEW_REQUIRED" &&
      p.kospi.result.status === "PREPARED_FOR_INDEPENDENT_REVIEW",
  );
  const kp = p.kospi.result;
  const kospiApproval = {
    version: "kospi-final-retrospective-approval-v1",
    status: "APPROVED",
    owner: m.owner,
    preparationHash: m.preparationHash,
    planHash: kp.planHash,
    runtimeCodeHash: m.runtimeHashes.kospi,
    predecessorDate: p.scope.predecessorDate,
    targetDates: p.scope.dates,
    predecessorHash: kp.plan.predecessorHash,
    snapshotHashes: kp.plan.snapshotHashes,
    finalProjectionHash: kp.plan.finalProjectionHash,
  };
  const plan: any = {
    version: "kr-adjusted-recovery-full-plan-v1",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    operationManifestHash: op.manifestHash,
    preparationHash: m.preparationHash,
    runtimeHashes: m.runtimeHashes,
    models: models.result,
    economicExposureProof: exposureProof,
    vintageAuthorityCandidate: vintage,
    historyCorrection,
    kospiApprovalCandidate: kospiApproval,
    actualLedgers: m.actualLedgers,
    originalModelInventory: m.modelInventory,
    retainedIntegrated26EvidenceHash: await hashSeriesValue(c.frozen),
    integratedNextEvidence: p.candidate.evidence.find(
      (x: any) => x.payload.date === p.scope.dates[1],
    ),
  };
  plan.executionProvenance = await buildExecutionProvenance(plan);
  const hash = await hashSeriesValue(plan);
  await verifyFullRecoveryPlan(plan, hash, m, op.manifestHash);
  return { hash, payload: plan };
}
