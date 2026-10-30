/* eslint-disable @typescript-eslint/no-explicit-any */
/** Owner-private, bounded transport. No collector, source registration or historical backdating. */
import { gzipSync, gunzipSync } from "node:zlib";
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
import type { FinalCapture } from "./contracts";
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
  version: "kr-final-retrospective-request-v1";
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
  ) => {
    requireCheck(
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
    const value = JSON.parse((await get("/rest/v1/" + table + "?" + q)).toString());
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
      value.version === "kr-final-retrospective-request-v1" &&
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
  kind: "request" | "plan" | "approval" | "completion" | "capture" | "execution",
  hash: string,
) {
  requireCheck(H.test(hash));
  const rows = await reader(o).rows(
    "ledger_provenance_archive",
    { source_id: "eq." + PREFIX + kind + ":" + hash.slice(7), source_revision: "eq.1" },
    2,
  );
  requireCheck(rows.length === 1);
  return decodeEvidence(rows[0].payload, rows[0].source_hash, hash);
}
export async function encodeEvidence(payload: any) {
  const bytes = Buffer.from(canonicalSeriesJson(payload));
  requireCheck(bytes.length > 0 && bytes.length <= 256 * 1024 * 1024);
  const compressed = gzipSync(bytes, { level: 9 });
  requireCheck(compressed.toString("base64").length <= 64 * 1024 * 1024);
  const envelope = {
    version: "kr-final-retrospective-evidence-gzip-v1",
    hash: rawHash(bytes),
    bytes: bytes.length,
    compressedHash: rawHash(compressed),
    payload: compressed.toString("base64"),
  };
  return {
    envelope,
    storageHash: await hashSeriesValue(envelope),
    hash: rawHash(bytes) as SeriesHash,
  };
}
export async function decodeEvidence(stored: any, storageHash: string, expectedHash: string) {
  requireCheck(
    H.test(storageHash) && H.test(expectedHash) && (await hashSeriesValue(stored)) === storageHash,
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
  requireCheck(canonicalSeriesJson(payload) === bytes.toString());
  return payload;
}
/** One INSERT, exact readback after uncertain response; no retry, update or upsert. */
export async function appendEvidence(
  o: Connection,
  kind: "plan" | "completion" | "capture" | "execution",
  payload: any,
) {
  requireCheck(["plan", "completion", "capture", "execution"].includes(kind));
  const encoded = await encodeEvidence(payload),
    r = reader(o),
    sourceId = PREFIX + kind + ":" + encoded.hash.slice(7);
  const find = async () => {
    const rows = await r.rows(
      "ledger_provenance_archive",
      { source_id: "eq." + sourceId, source_revision: "eq.1" },
      2,
    );
    if (rows[0])
      requireCheck(
        same(await decodeEvidence(rows[0].payload, rows[0].source_hash, encoded.hash), payload),
      );
    return rows.length === 1;
  };
  if (!(await find())) {
    try {
      await (o.fetcher ?? fetch)(new URL("/rest/v1/ledger_provenance_archive", o.origin), {
        method: "POST",
        headers: {
          apikey: o.key,
          Authorization: "Bearer " + o.key,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          user_id: o.owner,
          source_id: sourceId,
          source_revision: "1",
          source_hash: encoded.storageHash,
          payload: encoded.envelope,
        }),
        redirect: "error",
      });
    } catch {
      /* readback, never retry */
    }
    requireCheck(await find());
  }
  return { hash: encoded.hash, storageHash: encoded.storageHash };
}
export async function capture(
  o: Connection,
  request: Request,
  requestHash: string,
  codeCommit: string,
): Promise<FinalCapture> {
  await validateRequest(request, requestHash, o.owner, codeCommit);
  const r = reader(o),
    base = await snapshot(o);
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
  const captureStartedAt = new Date().toISOString();
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
  const capturedAt = new Date().toISOString(),
    computedAt = new Date().toISOString();
  return {
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
    captureManifest: { requestHash, captureStartedAt, sourceObjects, legacy: legacyPins },
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
