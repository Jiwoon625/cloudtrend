/* eslint-disable @typescript-eslint/no-explicit-any */
/** Owner-private, bounded transport. No collector, source registration or historical backdating. */
import { createGzip, gunzipSync } from "node:zlib";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import {
  canonicalSeriesJson,
  hashSeriesValue,
  type SeriesHash,
} from "../../src/lib/ledger/modelSeries";
import { parseManualMarketDataWithReferences } from "../../src/lib/krxReviewReferenceParser";
import { validateSourceBytes } from "../../src/lib/sourceData";
import {
  classifyKrScreeningPublication,
  krSourcePublication,
  unresolvedKrPendingSources,
} from "../../src/lib/krScreeningPublication";
import { verifyKrSourceVintagePrivateApproval } from "../../src/lib/ledger/krSourceVintage";
import {
  createReadOnlyTransport,
  objectPath,
  rawHash,
  requireCheck,
} from "../kr-vintage-preflight/transport";
import type {
  FinalCapture,
  FinalCaptureV1,
  FinalPriorRecoveryPins,
  FinalPriorRecoveryLineage,
} from "./contracts";
import {
  encodeFinalCapture,
  captureCanonicalChunks,
  captureCanonicalProof,
  type CaptureCodecDiagnostic,
} from "./capture-codec";
import { decodeRecoveryEvidence } from "../kr-adjusted-recovery/evidence-storage";
import octoberRuntime from "../../src/lib/ledger/octoberShadowEngineManifest.generated.json";
import kospiRuntime from "../../src/lib/kospiShadowPublicationRuntime.generated.json";

export const PREFIX = "kr-final-retrospective-";
export const H = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const kinds = ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "ETF_V02", "KR_KOSPI_CONFIRM1_BEAR"];
export const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
export interface Connection {
  origin: string;
  key: string;
  owner: string;
  fetcher?: typeof fetch;
}
export interface Request {
  version: "kr-final-retrospective-request-v1" | "kr-final-retrospective-request-v2";
  priorRecovery?: FinalPriorRecoveryPins;
  owner: string;
  codeCommit: string;
  operationalApproval: false;
  historicalAvailabilityClaim: false;
  predecessorDate: string;
  targetDates: string[];
  preparedAt: string;
  config: FinalCapture["config"];
  /** PLAN bootstrap only; final approval binds all full captured model rows. */
  modelInventoryProjection: "series-date-state-recorded-v1";
  expected: { sources: SeriesHash; models: SeriesHash; registries: SeriesHash; actual: SeriesHash };
  legacy: Array<{ path: string; generation: any; hash?: SeriesHash }>;
}
export function reader(o: Connection) {
  requireCheck(UUID.test(o.owner));
  const allowed = new Set<string>();
  const read = createReadOnlyTransport(o.origin, o.key, allowed, o.fetcher, undefined, "identity");
  const get = async (p: string, limit = 80 * 1024 * 1024) => {
    allowed.add(p);
    return read(p, limit);
  };
  const tables: Record<string, string[]> = {
    analysis_source_files: ["source_type", "status"],
    ledger_model_sessions: ["series_id", "session_date"],
    ledger_model_series: [],
    portfolio_ledgers: [],
    us_actual_portfolio_ledgers: [],
    actual_entry_decisions: [],
    portfolio_settings: [],
    portfolio_trades: [],
    portfolio_signal_log: [],
    us_portfolio_trades: [],
    us_portfolio_snapshots: [],
    ledger_provenance_archive: ["source_id", "source_revision"],
    shadow_replay_audit: ["market", "strategy_version"],
  };
  const rows = async (
    table: string,
    filters: Record<string, string> = {},
    limit = 513,
    order?: string,
    maxBytes = 80 * 1024 * 1024,
  ) => {
    requireCheck(
      Number.isSafeInteger(maxBytes) &&
        maxBytes > 0 &&
        maxBytes <= 80 * 1024 * 1024 &&
        tables[table] &&
        Object.keys(filters).every((k) => tables[table].includes(k)) &&
        limit > 0 &&
        limit <= 513,
    );
    const q = new URLSearchParams({
      select: "*",
      user_id: "eq." + o.owner,
      ...filters,
      limit: String(limit),
      ...(order ? { order } : {}),
    });
    const value = JSON.parse((await get("/rest/v1/" + table + "?" + q, maxBytes)).toString());
    requireCheck(
      Array.isArray(value) && value.length < limit && value.every((x) => x.user_id === o.owner),
    );
    return value;
  };
  const infoPath = (p: string) =>
    objectPath("cloudtrend-data", p, o.owner).replace("/object/authenticated/", "/object/info/");
  const info = async (p: string) => JSON.parse((await get(infoPath(p), 1024 * 1024)).toString());
  const object = async (p: string, expectedHash?: string, expectedGeneration?: any) => {
    const before = await info(p);
    const generation = normalizeGeneration(before);
    if (expectedGeneration) requireCheck(same(generation, expectedGeneration));
    const bytes = await get(objectPath("cloudtrend-data", p, o.owner));
    requireCheck(
      bytes.length === generation.size && (!expectedHash || rawHash(bytes) === expectedHash),
    );
    requireCheck(same(generation, normalizeGeneration(await info(p))));
    return { bytes, generation, hash: rawHash(bytes) as SeriesHash };
  };
  return { rows, info, object };
}
export function normalizeGeneration(v: any) {
  const result = {
    id: v.id,
    version: v.version,
    eTag: String(v.etag ?? v.eTag ?? "").replace(/^"|"$/g, ""),
    size: Number(v.size),
    updatedAt: new Date(v.last_modified ?? v.updated_at).toISOString(),
  };
  requireCheck(
    typeof result.id === "string" &&
      typeof result.version === "string" &&
      result.eTag.length > 0 &&
      Number.isSafeInteger(result.size) &&
      result.size > 0,
  );
  return result;
}
/** Storage listing is a read-only POST; fixed owner namespace, bounded traversal, no arbitrary operation. */
export async function legacyInventory(o: Connection) {
  reader(o); // Validate HTTPS Supabase origin and owner before credential use.
  const root = o.owner + "/shadow/kospi-confirm1-bear-rsaccel-v1",
    queue = [root],
    paths: string[] = [];
  while (queue.length) {
    requireCheck(queue.length + paths.length < 256);
    const prefix = queue.shift()!;
    const response = await (o.fetcher ?? fetch)(
      new URL("/storage/v1/object/list/cloudtrend-data", o.origin),
      {
        method: "POST",
        headers: {
          apikey: o.key,
          Authorization: "Bearer " + o.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prefix,
          limit: 257,
          offset: 0,
          sortBy: { column: "name", order: "asc" },
        }),
        redirect: "error",
        cache: "no-store",
      },
    );
    requireCheck(response.ok);
    const text = await response.text();
    requireCheck(text.length <= 1024 * 1024);
    const entries = JSON.parse(text);
    requireCheck(Array.isArray(entries) && entries.length < 257);
    for (const entry of entries) {
      requireCheck(
        typeof entry.name === "string" &&
          /^[a-zA-Z0-9_.-]+$/.test(entry.name) &&
          entry.name !== "." &&
          entry.name !== "..",
      );
      const p = prefix + "/" + entry.name;
      if (entry.id === null) {
        requireCheck(p.split("/").length < 10);
        queue.push(p);
      } else {
        requireCheck(typeof entry.id === "string");
        paths.push(p);
      }
    }
  }
  requireCheck(paths.length <= 256 && new Set(paths).size === paths.length);
  return paths.sort();
}
export async function snapshot(o: Connection) {
  const r = reader(o);
  const [sources, models, registries, kr, us] = await Promise.all([
    r.rows(
      "analysis_source_files",
      { source_type: "eq.screening", status: "eq.active" },
      129,
      "activated_at.asc.nullsfirst,created_at.asc,id.asc",
    ),
    r.rows("ledger_model_sessions", {}, 513, "series_id.asc,session_date.asc"),
    r.rows("ledger_model_series", {}, 65, "series_id.asc"),
    r.rows("portfolio_ledgers", {}, 2),
    r.rows("us_actual_portfolio_ledgers", {}, 2),
  ]);
  requireCheck(
    sources.length > 0 &&
      models.length > 0 &&
      registries.length > 0 &&
      kr.length === 1 &&
      us.length === 1,
  );
  const actual: Record<string, any[]> = { portfolio_ledgers: kr, us_actual_portfolio_ledgers: us };
  for (const table of [
    "actual_entry_decisions",
    "portfolio_settings",
    "portfolio_trades",
    "portfolio_signal_log",
    "us_portfolio_trades",
    "us_portfolio_snapshots",
  ])
    actual[table] = (await r.rows(table, {}, 513)).sort((a, b) =>
      canonicalSeriesJson(a).localeCompare(canonicalSeriesJson(b)),
    );
  return { sources, models, registries, actual };
}
export async function validateRequest(
  value: Request,
  expectedHash: string,
  owner: string,
  codeCommit: string,
) {
  requireCheck(
    H.test(expectedHash) &&
      (await hashSeriesValue(value)) === expectedHash &&
      ["kr-final-retrospective-request-v1", "kr-final-retrospective-request-v2"].includes(
        value.version,
      ) &&
      value.owner === owner &&
      value.codeCommit === codeCommit &&
      /^[a-f0-9]{40}$/.test(codeCommit),
  );
  requireCheck(
    value.operationalApproval === false &&
      value.historicalAvailabilityClaim === false &&
      Number.isFinite(Date.parse(value.preparedAt)),
  );
  requireCheck(
    value.predecessorDate === "2026-10-27" && same(value.targetDates, ["2026-10-28", "2026-10-29"]),
  );
  requireCheck(
    Object.values(value.expected).length === 4 &&
      Object.values(value.expected).every((h) => H.test(h)),
  );
  requireCheck(value.modelInventoryProjection === "series-date-state-recorded-v1");
  if (value.version === "kr-final-retrospective-request-v2") {
    requireCheck(
      exactKeys(value, [
        "version",
        "priorRecovery",
        "owner",
        "codeCommit",
        "operationalApproval",
        "historicalAvailabilityClaim",
        "predecessorDate",
        "targetDates",
        "preparedAt",
        "config",
        "modelInventoryProjection",
        "expected",
        "legacy",
      ]),
    );
    validatePriorRecoveryPins(value.priorRecovery);
  } else requireCheck(value.priorRecovery === undefined);
  const root = owner + "/shadow/kospi-confirm1-bear-rsaccel-v1/";
  requireCheck(
    value.legacy.length > 0 &&
      value.legacy.length <= 256 &&
      new Set(value.legacy.map((x) => x.path)).size === value.legacy.length,
  );
  for (const x of value.legacy) {
    objectPath("cloudtrend-data", x.path, owner);
    requireCheck(
      x.path.startsWith(root) &&
        /\.json$/.test(x.path) &&
        (!x.hash || H.test(x.hash)) &&
        same(
          normalizeGeneration({
            id: x.generation.id,
            version: x.generation.version,
            eTag: x.generation.eTag,
            size: x.generation.size,
            updated_at: x.generation.updatedAt,
          }),
          x.generation,
        ),
    );
  }
  return value;
}
export async function readEvidence(
  o: Connection,
  kind: "request" | "plan" | "approval" | "completion" | "capture" | "execution" | "diagnosis",
  hash: string,
) {
  requireCheck(
    H.test(hash) &&
      ["request", "plan", "approval", "completion", "capture", "execution", "diagnosis"].includes(
        kind,
      ),
  );
  const rows = await reader(o).rows(
    "ledger_provenance_archive",
    { source_id: "eq." + PREFIX + kind + ":" + hash.slice(7), source_revision: "eq.1" },
    2,
  );
  requireCheck(
    rows.length === 1 &&
      rows[0].source_revision === "1" &&
      rows[0].source_id === PREFIX + kind + ":" + hash.slice(7),
  );
  const decoded = await decodeStoredEvidence(o, rows[0].payload, rows[0].source_hash, hash);
  if (kind === "diagnosis") validateBlockedEvidence(decoded);
  if (kind === "plan")
    requireCheck(
      decoded?.version !== "kr-final-retrospective-blocked-v1" && decoded?.status !== "BLOCKED",
    );
  return decoded;
}
export async function encodeEvidence(payload: any) {
  const proof = captureCanonicalProof(payload);
  requireCheck(proof.bytes > 0 && proof.bytes <= 256 * 1024 * 1024);
  const digest = createHash("sha256");
  let actualBytes = 0,
    compressedBytes = 0;
  const pieces: Buffer[] = [];
  function* measured() {
    for (const chunk of captureCanonicalChunks(payload)) {
      actualBytes += chunk.length;
      requireCheck(actualBytes <= 256 * 1024 * 1024);
      digest.update(chunk);
      yield chunk;
    }
  }
  await pipeline(
    Readable.from(measured(), { objectMode: false }),
    createGzip({ level: 9 }),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        compressedBytes += chunk.length;
        if (compressedBytes > 48 * 1024 * 1024) {
          callback(new Error("EVIDENCE_COMPRESSED_LIMIT"));
          return;
        }
        pieces.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  requireCheck(actualBytes === proof.bytes && "sha256:" + digest.digest("hex") === proof.hash);
  const compressed = Buffer.concat(pieces, compressedBytes),
    encoded = compressed.toString("base64");
  requireCheck(encoded.length <= 64 * 1024 * 1024);
  const envelope = {
    version: "kr-final-retrospective-evidence-gzip-v1",
    hash: proof.hash,
    bytes: proof.bytes,
    compressedHash: rawHash(compressed),
    payload: encoded,
  };
  return { envelope, storageHash: captureCanonicalProof(envelope).hash, hash: proof.hash };
}
export async function decodeEvidence(stored: any, storageHash: string, expectedHash: string) {
  requireCheck(
    H.test(storageHash) &&
      H.test(expectedHash) &&
      captureCanonicalProof(stored).hash === storageHash,
  );
  if (stored.version !== "kr-final-retrospective-evidence-gzip-v1") {
    requireCheck(storageHash === expectedHash);
    return stored;
  }
  requireCheck(
    same(
      Object.keys(stored).sort(),
      ["version", "hash", "bytes", "compressedHash", "payload"].sort(),
    ) &&
      stored.hash === expectedHash &&
      Number.isSafeInteger(stored.bytes) &&
      stored.bytes > 0 &&
      stored.bytes <= 256 * 1024 * 1024 &&
      typeof stored.payload === "string" &&
      stored.payload.length <= 64 * 1024 * 1024,
  );
  const compressed = Buffer.from(stored.payload, "base64");
  requireCheck(
    compressed.toString("base64") === stored.payload &&
      rawHash(compressed) === stored.compressedHash,
  );
  const bytes = gunzipSync(compressed, { maxOutputLength: stored.bytes });
  requireCheck(bytes.length === stored.bytes && rawHash(bytes) === expectedHash);
  const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const canonical = captureCanonicalProof(payload);
  requireCheck(canonical.hash === expectedHash && canonical.bytes === bytes.length);
  return payload;
}
/** Bounds include the entire serialized INSERT body, not just compressed data. */
export const EVIDENCE_POST_LIMIT = 300 * 1024;
export const EVIDENCE_CHUNK_SIZE = 256 * 1024;
const CHUNK_VERSION = "kr-final-retrospective-evidence-chunk-v1";
const MANIFEST_VERSION = "kr-final-retrospective-evidence-manifest-v1";
const MAX_CHUNKS = 256;
function evidenceBody(o: Connection, sourceId: string, storageHash: string, payload: any) {
  return JSON.stringify({
    user_id: o.owner,
    source_id: sourceId,
    source_revision: "1",
    source_hash: storageHash,
    payload,
  });
}
/** Serial one-shot immutable INSERT. An uncertain response is read back, never retried here. */
async function appendEvidenceRow(o: Connection, sourceId: string, payload: any) {
  const storageHash = captureCanonicalProof(payload).hash;
  const body = evidenceBody(o, sourceId, storageHash, payload);
  requireCheck(Buffer.byteLength(body, "utf8") <= EVIDENCE_POST_LIMIT);
  const r = reader(o);
  const find = async () => {
    const rows = await r.rows(
      "ledger_provenance_archive",
      { source_id: "eq." + sourceId, source_revision: "eq.1" },
      2,
      undefined,
      EVIDENCE_POST_LIMIT + 4096,
    );
    requireCheck(rows.length <= 1);
    if (rows.length === 1)
      requireCheck(
        rows[0].source_id === sourceId &&
          rows[0].source_revision === "1" &&
          rows[0].source_hash === storageHash &&
          captureCanonicalProof(rows[0].payload).hash === storageHash,
      );
    return rows.length === 1;
  };
  if (await find()) return storageHash;
  let status: number | "NETWORK" = "NETWORK";
  try {
    const response = await (o.fetcher ?? fetch)(
      new URL("/rest/v1/ledger_provenance_archive", o.origin),
      {
        method: "POST",
        headers: {
          apikey: o.key,
          Authorization: "Bearer " + o.key,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body,
        redirect: "error",
      },
    );
    status = response.status;
    // Do not log or retain server response bodies: they may contain private data.
    await response.body?.cancel();
  } catch {
    /* One exact readback determines whether the uncertain write committed. */
  }
  if (!(await find())) throw new Error("EVIDENCE_APPEND_UNCONFIRMED:" + status);
  // A committed row is not proof that the server is healthy enough for more writes.
  if (status === "NETWORK" || status === 429 || status >= 500)
    throw new Error("EVIDENCE_APPEND_SERVER_UNHEALTHY:" + status);
  return storageHash;
}
async function decodeStoredEvidence(o: Connection, stored: any, storageHash: string, hash: string) {
  if (stored?.version !== MANIFEST_VERSION) return decodeEvidence(stored, storageHash, hash);
  requireCheck(
    H.test(storageHash) &&
      captureCanonicalProof(stored).hash === storageHash &&
      same(
        Object.keys(stored).sort(),
        [
          "version",
          "hash",
          "bytes",
          "compressedHash",
          "envelopeHash",
          "encodedLength",
          "chunkSize",
          "chunks",
        ].sort(),
      ) &&
      stored.hash === hash &&
      H.test(stored.compressedHash) &&
      H.test(stored.envelopeHash) &&
      Number.isSafeInteger(stored.bytes) &&
      stored.bytes > 0 &&
      stored.bytes <= 256 * 1024 * 1024 &&
      stored.chunkSize === EVIDENCE_CHUNK_SIZE &&
      Number.isSafeInteger(stored.encodedLength) &&
      stored.encodedLength > 0 &&
      stored.encodedLength <= 64 * 1024 * 1024 &&
      Array.isArray(stored.chunks) &&
      stored.chunks.length > 0 &&
      stored.chunks.length <= MAX_CHUNKS &&
      stored.chunks.length === Math.ceil(stored.encodedLength / EVIDENCE_CHUNK_SIZE) &&
      stored.chunks.every((x: unknown) => typeof x === "string" && H.test(x)) &&
      new Set(stored.chunks).size === stored.chunks.length,
  );
  const r = reader(o),
    parts: string[] = [];
  for (let index = 0; index < stored.chunks.length; index++) {
    const chunkHash = stored.chunks[index],
      sourceId = PREFIX + "chunk:" + chunkHash.slice(7);
    const rows = await r.rows(
      "ledger_provenance_archive",
      { source_id: "eq." + sourceId, source_revision: "eq.1" },
      2,
      undefined,
      EVIDENCE_POST_LIMIT + 4096,
    );
    requireCheck(rows.length === 1);
    const row = rows[0],
      chunk = row.payload;
    requireCheck(
      row.source_id === sourceId &&
        row.source_revision === "1" &&
        row.source_hash === chunkHash &&
        captureCanonicalProof(chunk).hash === chunkHash &&
        same(Object.keys(chunk).sort(), ["version", "hash", "index", "data"].sort()) &&
        chunk.version === CHUNK_VERSION &&
        chunk.hash === hash &&
        chunk.index === index &&
        typeof chunk.data === "string" &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(chunk.data) &&
        chunk.data.length ===
          Math.min(EVIDENCE_CHUNK_SIZE, stored.encodedLength - index * EVIDENCE_CHUNK_SIZE),
    );
    parts.push(chunk.data);
  }
  const envelope = {
    version: "kr-final-retrospective-evidence-gzip-v1",
    hash,
    bytes: stored.bytes,
    compressedHash: stored.compressedHash,
    payload: parts.join(""),
  };
  requireCheck(envelope.payload.length === stored.encodedLength);
  return decodeEvidence(envelope, stored.envelopeHash, hash);
}
/** All chunks verified before publishing the small root manifest. Never update/upsert. */
export async function appendEvidence(
  o: Connection,
  kind: "plan" | "completion" | "capture" | "execution" | "diagnosis",
  payload: any,
) {
  requireCheck(["plan", "completion", "capture", "execution", "diagnosis"].includes(kind));
  if (kind === "diagnosis") validateBlockedEvidence(payload);
  if (kind === "plan")
    requireCheck(
      payload?.version !== "kr-final-retrospective-blocked-v1" && payload?.status !== "BLOCKED",
    );
  const encoded = await encodeEvidence(payload);
  const sourceId = PREFIX + kind + ":" + encoded.hash.slice(7);
  let stored: any = encoded.envelope;
  if (
    Buffer.byteLength(evidenceBody(o, sourceId, encoded.storageHash, stored), "utf8") >
    EVIDENCE_POST_LIMIT
  ) {
    const chunks: string[] = [];
    for (let offset = 0; offset < encoded.envelope.payload.length; offset += EVIDENCE_CHUNK_SIZE) {
      requireCheck(chunks.length < MAX_CHUNKS);
      const chunk = {
        version: CHUNK_VERSION,
        hash: encoded.hash,
        index: chunks.length,
        data: encoded.envelope.payload.slice(offset, offset + EVIDENCE_CHUNK_SIZE),
      };
      const chunkHash = captureCanonicalProof(chunk).hash;
      await appendEvidenceRow(o, PREFIX + "chunk:" + chunkHash.slice(7), chunk);
      chunks.push(chunkHash);
    }
    stored = {
      version: MANIFEST_VERSION,
      hash: encoded.hash,
      bytes: encoded.envelope.bytes,
      compressedHash: encoded.envelope.compressedHash,
      envelopeHash: encoded.storageHash,
      encodedLength: encoded.envelope.payload.length,
      chunkSize: EVIDENCE_CHUNK_SIZE,
      chunks,
    };
  }
  const storageHash = await appendEvidenceRow(o, sourceId, stored);
  return { hash: encoded.hash, storageHash };
}
export async function capture(
  o: Connection,
  request: Request,
  requestHash: string,
  codeCommit: string,
  emitCodec?: (event: CaptureCodecDiagnostic) => void,
): Promise<FinalCapture> {
  await validateRequest(request, requestHash, o.owner, codeCommit);
  const captureStartedAt = new Date().toISOString();
  const r = reader(o),
    base = await snapshot(o);
  const priorRecovery = request.priorRecovery
    ? await capturePriorRecovery(o, request.priorRecovery)
    : undefined;
  requireCheck(same(await legacyInventory(o), request.legacy.map((x) => x.path).sort()));
  for (const key of ["sources", "models", "registries", "actual"] as const)
    requireCheck(
      (await hashSeriesValue(
        key === "models"
          ? base.models.map(({ series_id, session_date, state_hash, recorded_at }) => ({
              series_id,
              session_date,
              state_hash,
              recorded_at,
            }))
          : base[key],
      )) === request.expected[key],
    );
  const texts: string[] = [],
    sourceObjects: any[] = [];
  for (const row of base.sources) {
    requireCheck(row.storage_bucket === "cloudtrend-data" && H.test(row.file_hash));
    const obj = await r.object(row.storage_path, row.file_hash);
    const gz =
      row.canonical_format?.toLowerCase() === "csv.gz" ||
      row.storage_path.endsWith(".gz") ||
      /gzip/i.test(row.content_type ?? "");
    const bytes = gz ? gunzipSync(obj.bytes, { maxOutputLength: 80 * 1024 * 1024 }) : obj.bytes;
    const validation = await validateSourceBytes({
      bytes,
      filename: row.original_filename.replace(/\.gz$/i, ""),
      contentType: gz ? "text/csv" : row.content_type,
      streamingCsv: true,
    });
    requireCheck(
      validation.valid &&
        validation.dataHash === row.data_hash &&
        validation.schemaHash === row.schema_hash &&
        validation.stats.rowCount === row.row_count &&
        validation.stats.minDate === row.min_date &&
        validation.stats.maxDate === row.max_date,
    );
    texts.push(validation.canonicalCsv);
    sourceObjects.push({
      id: row.id,
      path: row.storage_path,
      generation: obj.generation,
      storedHash: obj.hash,
      logicalHash: rawHash(bytes),
      canonicalHash: rawHash(validation.canonicalCsv),
    });
  }
  const publication = classifyKrScreeningPublication(base.sources);
  requireCheck(
    publication.phase === "FINAL" && publication.asOfDate === request.targetDates.at(-1),
  );
  for (let i = 0; i < base.sources.length; i++) {
    const p = krSourcePublication(base.sources[i]);
    if (p) requireCheck(rawHash(p.manifestText) === p.manifestSha256);
    if (
      !p ||
      p.phase !== "PRELIMINARY" ||
      unresolvedKrPendingSources(base.sources).includes(base.sources[i])
    )
      requireCheck(!/PENDING_PUBLICATION|KRX_PENDING|KRX_PUBLICATION_PENDING/i.test(texts[i]));
  }
  const dataset = parseManualMarketDataWithReferences(texts).dataset;
  requireCheck(dataset.asOfDate === publication.asOfDate);
  const predecessors = [];
  for (const kind of kinds) {
    const series = base.registries.filter(
      (x) => x.series_id === "adopted-shadow-2026-10-12-v1:" + kind,
    );
    requireCheck(series.length === 1);
    const rows = base.models.filter((x) => x.series_id === series[0].series_id);
    const row = rows.at(-1);
    requireCheck(row && row.session_date === request.predecessorDate);
    predecessors.push({
      series: series[0].payload,
      run: row.payload,
      payloadHash: await hashSeriesValue(row.payload),
    });
  }
  const archiveRows = await r.rows(
    "ledger_provenance_archive",
    { source_id: "like.october-input:KR:*", source_revision: "eq.1" },
    513,
    "source_id.asc",
  );
  const preparedRows = await r.rows(
    "ledger_provenance_archive",
    { source_id: "like.october-prepared:*", source_revision: "eq.1" },
    513,
    "source_id.asc",
  );
  const archives = [];
  for (const row of archiveRows) {
    requireCheck((await hashSeriesValue(row.payload)) === row.source_hash);
    archives.push({ hash: row.source_hash, payload: row.payload });
  }
  const vintageRows = await r.rows(
    "shadow_replay_audit",
    { market: "eq.KR", strategy_version: "in.(reviewed-kr-vintage-v1,reviewed-kr-vintage-v2)" },
    129,
    "id.asc",
  );
  const readVintage = (key: string, id: string) => {
    const values = vintageRows
      .filter((x) => x.strategy_version === id && x.details?.[key]?.reviewId === id)
      .map((x) => x.details[key]);
    requireCheck(values.length > 0 && values.every((x) => same(x, values[0])));
    return values[0];
  };
  const vintage = {
    registry: readVintage("krSourceVintageApproval", "reviewed-kr-vintage-v2"),
    receipt: readVintage("krSourceVintageReview", "reviewed-kr-vintage-v2"),
    predecessor: {
      registry: readVintage("krSourceVintageApproval", "reviewed-kr-vintage-v1"),
      receipt: readVintage("krSourceVintageReview", "reviewed-kr-vintage-v1"),
    },
  };
  await verifyKrSourceVintagePrivateApproval(vintage);
  const legacyObjects: FinalCapture["legacyObjects"] = {};
  const legacyPins: any[] = [];
  for (const pin of request.legacy) {
    const obj = await r.object(pin.path, pin.hash, pin.generation);
    const payload = JSON.parse(obj.bytes.toString());
    legacyPins.push({ ...pin, hash: obj.hash });
    legacyObjects[pin.path] = { hash: await hashSeriesValue(payload), payload };
  }
  requireCheck(same(await snapshot(o), base));
  requireCheck(same(await legacyInventory(o), request.legacy.map((x) => x.path).sort()));
  for (const pin of sourceObjects)
    requireCheck(same(normalizeGeneration(await r.info(pin.path)), pin.generation));
  for (const pin of request.legacy)
    requireCheck(same(normalizeGeneration(await r.info(pin.path)), pin.generation));
  if (priorRecovery) await assertPriorRecoveryFresh(o, priorRecovery);
  const capturedAt = new Date().toISOString(),
    computedAt = new Date().toISOString();
  const original: FinalCaptureV1 = {
    version: "kr-final-retrospective-capture-v1",
    owner: o.owner,
    codeCommit,
    runtimeHashes: {
      october: octoberRuntime.codeHash as SeriesHash,
      kospi: kospiRuntime.codeHash as SeriesHash,
    },
    capturedAt,
    computedAt,
    sourceManifest: base.sources,
    captureManifest: {
      requestHash,
      captureStartedAt,
      sourceObjects,
      legacy: legacyPins,
      ...(priorRecovery ? { priorRecovery } : {}),
    },
    preservationBaseline: { ...base, archiveRows, preparedRows, vintageRows },
    finalPublication: {
      hash: await hashSeriesValue(publication),
      activatedAt: base.sources
        .filter((x) => {
          const p = krSourcePublication(x);
          return p?.phase === "FINAL" && p.asOfDate === publication.asOfDate;
        })
        .map((x) => x.activated_at ?? x.created_at)
        .sort()
        .at(-1),
      asOfDate: publication.asOfDate,
    },
    dataset,
    config: request.config,
    sourceVintageApproval: vintage,
    predecessors,
    archives,
    legacyObjects,
  };
  return encodeFinalCapture(original, emitCodec);
}
/** Original entire rows are immutable; only exact plan additions and projection values are allowed. */
export async function assertCaptureFresh(
  o: Connection,
  c: FinalCapture,
  additions: any[] = [],
  legacyExpected: Record<string, unknown[]> = {},
  artifacts: any[] = [],
) {
  const b = c.preservationBaseline as any,
    now = await snapshot(o),
    r = reader(o);
  if ((c.captureManifest as any).priorRecovery)
    await assertPriorRecoveryFresh(o, (c.captureManifest as any).priorRecovery);
  for (const key of ["sources", "registries", "actual"] as const)
    requireCheck(same(now[key], b[key]));
  const baselineKeys = new Set(b.models.map((x: any) => x.series_id + ":" + x.session_date));
  for (const row of b.models)
    requireCheck(
      same(
        now.models.find(
          (x) => x.series_id === row.series_id && x.session_date === row.session_date,
        ),
        row,
      ),
    );
  for (const row of now.models.filter(
    (x) => !baselineKeys.has(x.series_id + ":" + x.session_date),
  )) {
    const expected = additions.find(
      (x) => x.bookId === row.series_id && x.receipt.date === row.session_date,
    );
    requireCheck(expected && same(expected, row.payload) && row.state_hash === expected.stateHash);
  }
  for (const [pattern, old] of [
    ["october-input:KR:*", b.archiveRows],
    ["october-prepared:*", b.preparedRows],
  ] as const) {
    const a = await r.rows(
      "ledger_provenance_archive",
      { source_id: "like." + pattern, source_revision: "eq.1" },
      513,
      "source_id.asc",
    );
    for (const row of old)
      requireCheck(
        same(
          a.find((x) => x.source_id === row.source_id),
          row,
        ),
      );
    for (const row of a.filter((x) => !old.some((y: any) => y.source_id === x.source_id))) {
      const expected = artifacts.find((x) => x.source_id === row.source_id);
      requireCheck(
        expected && same(expected.payload, row.payload) && expected.source_hash === row.source_hash,
      );
    }
  }
  requireCheck(
    same(
      await r.rows(
        "shadow_replay_audit",
        { market: "eq.KR", strategy_version: "in.(reviewed-kr-vintage-v1,reviewed-kr-vintage-v2)" },
        129,
        "id.asc",
      ),
      b.vintageRows,
    ),
  );
  for (const pin of (c.captureManifest as any).sourceObjects)
    requireCheck(same(normalizeGeneration(await r.info(pin.path)), pin.generation));
  const pins = (c.captureManifest as any).legacy;
  const paths = await legacyInventory(o),
    oldPaths = pins.map((x: any) => x.path);
  requireCheck(
    oldPaths.every((p: string) => paths.includes(p)) &&
      paths.every((p) => oldPaths.includes(p) || Object.hasOwn(legacyExpected, p)),
  );
  for (const p of paths.filter((p) => !oldPaths.includes(p))) {
    const obj = await r.object(p);
    requireCheck(legacyExpected[p].some((x) => same(JSON.parse(obj.bytes.toString()), x)));
  }
  for (const pin of pins) {
    if (Object.hasOwn(legacyExpected, pin.path)) {
      const obj = await r.object(pin.path);
      requireCheck(legacyExpected[pin.path].some((x) => same(JSON.parse(obj.bytes.toString()), x)));
    } else requireCheck(same(normalizeGeneration(await r.info(pin.path)), pin.generation));
  }
}

/** Numeric-only diagnostic boundary: never emits payload paths, values, or exception messages. */
export type CaptureSerializationDiagnostic = {
  status:
    | "CAPTURE_JSON_START"
    | "CAPTURE_JSON_CANONICAL_REJECTED"
    | "CAPTURE_JSON_BYTES"
    | "CAPTURE_JSON_LIMIT_REJECTED"
    | "CAPTURE_COMPONENT_CANONICAL_REJECTED"
    | "CAPTURE_COMPONENT_DATASET_BYTES"
    | "CAPTURE_COMPONENT_BASELINE_BYTES"
    | "CAPTURE_COMPONENT_ARCHIVES_BYTES"
    | "CAPTURE_COMPONENT_PREDECESSORS_BYTES"
    | "CAPTURE_COMPONENT_LEGACY_BYTES";
  bytes?: number;
  componentIndex?: number;
  errorCategory?: "RANGE_ERROR" | "CANONICAL_VALUE_ERROR";
};
export const CAPTURE_JSON_MAX_BYTES = 256 * 1024 * 1024;
export function assertCaptureByteLength(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > CAPTURE_JSON_MAX_BYTES)
    throw new Error("CAPTURE_JSON_LIMIT_REJECTED");
}
function diagnoseCaptureComponents(
  payload: unknown,
  emitSafe: (event: CaptureSerializationDiagnostic) => void,
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const record = payload as Record<string, unknown>;
  const components = [
    ["dataset", "CAPTURE_COMPONENT_DATASET_BYTES"],
    ["preservationBaseline", "CAPTURE_COMPONENT_BASELINE_BYTES"],
    ["archives", "CAPTURE_COMPONENT_ARCHIVES_BYTES"],
    ["predecessors", "CAPTURE_COMPONENT_PREDECESSORS_BYTES"],
    ["legacyObjects", "CAPTURE_COMPONENT_LEGACY_BYTES"],
  ] as const;
  for (const [componentIndex, [key, status]] of components.entries()) {
    if (!Object.hasOwn(record, key)) continue;
    try {
      emitSafe({ status, bytes: Buffer.byteLength(canonicalSeriesJson(record[key])) });
    } catch (error) {
      emitSafe({
        status: "CAPTURE_COMPONENT_CANONICAL_REJECTED",
        componentIndex,
        errorCategory: error instanceof RangeError ? "RANGE_ERROR" : "CANONICAL_VALUE_ERROR",
      });
    }
  }
}
export function serializeCaptureWithDiagnostics(
  payload: unknown,
  emitSafe: (event: CaptureSerializationDiagnostic) => void,
): string {
  emitSafe({ status: "CAPTURE_JSON_START" });
  let result: string;
  try {
    result = canonicalSeriesJson(payload);
  } catch (error) {
    emitSafe({
      status: "CAPTURE_JSON_CANONICAL_REJECTED",
      errorCategory: error instanceof RangeError ? "RANGE_ERROR" : "CANONICAL_VALUE_ERROR",
    });
    diagnoseCaptureComponents(payload, emitSafe);
    throw new Error("CAPTURE_JSON_CANONICAL_REJECTED");
  }
  const bytes = Buffer.byteLength(result);
  emitSafe({ status: "CAPTURE_JSON_BYTES", bytes });
  try {
    assertCaptureByteLength(bytes);
  } catch {
    emitSafe({ status: "CAPTURE_JSON_LIMIT_REJECTED", bytes });
    diagnoseCaptureComponents(payload, emitSafe);
    throw new Error("CAPTURE_JSON_LIMIT_REJECTED");
  }
  return result;
}

const priorRoles = ["preparation", "fullPlan", "approval", "terminal"] as const;
const exactKeys = (value: any, keys: string[]) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  same(Object.keys(value).sort(), [...keys].sort());
/** Exact role-specific archive identities; old authority is lineage only. */
export function validatePriorRecoveryPins(value: any): asserts value is FinalPriorRecoveryPins {
  requireCheck(
    exactKeys(value, ["version", ...priorRoles]) &&
      value.version === "kr-final-prior-recovery-lineage-v1",
  );
  for (const role of priorRoles) {
    const pin = value[role];
    requireCheck(
      exactKeys(pin, ["sourceId", "sourceRevision", "storageHash", "logicalHash"]) &&
        pin.sourceRevision === "1" &&
        H.test(pin.storageHash) &&
        H.test(pin.logicalHash),
    );
  }
  const hex = "[a-f0-9]{64}";
  requireCheck(
    new RegExp(
      "^kr-adjusted-recovery-preparation:" +
        hex +
        ":" +
        value.preparation.logicalHash.slice(7) +
        "$",
    ).test(value.preparation.sourceId),
  );
  requireCheck(
    new RegExp("^kr-adjusted-recovery-full-plan:" + hex + "$").test(value.fullPlan.sourceId),
  );
  requireCheck(
    value.approval.sourceId ===
      "kr-adjusted-recovery-apply-approval:" + value.fullPlan.logicalHash.slice(7),
  );
  requireCheck(
    value.terminal.sourceId ===
      "kr-adjusted-recovery-model-stage:" + value.terminal.logicalHash.slice(7),
  );
  requireCheck(
    value.approval.logicalHash === value.approval.storageHash &&
      value.terminal.logicalHash === value.terminal.storageHash,
  );
  requireCheck(new Set(priorRoles.map((role) => value[role].sourceId)).size === 4);
}
function pinsFromLineage(value: FinalPriorRecoveryLineage): FinalPriorRecoveryPins {
  requireCheck(exactKeys(value, ["version", ...priorRoles]));
  const pins: any = { version: value.version };
  for (const role of priorRoles) {
    const evidence = value[role];
    requireCheck(
      exactKeys(evidence, [
        "sourceId",
        "sourceRevision",
        "storageHash",
        "logicalHash",
        "userId",
        "rowHash",
        "payload",
      ]) && H.test(evidence.rowHash),
    );
    const { sourceId, sourceRevision, storageHash, logicalHash } = evidence;
    pins[role] = { sourceId, sourceRevision, storageHash, logicalHash };
  }
  validatePriorRecoveryPins(pins);
  return pins;
}
/** Full original envelopes retained, never a projection substituted for old evidence. */
export async function capturePriorRecovery(
  o: Connection,
  pins: FinalPriorRecoveryPins,
): Promise<FinalPriorRecoveryLineage> {
  validatePriorRecoveryPins(pins);
  const result: any = { version: pins.version };
  for (const role of priorRoles) {
    const pin = pins[role];
    const rows = await reader(o).rows(
      "ledger_provenance_archive",
      { source_id: "eq." + pin.sourceId, source_revision: "eq.1" },
      2,
    );
    requireCheck(rows.length === 1);
    const row = rows[0];
    requireCheck(
      row.user_id === o.owner &&
        row.source_id === pin.sourceId &&
        row.source_revision === "1" &&
        row.source_hash === pin.storageHash &&
        captureCanonicalProof(row.payload).hash === pin.storageHash,
    );
    if (role === "preparation" || role === "fullPlan")
      await decodeRecoveryEvidence(
        row.payload,
        pin.storageHash,
        pin.logicalHash,
        role === "preparation" ? "PREPARATION" : "FULL_PLAN",
      );
    else requireCheck(captureCanonicalProof(row.payload).hash === pin.logicalHash);
    result[role] = {
      ...pin,
      userId: o.owner,
      rowHash: captureCanonicalProof(row).hash,
      payload: row.payload,
    };
  }
  return result;
}
/** Every field of every original row remains pinned, including its server timestamps. */
export async function assertPriorRecoveryFresh(o: Connection, value: FinalPriorRecoveryLineage) {
  const pins = pinsFromLineage(value);
  for (const role of priorRoles)
    requireCheck(
      value[role].userId === o.owner &&
        captureCanonicalProof(value[role].payload).hash === value[role].storageHash,
    );
  const current = await capturePriorRecovery(o, pins);
  for (const role of priorRoles) requireCheck(current[role].rowHash === value[role].rowHash);
}

function validateBlockedEvidence(value: any) {
  requireCheck(
    value?.version === "kr-final-retrospective-blocked-v1" &&
      value.status === "BLOCKED" &&
      value.plan === null &&
      value.operationalApproval === false &&
      value.historicalAvailabilityClaim === false,
  );
}
