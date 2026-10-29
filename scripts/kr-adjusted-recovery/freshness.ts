/* eslint-disable @typescript-eslint/no-explicit-any */
import { canonicalSeriesJson, hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { verifyArchivePrefixBodies } from "./archive-domain";
import { krSourcePublication } from "../../src/lib/krScreeningPublication";
import {
  createReadOnlyTransport,
  validateCapsule,
  CAPSULE_PREFIX,
  requireCheck,
  restPath,
  objectPath,
} from "../kr-vintage-preflight/transport";
import { PLAN, validatePreparationPlan, verifyObjectGeneration } from "./transport";
import type { AppendPhase } from "./append-phases";
const equal = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
/** Fresh immutable authority/prefix readback immediately before the evidence-only append. */
export async function recheckPreparationPins(options: {
  origin: string;
  key: string;
  owner: string;
  payload: any;
  expectedPlanHash: string;
  expectedCapsuleHash: string;
  fetcher?: typeof fetch;
  onPhase?: (phase: AppendPhase) => void;
}) {
  const phase = options.onPhase ?? (() => {});
  const { owner, payload } = options,
    allowed = new Set<string>();
  const read = createReadOnlyTransport(options.origin, options.key, allowed, options.fetcher);
  const get = async (p: string) => {
    allowed.add(p);
    return JSON.parse((await read(p, 32 * 1024 * 1024)).toString());
  };
  const rows = (table: string, select: string, filters: Record<string, string>) =>
    get(restPath(table, owner, select, filters));
  const one = async (table: string, select: string, filters: Record<string, string>) => {
    const values = await rows(table, select, filters);
    requireCheck(Array.isArray(values) && values.length === 1);
    return values[0];
  };
  phase("FRESH_PLAN_READ");
  const planRow = await one(
    "ledger_provenance_archive",
    "user_id,source_id,source_revision,source_hash,payload",
    { source_id: "eq." + PLAN + options.expectedCapsuleHash.slice(7), source_revision: "eq.1" },
  );
  phase("FRESH_PLAN_VALIDATION");
  const plan = await validatePreparationPlan(
    planRow,
    owner,
    options.expectedPlanHash,
    options.expectedCapsuleHash,
  );
  phase("FRESH_RECEIPT_PLAN_BINDING");
  requireCheck(
    equal(payload.scope, plan.scope) &&
      payload.preparedAt === plan.preparedAt &&
      equal(payload.modelPins, plan.models) &&
      equal(payload.archiveReferences, plan.archives) &&
      equal(payload.finalPublication, plan.finalPublication) &&
      equal(payload.vintageV1, plan.vintageV1) &&
      equal(payload.kospi.generationPins, plan.kospi.objects),
  );
  phase("FRESH_CAPSULE_READ");
  const capsuleRow = await one(
    "ledger_provenance_archive",
    "user_id,source_id,source_revision,source_hash,payload",
    {
      source_id: "eq." + CAPSULE_PREFIX + payload.captureManifestHash.slice(7),
      source_revision: "eq.1",
    },
  );
  phase("FRESH_CAPSULE_HASH");
  requireCheck(capsuleRow.source_hash === options.expectedCapsuleHash);
  phase("FRESH_CAPSULE_VALIDATION");
  const capsule = await validateCapsule(capsuleRow, owner, "1");
  phase("FRESH_SOURCE_ROSTER");
  requireCheck(
    payload.sourceRosterHash === (await hashSeriesValue(capsule.frozenBaseline.orderedSources)),
  );
  phase("FRESH_CAPTURE_IDENTITY");
  requireCheck(payload.captureManifestHash === "sha256:" + capsule.capture.manifestSha256);
  const domainModels = payload.archiveObservationInventory.models;
  for (const pin of plan.models) {
    phase("FRESH_MODEL_READ");
    const row = await one("ledger_model_sessions", "state_hash,payload", {
      series_id: "eq." + pin.seriesId,
      session_date: "eq." + pin.sessionDate,
    });
    phase("FRESH_MODEL_HASH");
    requireCheck(
      row.state_hash === pin.stateHash && (await hashSeriesValue(row.payload)) === pin.payloadHash,
    );
    phase("FRESH_MODEL_RECEIPT_BINDING");
    const bound = domainModels.find((m: any) => m.pin.seriesId === pin.seriesId);
    requireCheck(bound && equal(bound.pin, pin) && equal(bound.run, row.payload));
    phase("FRESH_REGISTRY_READ");
    const registry = await one("ledger_model_series", "series_id,payload", {
      series_id: "eq." + pin.seriesId,
    });
    phase("FRESH_REGISTRY_BINDING");
    requireCheck(registry.series_id === pin.seriesId && equal(registry.payload, bound.series));
    phase("FRESH_MODEL_LATER_READ");
    const later = await rows("ledger_model_sessions", "session_date", {
      series_id: "eq." + pin.seriesId,
      session_date: "gt." + pin.sessionDate,
    });
    phase("FRESH_MODEL_LATER_ABSENCE");
    requireCheck(later.length === 0);
  }
  const archiveBodies = [];
  for (const pin of plan.archives) {
    phase("FRESH_ARCHIVE_READ");
    const row = await one("ledger_provenance_archive", "source_hash,payload", {
      source_id: "eq." + pin.sourceId,
      source_revision: "eq.1",
    });
    archiveBodies.push({ reference: pin, payload: row.payload });
    phase("FRESH_ARCHIVE_HASH");
    requireCheck(
      row.source_hash === pin.sourceHash &&
        (await hashSeriesValue(row.payload)) === pin.payloadHash,
    );
  }
  phase("FRESH_ARCHIVE_PREFIX");
  requireCheck(
    equal(
      await verifyArchivePrefixBodies(domainModels, archiveBodies),
      payload.archiveObservationInventory.executionPrefixReferences,
    ),
  );
  for (const [key, id] of [
    ["registry", plan.vintageV1.registryAuditId],
    ["receipt", plan.vintageV1.receiptAuditId],
  ] as const) {
    phase("FRESH_VINTAGE_READ");
    const row = await one("shadow_replay_audit", "details", { id: "eq." + id });
    phase("FRESH_VINTAGE_BINDING");
    requireCheck(
      equal(
        row.details[key === "registry" ? "krSourceVintageApproval" : "krSourceVintageReview"],
        plan.vintageV1[key],
      ),
    );
  }
  const f = plan.finalPublication;
  phase("FRESH_FINAL_SOURCE_READ");
  const source = await one(
    "analysis_source_files",
    "id,max_date,file_hash,data_hash,schema_hash,validation_result",
    { id: "eq." + f.sourceId },
  );
  phase("FRESH_FINAL_SOURCE_HASH");
  requireCheck(
    source.file_hash === f.fileHash &&
      source.data_hash === f.dataHash &&
      source.schema_hash === f.schemaHash &&
      (await hashSeriesValue(source.validation_result.krPublication)) === f.publicationHash,
  );
  phase("FRESH_FINAL_DECLARATION");
  requireCheck(krSourcePublication(source)?.phase === "FINAL");
  for (const pin of capsule.readPlan.books) {
    phase("FRESH_INTEGRATED_BOOK_BINDING");
    const proof = payload.integrated26.books.find((b: any) => b.kind === pin.kind);
    requireCheck(
      proof &&
        proof.previousStateHash === pin.previousStateHash &&
        proof.completedStateHash === pin.completedStateHash,
    );
    for (const [date, hash] of [
      [pin.previousDate, pin.previousStateHash],
      [pin.completedDate, pin.completedStateHash],
    ]) {
      phase("FRESH_INTEGRATED_MODEL_READ");
      const row = await one("ledger_model_sessions", "state_hash,payload", {
        series_id: "eq." + pin.seriesId,
        session_date: "eq." + date,
      });
      phase("FRESH_INTEGRATED_MODEL_STATE");
      requireCheck(row.state_hash === hash && row.payload.stateHash === hash);
      const { stateHash, canonicalPayload, ...body } = row.payload;
      phase("FRESH_INTEGRATED_MODEL_CANONICAL");
      requireCheck(
        (await hashSeriesValue(body)) === stateHash &&
          canonicalSeriesJson(body) === canonicalPayload,
      );
    }
    phase("FRESH_INTEGRATED_LATER_READ");
    const later = await rows("ledger_model_sessions", "session_date", {
      series_id: "eq." + pin.seriesId,
      session_date: "gt." + pin.completedDate,
    });
    phase("FRESH_INTEGRATED_LATER_ABSENCE");
    requireCheck(later.length === 0);
  }
  // Immutable evidence source identity is re-read, not inferred from public comparison counts.
  const evidence = async (
    market: string,
    date: string,
    expected: string,
    readPhase: AppendPhase,
    hashPhase: AppendPhase,
  ) => {
    phase(readPhase);
    const e = await get(
      objectPath(
        "cloudtrend-data",
        owner + `/staging/integrated-allocation-inputs/v1/${market}/${date}.json`,
        owner,
      ),
    );
    phase(hashPhase);
    requireCheck(e.hash === expected && (await hashSeriesValue(e.payload)) === expected);
  };
  await evidence(
    "KR",
    plan.scope.dates[0],
    payload.integrated26.originalEvidenceHash,
    "FRESH_KR_COMPLETED_EVIDENCE_READ",
    "FRESH_KR_COMPLETED_EVIDENCE_HASH",
  );
  phase("FRESH_KR_HISTORY_COUNT");
  requireCheck(
    capsule.readPlan.krHistoryDates.length === payload.integrated26.historyHashes.length,
  );
  for (let i = 0; i < capsule.readPlan.krHistoryDates.length; i++)
    await evidence(
      "KR",
      capsule.readPlan.krHistoryDates[i],
      payload.integrated26.historyHashes[i],
      "FRESH_KR_HISTORY_EVIDENCE_READ",
      "FRESH_KR_HISTORY_EVIDENCE_HASH",
    );
  await evidence(
    "US",
    capsule.readPlan.previousDate,
    payload.integrated26.previousUsHash,
    "FRESH_US_PREVIOUS_EVIDENCE_READ",
    "FRESH_US_PREVIOUS_EVIDENCE_HASH",
  );
  await evidence(
    "US",
    plan.scope.dates[0],
    payload.integrated26.currentUsHash,
    "FRESH_US_CURRENT_EVIDENCE_READ",
    "FRESH_US_CURRENT_EVIDENCE_HASH",
  );
  for (const pin of plan.kospi.objects) {
    const p = objectPath("cloudtrend-data", pin.path, owner).replace(
      "/object/authenticated/",
      "/object/info/",
    );
    phase("FRESH_LEGACY_GENERATION_READ");
    const info = await get(p);
    phase("FRESH_LEGACY_GENERATION_MATCH");
    verifyObjectGeneration(info, pin.metadata);
  }
  phase("FRESH_PINS_COMPLETE");
}
