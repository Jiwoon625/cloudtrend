/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { validateSourceText } from "../../src/lib/sourceData";
import { classifyKrScreeningPublication } from "../../src/lib/krScreeningPublication";
import { recordFor } from "../source-registry-store";
import { rawHash, requireCheck } from "../kr-vintage-preflight/transport";
import { same, type RecoveryOperationManifest } from "./operation-schema";
import { assertCurrentSources, type OperationConnection } from "./operation-transport";
export async function historyRegistrationIdentity(
  plan: any,
  planHash: string,
  approvalHash: string,
) {
  const c = plan.historyCorrection;
  requireCheck(
    c.status === "CANDIDATE_REVIEW_REQUIRED" &&
      c.role === "HISTORY_ONLY" &&
      c.fullMaskedEquality === true &&
      c.newerObservationsUnchanged === true &&
      same(c.currentPublicationBefore, c.currentPublicationAfter),
  );
  const digest = (
      await hashSeriesValue({ planHash, approvalHash, correctionHash: await hashSeriesValue(c) })
    ).slice(7),
    id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return {
    id,
    dataHash: c.correction.dataHash,
    fileHash: c.correction.fileHash,
    metadata: {
      version: "reviewed-history-only-v1",
      role: "HISTORY_ONLY",
      fullPlanHash: planHash,
      approvalHash,
      correctionHash: await hashSeriesValue(c),
      dataHash: c.correction.dataHash,
      schemaHash: c.correction.schemaHash,
      maxDate: c.correction.maxDate,
      currentAsOfDate: c.currentPublicationBefore.asOfDate,
      rowTransitions: c.rowMask.map((r: any) => ({
        symbol: r.symbol,
        date: r.date,
        rawBeforeHash: r.rawBeforeHash,
        rawAfterHash: r.rawAfterHash,
        changedColumns: r.changedColumns,
      })),
    },
  };
}
/** Stage-only: no activation RPC, delete, invalidation, replacement, legacy sync or actual-book path. */
export async function registerReviewedHistory(
  input: OperationConnection & {
    client: SupabaseClient;
    validateOnly?: boolean;
    manifest: RecoveryOperationManifest;
    plan: any;
    planHash: string;
    approvalHash: string;
  },
) {
  const own = await historyRegistrationIdentity(input.plan, input.planHash, input.approvalHash),
    c = input.plan.historyCorrection,
    client = input.client,
    uid = input.owner;
  await assertCurrentSources(input, input.manifest, own);
  const validation = await validateSourceText(
    c.correction.csv,
    "reviewed-current-history-correction.csv",
  );
  requireCheck(
    validation.valid &&
      validation.canonicalCsv === c.correction.csv &&
      validation.fileHash === c.correction.fileHash &&
      validation.dataHash === c.correction.dataHash &&
      validation.schemaHash === c.correction.schemaHash &&
      validation.stats.maxDate === c.correction.maxDate,
  );
  const storagePath = `${uid}/source/screening/${own.id}/reviewed-current-history-correction.csv`;
  const row = recordFor({
    id: own.id,
    userId: uid,
    sourceType: "screening",
    storagePath,
    origin: "github_action",
    validation,
    overlap: {
      incomingRows: validation.rows.length,
      newRows: 0,
      identicalRows: 0,
      conflictingRows: validation.rows.length,
      overlappingSymbols: 1,
      examples: [],
    },
  });
  Object.assign(row.validation_result, { reviewedHistoryCorrection: own.metadata });
  const find = async () => {
    const { data, error } = await client
      .from("analysis_source_files")
      .select("*")
      .eq("user_id", uid)
      .eq("id", own.id)
      .limit(2);
    requireCheck(!error && data && data.length <= 1);
    const saved = data[0];
    if (saved) {
      for (const k of Object.keys(row))
        if (k !== "status") requireCheck(same(saved[k], (row as any)[k]));
      requireCheck(["valid", "active"].includes(saved.status));
    }
    return saved;
  };
  const readBytes = async () => {
    const { data, error } = await client.storage.from("cloudtrend-data").download(storagePath);
    if (error) {
      if (String(error.statusCode) === "404" || error.message === "Object not found") return null;
      throw new Error("HISTORY_READ_REJECTED");
    }
    const b = new Uint8Array(await data.arrayBuffer());
    requireCheck(rawHash(b) === own.fileHash);
    return b;
  };
  if (input.validateOnly) {
    await find();
    await readBytes();
    return { status: "HISTORY_REGISTRATION_VALIDATED" };
  }
  if (!(await readBytes())) {
    try {
      await client.storage
        .from("cloudtrend-data")
        .upload(storagePath, c.correction.csv, { upsert: false, contentType: "text/csv" });
    } catch {
      /* exact readback */
    }
    requireCheck(await readBytes());
  }
  let saved = await find();
  if (!saved) {
    try {
      await client.from("analysis_source_files").insert(row);
    } catch {
      /* never delete uncertain commits */
    }
    saved = await find();
    requireCheck(saved);
  }
  await readBytes();
  const sources = await assertCurrentSources(input, input.manifest, own);
  requireCheck(
    sources.length === input.manifest.currentSources.length + (saved.status === "active" ? 1 : 0) &&
      same(
        classifyKrScreeningPublication(sources, input.manifest.currentAsOfDate),
        c.currentPublicationBefore,
      ),
  );
  const info = async () => {
    const { data, error } = await client.storage.from("cloudtrend-data").info(storagePath);
    requireCheck(!error && data);
    const v = data as any;
    const generation = {
      id: v.id,
      version: v.version,
      eTag: String(v.etag ?? v.eTag ?? "").replace(/^"|"$/g, ""),
      size: v.size,
      lastModified: new Date(
        v.lastModified ?? v.last_modified ?? v.updatedAt ?? v.updated_at,
      ).toISOString(),
    };
    requireCheck(
      generation.id &&
        generation.version &&
        generation.eTag &&
        generation.size === new TextEncoder().encode(c.correction.csv).byteLength,
    );
    return generation;
  };
  const generation = await info();
  await readBytes();
  requireCheck(same(await info(), generation));
  return {
    status:
      saved.status === "active"
        ? "EXACT_HISTORY_SOURCE_ALREADY_ACTIVE"
        : "HISTORY_SOURCE_STAGED_ACTIVATION_PENDING",
    activationPending: saved.status !== "active",
    storagePath,
    blobSha256: own.fileHash,
    storageGeneration: generation,
    sourceRecord: saved,
    sourceRecordHash: await hashSeriesValue(saved),
    expectedActiveRosterHash: await hashSeriesValue(input.manifest.currentSources),
    activationPolicy: "EXISTING_OWNER_SCREENING_LOCK_EXACT_ROSTER_CAS_THEN_EXISTING_MERGE_RPC",
    sourceId: own.id,
    dataHash: own.dataHash,
    effectiveAsOfPreserved: true,
    phasePreserved: true,
  };
}
