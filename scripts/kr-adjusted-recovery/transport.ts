/* eslint-disable @typescript-eslint/no-explicit-any */
/** Preparation reads and one evidence-only append. Never a model/source/approval operator. */
import fs from "node:fs";
import { recheckPreparationPins } from "./freshness";
import path from "node:path";
import { canonicalSeriesJson, hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { verifyKrSourceVintagePrivateApproval } from "../../src/lib/ledger/krSourceVintage";
import { krSourcePublication } from "../../src/lib/krScreeningPublication";
import {
  createReadOnlyTransport,
  materializeCapsule,
  rawHash,
  requireCheck,
  restPath,
  objectPath,
} from "../kr-vintage-preflight/transport";
export const PLAN = "kr-adjusted-recovery-read-plan:";
export const PREPARATION = "kr-adjusted-recovery-preparation:";
const H = /^sha256:[a-f0-9]{64}$/;
const equal = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const token = (value: unknown) => String(value ?? "").replace(/^"|"$/g, "");
export async function validatePreparationPlan(
  row: any,
  owner: string,
  hash: string,
  capsuleHash: string,
) {
  requireCheck(
    H.test(hash) &&
      H.test(capsuleHash) &&
      row.user_id === owner &&
      row.source_revision === "1" &&
      row.source_hash === hash &&
      row.source_id === PLAN + capsuleHash.slice(7) &&
      (await hashSeriesValue(row.payload)) === hash,
  );
  const p = row.payload;
  requireCheck(
    p.version === "kr-adjusted-recovery-read-plan-v1" &&
      p.kind === "RECOVERY_PREPARATION_PLAN_ONLY" &&
      p.operationalApproval === false &&
      p.historicalAvailabilityClaim === false &&
      p.capsuleHash === capsuleHash &&
      Number.isFinite(Date.parse(p.preparedAt)),
  );
  requireCheck(
    /^\d{6}$/.test(p.scope.symbol) &&
      /^\d{4}-\d{2}-\d{2}$/.test(p.scope.predecessorDate) &&
      p.scope.dates.length === 2 &&
      p.scope.dates.every(
        (d: string, i: number) =>
          /^\d{4}-\d{2}-\d{2}$/.test(d) && d > (i ? p.scope.dates[i - 1] : p.scope.predecessorDate),
      ),
  );
  requireCheck(/^https:\/\/dart\.fss\.or\.kr\//.test(p.corporateActionEvidenceUrl));
  const kinds = ["ETF_V02", "KR_KOSDAQ", "KR_KOSPI", "KR_KOSPI_CONFIRM1_BEAR", "KR_MIXED"];
  requireCheck(
    equal(
      p.models.map((r: any) => r.seriesId).sort(),
      kinds.map((k) => "adopted-shadow-2026-10-12-v1:" + k),
    ) &&
      p.models.every(
        (r: any) =>
          r.sessionDate === p.scope.predecessorDate && H.test(r.stateHash) && H.test(r.payloadHash),
      ),
  );
  requireCheck(p.archives.length === 13 && new Set(p.archives.map((r: any) => r.date)).size === 13);
  for (const r of p.archives)
    requireCheck(
      r.sourceId === `october-input:KR:${r.date}:${r.sourceHash.slice(7)}` &&
        r.sourceRevision === "1" &&
        H.test(r.sourceHash) &&
        r.payloadHash === r.sourceHash &&
        r.date <= p.scope.predecessorDate,
    );
  requireCheck(
    p.kospi.objects.length === 19 &&
      new Set(p.kospi.objects.map((r: any) => r.path)).size === 19 &&
      p.kospi.expectedPredecessorDate === p.scope.predecessorDate &&
      p.kospi.revisionId === "october14-retrospective-v1",
  );
  const root = owner + "/shadow/kospi-confirm1-bear-rsaccel-v1";
  const allowed = new RegExp(
    "^" +
      root +
      "/(?:registry\\.json|latest\\.json|sessions/\\d{4}-\\d{2}-\\d{2}\\.json|correction-approvals/october14-retrospective-v1\\.json|revisions/october14-retrospective-v1/(?:revision\\.json|registry\\.json|latest\\.json|sessions/\\d{4}-\\d{2}-\\d{2}\\.json))$",
  );
  for (const o of p.kospi.objects)
    requireCheck(
      allowed.test(o.path) &&
        o.metadata.id &&
        o.metadata.version &&
        o.metadata.eTag &&
        Number.isSafeInteger(o.metadata.size) &&
        o.metadata.size > 0 &&
        Number.isFinite(Date.parse(o.metadata.updatedAt)),
    );
  const v = p.vintageV1;
  requireCheck(
    (await hashSeriesValue(v.registry)) === v.registryHash &&
      (await hashSeriesValue(v.receipt)) === v.receiptHash,
  );
  await verifyKrSourceVintagePrivateApproval({ registry: v.registry, receipt: v.receipt });
  return p;
}
export function verifyObjectGeneration(info: any, pin: any) {
  requireCheck(
    info.id === pin.id &&
      info.version === pin.version &&
      Number(info.size) === pin.size &&
      token(info.etag ?? info.eTag) === token(pin.eTag) &&
      Date.parse(info.last_modified ?? info.updated_at) === Date.parse(pin.updatedAt),
  );
}
export async function materializePreparation(options: {
  origin: string;
  key: string;
  owner: string;
  capsuleHash: string;
  planHash: string;
  directory: string;
  codeVersion: string;
  fetcher?: typeof fetch;
}) {
  const { owner, directory } = options;
  requireCheck(/^[a-f0-9]{40}$/.test(options.codeVersion));
  const inputPath = await materializeCapsule({
    origin: options.origin,
    key: options.key,
    owner,
    revision: "1",
    expectedCapsuleHash: options.capsuleHash,
    directory,
    fetcher: options.fetcher,
  });
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  let n = 1000;
  const save = (value: any) => {
    const filename = path.join(directory, `${n++}.json`),
      bytes = canonicalSeriesJson(value);
    fs.writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
    return { path: filename, sha256: rawHash(bytes) };
  };
  const allowed = new Set<string>(),
    headers = new Map<string, Headers>();
  const read = createReadOnlyTransport(
    options.origin,
    options.key,
    allowed,
    options.fetcher,
    (p, r) => headers.set(p, r.headers),
  );
  const get = async (p: string, limit = 16 * 1024 * 1024) => {
    allowed.add(p);
    return read(p, limit);
  };
  const row = async (table: string, select: string, filters: Record<string, string>) => {
    const rows = JSON.parse((await get(restPath(table, owner, select, filters))).toString());
    requireCheck(Array.isArray(rows) && rows.length === 1);
    return rows[0];
  };
  const planRow = await row(
    "ledger_provenance_archive",
    "user_id,source_id,source_revision,source_hash,payload",
    { source_id: "eq." + PLAN + options.capsuleHash.slice(7), source_revision: "eq.1" },
  );
  const plan = await validatePreparationPlan(planRow, owner, options.planHash, options.capsuleHash);
  requireCheck(
    plan.scope.symbol === input.scope.symbol &&
      equal(plan.scope.dates, [input.scope.targetDate, input.scope.baselineAsOfDate]),
  );
  const f = plan.finalPublication;
  const source = await row(
    "analysis_source_files",
    "id,max_date,file_hash,data_hash,schema_hash,validation_result,activated_at",
    { id: "eq." + f.sourceId },
  );
  requireCheck(
    source.file_hash === f.fileHash &&
      source.data_hash === f.dataHash &&
      source.schema_hash === f.schemaHash &&
      (await hashSeriesValue(source.validation_result.krPublication)) === f.publicationHash,
  );
  const final = krSourcePublication(source);
  requireCheck(
    final?.phase === "FINAL" &&
      final.asOfDate === input.scope.baselineAsOfDate &&
      rawHash(final.manifestText) === final.manifestSha256,
  );
  const models = [];
  for (const r of plan.models) {
    const v = await row("ledger_model_sessions", "series_id,session_date,state_hash,payload", {
      series_id: "eq." + r.seriesId,
      session_date: "eq." + r.sessionDate,
    });
    requireCheck(
      v.state_hash === r.stateHash &&
        v.payload.stateHash === r.stateHash &&
        (await hashSeriesValue(v.payload)) === r.payloadHash,
    );
    models.push({ ...r, ref: save(v.payload) });
  }
  const archives = [];
  for (const r of plan.archives) {
    const v = await row("ledger_provenance_archive", "source_hash,payload", {
      source_id: "eq." + r.sourceId,
      source_revision: "eq.1",
    });
    requireCheck(
      v.source_hash === r.sourceHash &&
        (await hashSeriesValue(v.payload)) === r.payloadHash &&
        v.payload.date === r.date,
    );
    archives.push({ ...r, ref: save(v.payload) });
  }
  for (const [key, id] of [
    ["registry", plan.vintageV1.registryAuditId],
    ["receipt", plan.vintageV1.receiptAuditId],
  ] as const) {
    const v = await row("shadow_replay_audit", "details", { id: "eq." + id });
    requireCheck(
      equal(
        v.details[key === "registry" ? "krSourceVintageApproval" : "krSourceVintageReview"],
        plan.vintageV1[key],
      ),
    );
  }
  const objects = [];
  for (const pin of plan.kospi.objects) {
    const p = objectPath("cloudtrend-data", pin.path, owner),
      infoPath = p.replace("/object/authenticated/", "/object/info/");
    verifyObjectGeneration(JSON.parse((await get(infoPath)).toString()), pin.metadata);
    const raw = await get(p);
    requireCheck(
      raw.length === pin.metadata.size &&
        token(headers.get(p)?.get("etag")) === token(pin.metadata.eTag),
    );
    verifyObjectGeneration(JSON.parse((await get(infoPath)).toString()), pin.metadata);
    const payload = JSON.parse(raw.toString());
    objects.push({
      path: pin.path,
      metadata: pin.metadata,
      byteHash: rawHash(raw),
      hash: await hashSeriesValue(payload),
      ref: save(payload),
      stateHashPreapproved: false,
    });
  }
  input.calculatedAt = plan.preparedAt;
  input.recoveryPreparation = {
    owner,
    plan: save(plan),
    planHash: options.planHash,
    capsuleHash: options.capsuleHash,
    codeVersion: options.codeVersion,
    models,
    archives,
    objects,
    finalSource: save(source),
  };
  const target = path.join(directory, "preparation-input.json");
  fs.writeFileSync(target, canonicalSeriesJson(input), { flag: "wx", mode: 0o600 });
  return target;
}
/** One fixed owner-private evidence append. An uncertain response is read back, never blindly retried. */
export async function appendPreparation(options: {
  origin: string;
  key: string;
  owner: string;
  payload: any;
  expectedPlanHash: string;
  expectedCapsuleHash: string;
  fetcher?: typeof fetch;
}) {
  const { payload, owner } = options;
  requireCheck(
    payload.planHash === options.expectedPlanHash &&
      payload.capsuleHash === options.expectedCapsuleHash,
  );
  requireCheck(
    payload.version === "kr-adjusted-recovery-preparation-v1" &&
      payload.kind === "RECOVERY_PREPARATION_ONLY" &&
      payload.status === "REVIEW_REQUIRED" &&
      payload.operationalApproval === false &&
      H.test(payload.planHash) &&
      H.test(payload.capsuleHash),
  );
  const sourceId = PREPARATION + payload.planHash.slice(7),
    hash = await hashSeriesValue(payload);
  const selector = restPath(
    "ledger_provenance_archive",
    owner,
    "user_id,source_id,source_revision,source_hash,payload",
    { source_id: "eq." + sourceId, source_revision: "eq.1" },
  );
  const read = createReadOnlyTransport(
    options.origin,
    options.key,
    new Set([selector]),
    options.fetcher,
  );
  const find = async () => {
    const rows = JSON.parse((await read(selector, 32 * 1024 * 1024)).toString());
    requireCheck(Array.isArray(rows) && rows.length <= 1);
    if (rows[0]) requireCheck(rows[0].source_hash === hash && equal(rows[0].payload, payload));
    return rows[0];
  };
  if (await find()) return { reused: true, hash };
  await recheckPreparationPins(options);
  const body = {
    user_id: owner,
    source_id: sourceId,
    source_revision: "1",
    source_hash: hash,
    payload,
  };
  requireCheck(Buffer.byteLength(canonicalSeriesJson(body)) <= 24 * 1024 * 1024);
  // No caller-supplied method/table/path. Origin was validated by the read-only constructor.
  try {
    await (options.fetcher ?? fetch)(
      new URL("/rest/v1/ledger_provenance_archive", options.origin),
      {
        method: "POST",
        headers: {
          apikey: options.key,
          Authorization: "Bearer " + options.key,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(body),
        redirect: "error",
      },
    );
  } catch {
    /* Commit uncertainty requires exact readback, not another insert. */
  }
  requireCheck(await find());
  return { reused: false, hash };
}
