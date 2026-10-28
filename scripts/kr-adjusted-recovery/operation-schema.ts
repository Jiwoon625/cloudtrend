/* eslint-disable @typescript-eslint/no-explicit-any */
/** Private, independently hash-pinned read plan. It is never an operational approval. */
import {
  canonicalSeriesJson,
  hashSeriesValue,
  type SeriesHash,
} from "../../src/lib/ledger/modelSeries";
import { requireCheck } from "../kr-vintage-preflight/transport";
export const OPERATION_MANIFEST = "kr-adjusted-recovery-operation-input:";
export const FULL_PLAN = "kr-adjusted-recovery-full-plan:";
export const APPLY_APPROVAL = "kr-adjusted-recovery-apply-approval:";
export const EXECUTION_PROVENANCE = "kr-adjusted-recovery-execution-provenance:";
export const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
export const HASH = /^sha256:[a-f0-9]{64}$/;
export interface ActualLedgerPin {
  table: "portfolio_ledgers" | "us_actual_portfolio_ledgers";
  user_id: string;
  revision: number;
  updated_at: string;
  payloadHash: SeriesHash;
  rowHash: SeriesHash;
  keys: string[];
}
export interface RecoveryOperationManifest {
  version: "kr-adjusted-recovery-operation-input-v1";
  operationalApproval: false;
  owner: string;
  codeCommit: string;
  capsuleHash: SeriesHash;
  preparationReadPlanHash: SeriesHash;
  preparationHash: SeriesHash;
  preparationRecordedAt: string;
  registries: Array<{ seriesId: string; payloadHash: SeriesHash }>;
  usNext: { path: string; payloadHash: SeriesHash; sourceHash: SeriesHash; date: string };
  currentSources: any[];
  currentPublicationHash: SeriesHash;
  currentAsOfDate: string;
  actualLedgers: ActualLedgerPin[];
  modelInventory: Array<{
    seriesId: string;
    date: string;
    stateHash: SeriesHash;
    payloadHash: SeriesHash;
  }>;
  runtimeHashes: { october: SeriesHash; integrated: SeriesHash; kospi: SeriesHash };
}
export async function validateOperationManifest(
  value: RecoveryOperationManifest,
  hash: string,
  owner: string,
) {
  requireCheck(
    HASH.test(hash) &&
      (await hashSeriesValue(value)) === hash &&
      value.version === "kr-adjusted-recovery-operation-input-v1" &&
      value.operationalApproval === false &&
      value.owner === owner &&
      /^[a-f0-9]{40}$/.test(value.codeCommit),
  );
  requireCheck(
    [
      value.capsuleHash,
      value.preparationReadPlanHash,
      value.preparationHash,
      value.currentPublicationHash,
      ...Object.values(value.runtimeHashes),
    ].every((h) => HASH.test(h)),
  );
  requireCheck(
    Number.isFinite(Date.parse(value.preparationRecordedAt)) &&
      /^\d{4}-\d{2}-\d{2}$/.test(value.currentAsOfDate),
  );
  requireCheck(
    value.registries.length === 7 &&
      new Set(value.registries.map((x) => x.seriesId)).size === 7 &&
      value.registries.every((x) => HASH.test(x.payloadHash)),
  );
  requireCheck(
    value.currentSources.length > 0 &&
      value.currentSources.length <= 128 &&
      new Set(value.currentSources.map((x) => x.id)).size === value.currentSources.length,
  );
  requireCheck(
    value.currentSources.every(
      (x) =>
        x.user_id === owner &&
        x.status === "active" &&
        x.source_type === "screening" &&
        HASH.test(x.data_hash) &&
        HASH.test(x.schema_hash) &&
        x.canonical_format === "csv",
    ),
  );
  requireCheck(
    same(value.actualLedgers.map((x) => x.table).sort(), [
      "portfolio_ledgers",
      "us_actual_portfolio_ledgers",
    ]),
  );
  for (const p of value.actualLedgers)
    requireCheck(
      p.user_id === owner &&
        Number.isSafeInteger(p.revision) &&
        p.revision >= 0 &&
        HASH.test(p.payloadHash) &&
        HASH.test(p.rowHash) &&
        new Date(p.updated_at).toISOString() === p.updated_at &&
        new Set(p.keys).size === p.keys.length,
    );
  requireCheck(
    value.modelInventory.length > 0 &&
      value.modelInventory.length <= 512 &&
      new Set(value.modelInventory.map((x) => x.seriesId + ":" + x.date)).size ===
        value.modelInventory.length &&
      value.modelInventory.every((x) => HASH.test(x.stateHash) && HASH.test(x.payloadHash)),
  );
  requireCheck(
    value.usNext.path ===
      `${owner}/staging/integrated-allocation-inputs/v1/US/${value.usNext.date}.json` &&
      HASH.test(value.usNext.payloadHash) &&
      HASH.test(value.usNext.sourceHash),
  );
  return value;
}
export async function verifyActualLedger(row: any, pin: ActualLedgerPin) {
  requireCheck(
    row &&
      row.user_id === pin.user_id &&
      row.revision === pin.revision &&
      new Date(row.updated_at).toISOString() === pin.updated_at &&
      row.payload &&
      typeof row.payload === "object" &&
      !Array.isArray(row.payload),
  );
  requireCheck(
    same(Object.keys(row.payload).sort(), [...pin.keys].sort()) &&
      (await hashSeriesValue(row.payload)) === pin.payloadHash &&
      (await hashSeriesValue({
        user_id: row.user_id,
        revision: row.revision,
        updated_at: new Date(row.updated_at).toISOString(),
        payload: row.payload,
      })) === pin.rowHash,
  );
}
export async function buildExecutionProvenance(plan: any) {
  const models = plan.models;
  return {
    version: "kr-adjusted-recovery-execution-provenance-v1",
    operationManifestHash: plan.operationManifestHash,
    preparationHash: plan.preparationHash,
    retrospectiveRegistryHash: models.retrospectiveAuthorityCandidateHash,
    historicalAvailabilityClaim: false,
    clockSemantics: "RETROSPECTIVE_MODEL_CLOCK_WITH_EVENT_TYPED_ACTUAL_EVIDENCE",
    actualEvidence: models.retrospectiveAuthorityCandidate.receipt,
    newModelStates: [
      ...models.newAdoptedSessions.map((x: any) => ({
        bookId: x.bookId,
        date: x.receipt.date,
        stateHash: x.stateHash,
      })),
      ...models.newIntegratedSessions.map((x: any) => ({
        bookId: x.bookId,
        date: x.receipt.date,
        stateHash: x.stateHash,
      })),
    ].sort((a, b) => (a.bookId + ":" + a.date).localeCompare(b.bookId + ":" + b.date)),
    retainedIntegrated26: models.retainedIntegrated26,
  };
}
export async function verifyFullRecoveryPlan(
  plan: any,
  hash: string,
  manifest: RecoveryOperationManifest,
  manifestHash: string,
) {
  requireCheck(
    HASH.test(hash) &&
      (await hashSeriesValue(plan)) === hash &&
      plan.version === "kr-adjusted-recovery-full-plan-v1" &&
      plan.operationalApproval === false &&
      plan.historicalAvailabilityClaim === false &&
      plan.operationManifestHash === manifestHash &&
      plan.preparationHash === manifest.preparationHash &&
      same(plan.runtimeHashes, manifest.runtimeHashes),
  );
  requireCheck(
    same(plan.executionProvenance, await buildExecutionProvenance(plan)) &&
      plan.executionProvenance.newModelStates.length === 12 &&
      new Set(plan.executionProvenance.newModelStates.map((x: any) => x.bookId + ":" + x.date))
        .size === 12,
  );
  requireCheck(
    same(plan.actualLedgers, manifest.actualLedgers) &&
      same(plan.originalModelInventory, manifest.modelInventory),
  );
  requireCheck(
    plan.economicExposureProof?.version === "kr-recovery-bounded-economic-exposure-v1" &&
      plan.economicExposureProof.runtimeCodeHash === manifest.runtimeHashes.october &&
      plan.economicExposureProof.etf?.cumulativeFees === "0" &&
      plan.economicExposureProof.confirmation?.totalEntries === 0 &&
      plan.economicExposureProof.allHistoricalDailyExecutionsScanned === false,
  );
  requireCheck(
    plan.historyCorrection.operationalApproval === false &&
      plan.historyCorrection.role === "HISTORY_ONLY",
  );
  return plan;
}
