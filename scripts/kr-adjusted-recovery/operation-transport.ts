/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { hashSeriesValue, canonicalSeriesJson } from "../../src/lib/ledger/modelSeries";
import {
  createReadOnlyTransport,
  objectPath,
  rawHash,
  requireCheck,
} from "../kr-vintage-preflight/transport";
import { materializePreparation, PREPARATION } from "./transport";
import { recheckPreparationPins } from "./freshness";
import { verifyPreparationPayload } from "./verify";
import {
  encodeRecoveryEvidence,
  decodeRecoveryEvidence,
  preparationSourceId,
} from "./evidence-storage";
import {
  OPERATION_MANIFEST,
  FULL_PLAN,
  APPLY_APPROVAL,
  HASH,
  same,
  validateOperationManifest,
  verifyActualLedger,
  verifyFullRecoveryPlan,
  type RecoveryOperationManifest,
} from "./operation-schema";
export interface OperationConnection {
  origin: string;
  key: string;
  owner: string;
  fetcher?: typeof fetch;
}
/** Fixed schema, owner-scoped reads; caller never supplies a URL or method. */
export function operationReader(o: OperationConnection) {
  const allowed = new Set<string>(),
    read = createReadOnlyTransport(o.origin, o.key, allowed, o.fetcher);
  const get = async (p: string, limit = 64 * 1024 * 1024) => {
    allowed.add(p);
    return read(p, limit);
  };
  const rows = async (
    table: string,
    select: string,
    filters: Record<string, string> = {},
    limit = 2,
    order?: string,
  ) => {
    const fields: Record<string, string[]> = {
      ledger_provenance_archive: ["source_id", "source_revision"],
      ledger_model_series: ["series_id"],
      ledger_model_sessions: ["series_id", "session_date"],
      analysis_source_files: ["id", "source_type", "status"],
      portfolio_ledgers: [],
      us_actual_portfolio_ledgers: [],
    };
    requireCheck(
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(o.owner) &&
        fields[table] &&
        Object.keys(filters).every((k) => fields[table].includes(k)) &&
        limit >= 1 &&
        limit <= 513,
    );
    const q = new URLSearchParams({
      select,
      user_id: "eq." + o.owner,
      ...filters,
      limit: String(limit),
      ...(order ? { order } : {}),
    });
    const result = JSON.parse((await get(`/rest/v1/${table}?${q}`)).toString());
    requireCheck(Array.isArray(result) && result.length <= limit);
    return result;
  };
  const one = async (table: string, select: string, filters: Record<string, string> = {}) => {
    const r = await rows(table, select, filters);
    requireCheck(r.length === 1);
    return r[0];
  };
  const archive = async (prefix: string, identityHash: string, expectedHash: string) => {
    requireCheck(
      [OPERATION_MANIFEST, FULL_PLAN, APPLY_APPROVAL, PREPARATION].includes(prefix) &&
        HASH.test(identityHash) &&
        HASH.test(expectedHash),
    );
    const sourceId =
      prefix === PREPARATION
        ? preparationSourceId(identityHash, expectedHash)
        : prefix + identityHash.slice(7);
    const r = await one(
      "ledger_provenance_archive",
      "user_id,source_id,source_revision,source_hash,payload,recorded_at",
      { source_id: "eq." + sourceId, source_revision: "eq.1" },
    );
    const payload =
      prefix === PREPARATION || prefix === FULL_PLAN
        ? await decodeRecoveryEvidence(
            r.payload,
            r.source_hash,
            expectedHash,
            prefix === PREPARATION ? "PREPARATION" : "FULL_PLAN",
          )
        : r.payload;
    if (prefix === PREPARATION) requireCheck(payload.planHash === identityHash);
    if (prefix !== PREPARATION && prefix !== FULL_PLAN) {
      requireCheck(
        r.source_hash === expectedHash && (await hashSeriesValue(payload)) === expectedHash,
      );
      return r;
    }
    requireCheck(
      r.user_id === o.owner && r.source_id === sourceId && String(r.source_revision) === "1",
    );
    // Explicit hydrated view: do not relabel the stored-envelope digest as the logical receipt digest.
    const { source_hash: storageHash, payload: _storedPayload, ...identity } = r;
    return { ...identity, storageHash, receiptHash: expectedHash, payload };
  };
  return {
    rows,
    one,
    archive,
    object: async (p: string) => get(objectPath("cloudtrend-data", p, o.owner)),
  };
}
export async function assertActualState(o: OperationConnection, m: RecoveryOperationManifest) {
  const r = operationReader(o);
  for (const pin of m.actualLedgers)
    await verifyActualLedger(await r.one(pin.table, "user_id,revision,updated_at,payload"), pin);
}
export async function assertModelInventory(
  o: OperationConnection,
  m: RecoveryOperationManifest,
  additions: any[] = [],
) {
  const r = operationReader(o),
    rows = await r.rows(
      "ledger_model_sessions",
      "series_id,session_date,state_hash,payload",
      {},
      513,
      "series_id.asc,session_date.asc",
    );
  requireCheck(rows.length < 513);
  const allowed = [
    ...m.modelInventory,
    ...additions.map((x) => ({
      seriesId: x.bookId,
      date: x.receipt.date,
      stateHash: x.stateHash,
      payloadHash: null,
      payload: x,
    })),
  ];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.series_id + ":" + row.session_date,
      p = allowed.find((x) => x.seriesId === row.series_id && x.date === row.session_date);
    requireCheck(p && !seen.has(key) && row.state_hash === p.stateHash);
    seen.add(key);
    requireCheck(
      p.payloadHash
        ? (await hashSeriesValue(row.payload)) === p.payloadHash
        : same(row.payload, p.payload),
    );
  }
  for (const p of m.modelInventory) requireCheck(seen.has(p.seriesId + ":" + p.date));
}
export async function assertCurrentSources(
  o: OperationConnection,
  m: RecoveryOperationManifest,
  ownCorrection?: any,
) {
  const r = operationReader(o),
    rows = await r.rows(
      "analysis_source_files",
      "*",
      { source_type: "eq.screening", status: "eq.active" },
      129,
      "activated_at.asc,created_at.asc,id.asc",
    );
  requireCheck(rows.length < 129);
  const original = rows.filter((x: any) => x.id !== ownCorrection?.id);
  requireCheck(original.length === m.currentSources.length);
  for (let i = 0; i < original.length; i++)
    for (const k of Object.keys(m.currentSources[i]))
      requireCheck(same(original[i][k], m.currentSources[i][k]));
  if (ownCorrection) {
    const found = rows.find((x: any) => x.id === ownCorrection.id);
    if (found)
      requireCheck(
        found.data_hash === ownCorrection.dataHash &&
          found.file_hash === ownCorrection.fileHash &&
          same(found.validation_result?.reviewedHistoryCorrection, ownCorrection.metadata),
      );
  }
  return rows;
}
export async function materializeOperation(
  o: OperationConnection & { manifestHash: string; directory: string; codeVersion: string },
) {
  const r = operationReader(o),
    mr = await r.archive(OPERATION_MANIFEST, o.manifestHash, o.manifestHash),
    m = await validateOperationManifest(mr.payload, o.manifestHash, o.owner);
  requireCheck(m.codeCommit === o.codeVersion);
  const prep = await r.archive(PREPARATION, m.preparationReadPlanHash, m.preparationHash);
  requireCheck(
    new Date(prep.recorded_at).toISOString() === new Date(m.preparationRecordedAt).toISOString(),
  );
  await verifyPreparationPayload(prep.payload, m.preparationReadPlanHash, m.capsuleHash);
  await assertActualState(o, m);
  await assertModelInventory(o, m);
  await assertCurrentSources(o, m);
  await materializePreparation({
    ...o,
    capsuleHash: m.capsuleHash,
    planHash: m.preparationReadPlanHash,
  });
  const inputPath = path.join(o.directory, "preparation-input.json"),
    input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  let n = 10000;
  const save = (bytes: Uint8Array | string) => {
    const p = path.join(o.directory, `${n++}.json`);
    fs.writeFileSync(p, bytes, { flag: "wx", mode: 0o600 });
    return { path: p, sha256: rawHash(bytes) };
  };
  const json = (x: any) => save(canonicalSeriesJson(x));
  const registries = [];
  for (const p of m.registries) {
    const row = await r.one("ledger_model_series", "series_id,payload", {
      series_id: "eq." + p.seriesId,
    });
    requireCheck((await hashSeriesValue(row.payload)) === p.payloadHash);
    registries.push({ ...p, ref: json(row.payload) });
  }
  const usBytes = await r.object(m.usNext.path),
    us = JSON.parse(usBytes.toString());
  requireCheck(
    us.hash === m.usNext.payloadHash &&
      (await hashSeriesValue(us.payload)) === us.hash &&
      us.payload.clock.sourceHash === m.usNext.sourceHash &&
      us.payload.analysis.date === m.usNext.date,
  );
  const current = [];
  for (const p of m.currentSources) {
    const existing = input.sources.find((x: any) => x.id === p.id);
    if (existing) {
      current.push({ ...p, ref: existing });
      continue;
    }
    const bytes = await r.object(p.storage_path);
    requireCheck(rawHash(bytes) === p.file_hash);
    current.push({ ...p, ref: save(bytes) });
  }
  input.operation = {
    manifest: json(m),
    manifestHash: o.manifestHash,
    preparation: json(prep.payload),
    preparationRecordedAt: prep.recorded_at,
    registries,
    usNext: json(us.payload),
    currentSources: current,
  };
  fs.writeFileSync(path.join(o.directory, "operation-input.json"), JSON.stringify(input), {
    flag: "wx",
    mode: 0o600,
  });
  return m;
}
/** Sole evidence INSERT; uncertain responses are resolved by one readback, never retry/upsert. */
export async function appendOperationPlan(
  o: OperationConnection & {
    manifestHash: string;
    manifest: RecoveryOperationManifest;
    preparation: any;
    payload: any;
  },
) {
  await validateOperationManifest(o.manifest, o.manifestHash, o.owner);
  const hash = await hashSeriesValue(o.payload);
  await verifyFullRecoveryPlan(o.payload, hash, o.manifest, o.manifestHash);
  const r = operationReader(o),
    sourceId = FULL_PLAN + o.manifestHash.slice(7);
  const body = {
    user_id: o.owner,
    source_id: sourceId,
    source_revision: "1",
    source_hash: hash,
    payload: o.payload,
  };
  requireCheck(Buffer.byteLength(canonicalSeriesJson(body)) <= 32 * 1024 * 1024);
  const encoded = await encodeRecoveryEvidence(o.payload, "FULL_PLAN");
  requireCheck(encoded.receiptHash === hash);
  const find = async () => {
    const rows = await r.rows("ledger_provenance_archive", "source_hash,payload", {
      source_id: "eq." + sourceId,
      source_revision: "eq.1",
    });
    requireCheck(rows.length <= 1);
    if (rows[0]) {
      requireCheck(
        same(
          await decodeRecoveryEvidence(rows[0].payload, rows[0].source_hash, hash, "FULL_PLAN"),
          o.payload,
        ),
      );
      if (Object.hasOwn(rows[0].payload, "storageFormat"))
        requireCheck(rows[0].source_hash === encoded.storageHash);
    }
    return rows[0];
  };
  const existing = await find();
  if (existing) return { hash, storageHash: existing.source_hash, reused: true };
  await r.archive(OPERATION_MANIFEST, o.manifestHash, o.manifestHash);
  await r.archive(PREPARATION, o.manifest.preparationReadPlanHash, o.manifest.preparationHash);
  await recheckPreparationPins({
    ...o,
    payload: o.preparation,
    expectedPlanHash: o.manifest.preparationReadPlanHash,
    expectedCapsuleHash: o.manifest.capsuleHash,
  });
  await assertActualState(o, o.manifest);
  await assertModelInventory(o, o.manifest);
  await assertCurrentSources(o, o.manifest);
  const storedBody = { ...body, source_hash: encoded.storageHash, payload: encoded.payload };
  requireCheck(Buffer.byteLength(canonicalSeriesJson(storedBody)) <= 32 * 1024 * 1024);
  try {
    await (o.fetcher ?? fetch)(new URL("/rest/v1/ledger_provenance_archive", o.origin), {
      method: "POST",
      headers: {
        apikey: o.key,
        Authorization: "Bearer " + o.key,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(storedBody),
      redirect: "error",
    });
  } catch {
    /* exact readback only */
  }
  const saved = await find();
  requireCheck(saved);
  return { hash, storageHash: saved.source_hash, reused: false };
}
