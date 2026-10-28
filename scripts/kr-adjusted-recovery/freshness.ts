/* eslint-disable @typescript-eslint/no-explicit-any */
import { canonicalSeriesJson, hashSeriesValue } from "../../src/lib/ledger/modelSeries";
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
}) {
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
  const planRow = await one(
    "ledger_provenance_archive",
    "user_id,source_id,source_revision,source_hash,payload",
    { source_id: "eq." + PLAN + options.expectedCapsuleHash.slice(7), source_revision: "eq.1" },
  );
  const plan = await validatePreparationPlan(
    planRow,
    owner,
    options.expectedPlanHash,
    options.expectedCapsuleHash,
  );
  requireCheck(
    equal(payload.scope, plan.scope) &&
      payload.preparedAt === plan.preparedAt &&
      equal(payload.modelPins, plan.models) &&
      equal(payload.archiveReferences, plan.archives) &&
      equal(payload.finalPublication, plan.finalPublication) &&
      equal(payload.vintageV1, plan.vintageV1) &&
      equal(payload.kospi.generationPins, plan.kospi.objects),
  );
  const capsuleRow = await one(
    "ledger_provenance_archive",
    "user_id,source_id,source_revision,source_hash,payload",
    {
      source_id: "eq." + CAPSULE_PREFIX + payload.captureManifestHash.slice(7),
      source_revision: "eq.1",
    },
  );
  requireCheck(capsuleRow.source_hash === options.expectedCapsuleHash);
  const capsule = await validateCapsule(capsuleRow, owner, "1");
  requireCheck(
    payload.sourceRosterHash === (await hashSeriesValue(capsule.frozenBaseline.orderedSources)),
  );
  requireCheck(payload.captureManifestHash === "sha256:" + capsule.capture.manifestSha256);
  for (const pin of plan.models) {
    const row = await one("ledger_model_sessions", "state_hash,payload", {
      series_id: "eq." + pin.seriesId,
      session_date: "eq." + pin.sessionDate,
    });
    requireCheck(
      row.state_hash === pin.stateHash && (await hashSeriesValue(row.payload)) === pin.payloadHash,
    );
    requireCheck(
      (
        await rows("ledger_model_sessions", "session_date", {
          series_id: "eq." + pin.seriesId,
          session_date: "gt." + pin.sessionDate,
        })
      ).length === 0,
    );
  }
  for (const pin of plan.archives) {
    const row = await one("ledger_provenance_archive", "source_hash,payload", {
      source_id: "eq." + pin.sourceId,
      source_revision: "eq.1",
    });
    requireCheck(
      row.source_hash === pin.sourceHash &&
        (await hashSeriesValue(row.payload)) === pin.payloadHash,
    );
  }
  for (const [key, id] of [
    ["registry", plan.vintageV1.registryAuditId],
    ["receipt", plan.vintageV1.receiptAuditId],
  ] as const) {
    const row = await one("shadow_replay_audit", "details", { id: "eq." + id });
    requireCheck(
      equal(
        row.details[key === "registry" ? "krSourceVintageApproval" : "krSourceVintageReview"],
        plan.vintageV1[key],
      ),
    );
  }
  const f = plan.finalPublication;
  const source = await one(
    "analysis_source_files",
    "id,max_date,file_hash,data_hash,schema_hash,validation_result",
    { id: "eq." + f.sourceId },
  );
  requireCheck(
    source.file_hash === f.fileHash &&
      source.data_hash === f.dataHash &&
      source.schema_hash === f.schemaHash &&
      (await hashSeriesValue(source.validation_result.krPublication)) === f.publicationHash,
  );
  requireCheck(krSourcePublication(source)?.phase === "FINAL");
  for (const pin of capsule.readPlan.books) {
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
      const row = await one("ledger_model_sessions", "state_hash,payload", {
        series_id: "eq." + pin.seriesId,
        session_date: "eq." + date,
      });
      requireCheck(row.state_hash === hash && row.payload.stateHash === hash);
      const { stateHash, canonicalPayload, ...body } = row.payload;
      requireCheck(
        (await hashSeriesValue(body)) === stateHash &&
          canonicalSeriesJson(body) === canonicalPayload,
      );
    }
    requireCheck(
      (
        await rows("ledger_model_sessions", "session_date", {
          series_id: "eq." + pin.seriesId,
          session_date: "gt." + pin.completedDate,
        })
      ).length === 0,
    );
  }
  // Immutable evidence source identity is re-read, not inferred from public comparison counts.
  const evidence = async (market: string, date: string, expected: string) => {
    const e = await get(
      objectPath(
        "cloudtrend-data",
        owner + `/staging/integrated-allocation-inputs/v1/${market}/${date}.json`,
        owner,
      ),
    );
    requireCheck(e.hash === expected && (await hashSeriesValue(e.payload)) === expected);
  };
  await evidence("KR", plan.scope.dates[0], payload.integrated26.originalEvidenceHash);
  requireCheck(
    capsule.readPlan.krHistoryDates.length === payload.integrated26.historyHashes.length,
  );
  for (let i = 0; i < capsule.readPlan.krHistoryDates.length; i++)
    await evidence("KR", capsule.readPlan.krHistoryDates[i], payload.integrated26.historyHashes[i]);
  await evidence("US", capsule.readPlan.previousDate, payload.integrated26.previousUsHash);
  await evidence("US", plan.scope.dates[0], payload.integrated26.currentUsHash);
  for (const pin of plan.kospi.objects) {
    const p = objectPath("cloudtrend-data", pin.path, owner).replace(
      "/object/authenticated/",
      "/object/info/",
    );
    verifyObjectGeneration(await get(p), pin.metadata);
  }
}
