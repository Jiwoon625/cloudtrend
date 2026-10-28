/** Read-only transport for a separately approved private evidence capsule. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalSeriesJson, hashSeriesValue } from "../../src/lib/ledger/modelSeries";

export const CAPSULE_PREFIX = "kr-vintage-preflight-evidence:";
export const CAPSULE_VERSION = "kr-vintage-preflight-evidence-v1";
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export const rawHash = (bytes: Uint8Array | string) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
export function requireCheck(value: unknown): asserts value {
  if (!value) throw new Error("PREFLIGHT_INPUT_REJECTED");
}
const object = (v: any) => v && typeof v === "object" && !Array.isArray(v);
const keys = (v: any, allowed: string[]) =>
  object(v) && Object.keys(v).every((k) => allowed.includes(k));
function date(value: unknown) {
  return (
    typeof value === "string" &&
    datePattern.test(value) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
  );
}
function safeObjectPath(value: string, owner: string) {
  requireCheck(
    typeof value === "string" &&
      value.startsWith(owner + "/") &&
      !value.includes("\\") &&
      !value.includes("%") &&
      !/[?#]/.test(value) &&
      ![...value].some((c) => c.charCodeAt(0) <= 32) &&
      value.split("/").every((p) => p && p !== "." && p !== ".."),
  );
  return value.split("/").map(encodeURIComponent).join("/");
}
export function restPath(
  table: string,
  owner: string,
  select: string,
  filters: Record<string, string>,
) {
  requireCheck(uuidPattern.test(owner));
  const allowed: Record<string, string[]> = {
    ledger_provenance_archive: ["source_id", "source_revision"],
    analysis_runs: ["id"],
    analysis_source_files: ["id"],
    ledger_model_sessions: ["series_id", "session_date"],
    shadow_replay_audit: ["id"],
  };
  requireCheck(allowed[table] && Object.keys(filters).every((k) => allowed[table].includes(k)));
  const query = new URLSearchParams({ select, user_id: "eq." + owner, ...filters, limit: "2" });
  return "/rest/v1/" + table + "?" + query.toString();
}
export function objectPath(bucket: string, object: string, owner: string) {
  requireCheck(bucket === "cloudtrend-data");
  return "/storage/v1/object/authenticated/" + bucket + "/" + safeObjectPath(object, owner);
}
/** No generic client, RPC, caller-supplied URL or write method crosses this boundary. */
export function createReadOnlyTransport(
  origin: string,
  key: string,
  allowedPaths: Set<string>,
  fetcher: typeof fetch = fetch,
  observeResponse?: (path: string, response: Response) => void,
) {
  const base = new URL(origin);
  requireCheck(
    base.protocol === "https:" &&
      /^[a-z0-9]+\.supabase\.co$/.test(base.hostname) &&
      base.pathname === "/" &&
      !base.search &&
      !base.hash &&
      !base.username &&
      !base.password &&
      !base.port &&
      key.length > 0,
  );
  let total = 0;
  return async (relative: string, limit = 80 * 1024 * 1024, method: "GET" | "HEAD" = "GET") => {
    requireCheck(allowedPaths.has(relative) && ["GET", "HEAD"].includes(method));
    const url = new URL(relative, base);
    requireCheck(
      url.origin === base.origin &&
        (url.pathname.startsWith("/rest/v1/") ||
          url.pathname.startsWith("/storage/v1/object/authenticated/cloudtrend-data/") ||
          url.pathname.startsWith("/storage/v1/object/info/cloudtrend-data/")),
    );
    const response = await fetcher(url, {
      method,
      headers: { apikey: key, Authorization: "Bearer " + key, "Cache-Control": "no-cache" },
      redirect: "error",
      cache: "no-store",
    });
    requireCheck(
      response.ok &&
        !response.redirected &&
        (!response.url || new URL(response.url).origin === base.origin),
    );
    observeResponse?.(relative, response);
    const length = Number(response.headers.get("content-length") ?? 0);
    requireCheck(length <= limit);
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body)
      for await (const chunk of response.body as any) {
        size += chunk.length;
        total += chunk.length;
        requireCheck(size <= limit && total <= 1024 * 1024 * 1024);
        chunks.push(chunk);
      }
    return Buffer.concat(chunks);
  };
}
export async function validateCapsule(row: any, owner: string, revision: string) {
  requireCheck(
    keys(row, ["user_id", "source_id", "source_revision", "source_hash", "payload"]) &&
      row.user_id === owner &&
      row.source_revision === revision &&
      hashPattern.test(row.source_hash),
  );
  const value = row.payload;
  requireCheck(
    keys(value, [
      "version",
      "kind",
      "counterfactual",
      "operationalApproval",
      "capture",
      "files",
      "frozenBaseline",
      "readPlan",
    ]) &&
      value.version === CAPSULE_VERSION &&
      value.kind === "RECOVERY_EVIDENCE_ONLY" &&
      value.counterfactual === true &&
      value.operationalApproval === false,
  );
  requireCheck(
    keys(value.capture, [
      "manifestSha256",
      "driveFolderId",
      "symbol",
      "asOfDate",
      "normalizedArtifactName",
    ]) && /^[a-f0-9]{64}$/.test(value.capture.manifestSha256),
  );
  requireCheck(
    row.source_id === CAPSULE_PREFIX + value.capture.manifestSha256 &&
      (await hashSeriesValue(value)) === row.source_hash,
  );
  const p = value.readPlan,
    base = value.frozenBaseline;
  requireCheck(
    keys(p, ["version", "scope", "result", "krHistoryDates", "previousDate", "books"]) &&
      p.version === "kr-vintage-preflight-read-plan-v1" &&
      keys(base, ["run", "orderedSources"]),
  );
  const s = p.scope;
  requireCheck(
    keys(s, [
      "symbol",
      "targetDate",
      "baselineAsOfDate",
      "captureThroughDate",
      "captureManifestHash",
      "normalizedArtifactName",
      "expectedRun",
    ]) && /^\d{6}$/.test(s.symbol),
  );
  requireCheck(
    date(s.targetDate) &&
      date(s.baselineAsOfDate) &&
      date(s.captureThroughDate) &&
      date(p.previousDate) &&
      p.previousDate < s.targetDate &&
      s.targetDate <= s.baselineAsOfDate &&
      s.baselineAsOfDate === s.captureThroughDate,
  );
  requireCheck(
    value.capture.symbol === s.symbol &&
      value.capture.asOfDate === s.captureThroughDate &&
      value.capture.normalizedArtifactName === s.normalizedArtifactName &&
      s.captureManifestHash === "sha256:" + value.capture.manifestSha256 &&
      s.normalizedArtifactName === `adjusted_${s.symbol}_360.json`,
  );
  const expected = s.expectedRun;
  requireCheck(
    keys(expected, ["id", "codeVersion", "dataVersion", "sourceCount"]) &&
      /^[\w-]+$/.test(expected.id) &&
      /^[a-f0-9]{40}$/.test(expected.codeVersion) &&
      hashPattern.test(expected.dataVersion) &&
      expected.sourceCount === 38,
  );
  requireCheck(
    Array.isArray(base.orderedSources) &&
      base.orderedSources.length === expected.sourceCount &&
      new Set(base.orderedSources.map((r: any) => r.id)).size === expected.sourceCount,
  );
  requireCheck(
    base.run.id === expected.id &&
      base.run.data_version === expected.dataVersion &&
      base.run.code_version === expected.codeVersion &&
      base.run.as_of_date === s.baselineAsOfDate &&
      base.run.completed_at &&
      object(base.run.config),
  );
  requireCheck(
    keys(p.result, ["bucket", "path"]) &&
      p.result.bucket === "cloudtrend-data" &&
      p.result.path === base.run.result_path,
  );
  safeObjectPath(p.result.path, owner);
  for (const r of base.orderedSources) {
    requireCheck(
      uuidPattern.test(r.id) &&
        hashPattern.test(r.file_hash) &&
        hashPattern.test(r.data_hash) &&
        hashPattern.test(r.schema_hash),
    );
    objectPath(r.storage_bucket, r.storage_path, owner);
  }
  requireCheck(
    rawHash(
      base.orderedSources
        .map((r: any) => r.data_hash)
        .sort()
        .join("\n"),
    ) === expected.dataVersion,
  );
  requireCheck(
    Array.isArray(p.krHistoryDates) &&
      p.krHistoryDates.length > 0 &&
      p.krHistoryDates.length <= 30 &&
      same([...new Set(p.krHistoryDates)].sort(), p.krHistoryDates) &&
      p.krHistoryDates.every((d: any) => date(d) && d <= p.previousDate) &&
      p.krHistoryDates.at(-1) === p.previousDate,
  );
  requireCheck(
    Array.isArray(p.books) && same(p.books.map((b: any) => b.kind).sort(), ["O1", "S07"]),
  );
  for (const b of p.books)
    requireCheck(
      keys(b, [
        "kind",
        "seriesId",
        "previousDate",
        "previousStateHash",
        "completedDate",
        "completedStateHash",
      ]) &&
        b.seriesId === `integrated-allocation-shadow-2026-10-12-v1:${b.kind}` &&
        b.previousDate === p.previousDate &&
        b.completedDate === s.targetDate &&
        hashPattern.test(b.previousStateHash) &&
        hashPattern.test(b.completedStateHash),
    );
  const names = [
    "manifest.json",
    "manifest.sha256",
    s.normalizedArtifactName,
    `adjusted_${s.symbol}_360.csv`,
    "provider-page-001.json",
    "provider-page-002.json",
  ];
  requireCheck(object(value.files) && same(Object.keys(value.files).sort(), names.sort()));
  for (const f of Object.values(value.files) as any[]) {
    requireCheck(
      keys(f, ["encoding", "content", "bytes", "sha256"]) &&
        f.encoding === "base64" &&
        typeof f.content === "string" &&
        Number.isInteger(f.bytes) &&
        f.bytes > 0 &&
        f.bytes < 1024 * 1024 &&
        /^[a-f0-9]{64}$/.test(f.sha256),
    );
    const bytes = Buffer.from(f.content, "base64");
    requireCheck(
      bytes.toString("base64") === f.content &&
        bytes.length === f.bytes &&
        rawHash(bytes) === "sha256:" + f.sha256,
    );
  }
  requireCheck(value.files["manifest.json"].sha256 === value.capture.manifestSha256);
  const manifest = JSON.parse(
    Buffer.from(value.files["manifest.json"].content, "base64").toString(),
  );
  requireCheck(
    manifest.symbol === s.symbol &&
      manifest.lastDate === s.captureThroughDate &&
      manifest.adjusted === true &&
      manifest.rows === 360 &&
      manifest.status === "CAPTURED_REVIEW_REQUIRED",
  );
  requireCheck(
    Buffer.from(value.files["manifest.sha256"].content, "base64")
      .toString()
      .trim()
      .split(/\s+/)[0] === value.capture.manifestSha256,
  );
  for (const name of names.filter((n) => !n.startsWith("manifest.")))
    requireCheck(
      manifest.artifacts[name]?.sha256 === value.files[name].sha256 &&
        manifest.artifacts[name]?.bytes === value.files[name].bytes,
    );
  return value;
}
export function verifyResultBundle(bundle: any, capsule: any) {
  const { run, orderedSources } = capsule.frozenBaseline,
    s = capsule.readPlan.scope;
  requireCheck(
    bundle.schemaVersion === 1 &&
      bundle.run.kind === "SCREENING" &&
      bundle.run.id === run.id.replace(/^screening-/, "") &&
      bundle.run.codeVersion === run.code_version &&
      bundle.run.dataVersion === run.data_version &&
      bundle.data.asOfDate === run.as_of_date &&
      same(bundle.config, run.config),
  );
  requireCheck(
    Array.isArray(bundle.data.sources) && bundle.data.sources.length === s.expectedRun.sourceCount,
  );
  for (let i = 0; i < orderedSources.length; i++) {
    const r = orderedSources[i],
      b = bundle.data.sources[i];
    requireCheck(
      b.id === r.id &&
        b.objectPath === r.storage_path &&
        b.fileHash === r.file_hash &&
        b.dataHash === r.data_hash &&
        b.schemaHash === r.schema_hash &&
        b.fileName === r.original_filename,
    );
  }
}
function selectedSame(expected: any, actual: any, fields: string[]) {
  requireCheck(fields.every((k) => same(expected[k], actual[k])));
}
export async function materializeCapsule(options: {
  origin: string;
  key: string;
  owner: string;
  revision: string;
  expectedCapsuleHash: string;
  directory: string;
  fetcher?: typeof fetch;
}) {
  const { owner, revision, directory } = options;
  requireCheck(hashPattern.test(options.expectedCapsuleHash));
  requireCheck(
    uuidPattern.test(owner) &&
      /^[1-9]\d{0,2}$/.test(revision) &&
      path.isAbsolute(directory) &&
      !fs.existsSync(directory),
  );
  const allowed = new Set<string>();
  const reader = createReadOnlyTransport(options.origin, options.key, allowed, options.fetcher);
  const get = async (p: string, limit?: number) => {
    allowed.add(p);
    return reader(p, limit);
  };
  const rows = async (table: string, select: string, filters: Record<string, string>) => {
    const v = JSON.parse(
      (await get(restPath(table, owner, select, filters), 4 * 1024 * 1024)).toString(),
    );
    requireCheck(Array.isArray(v) && v.length === 1);
    return v[0];
  };
  const selector = restPath(
    "ledger_provenance_archive",
    owner,
    "user_id,source_id,source_revision,source_hash,payload",
    { source_id: "like." + CAPSULE_PREFIX + "*", source_revision: "eq." + revision },
  );
  const candidates = JSON.parse((await get(selector, 4 * 1024 * 1024)).toString());
  requireCheck(Array.isArray(candidates) && candidates.length === 1);
  requireCheck(candidates[0].source_hash === options.expectedCapsuleHash);
  const capsule = await validateCapsule(candidates[0], owner, revision),
    p = capsule.readPlan,
    frozen = capsule.frozenBaseline;
  const liveRun = await rows(
    "analysis_runs",
    "id,kind,status,code_version,data_version,config,result_path,as_of_date,completed_at",
    { id: "eq." + frozen.run.id },
  );
  requireCheck(liveRun.kind === "SCREENING" && liveRun.status === "COMPLETED");
  selectedSame(frozen.run, liveRun, [
    "id",
    "code_version",
    "data_version",
    "config",
    "result_path",
    "as_of_date",
  ]);
  requireCheck(
    Date.parse(liveRun.completed_at) === Date.parse(frozen.run.completed_at) &&
      Number.isFinite(Date.parse(liveRun.completed_at)),
  );
  const bundleBytes = await get(objectPath(p.result.bucket, p.result.path, owner));
  verifyResultBundle(JSON.parse(bundleBytes.toString()), capsule);
  fs.mkdirSync(directory, { mode: 0o700 });
  let index = 0;
  const save = (bytes: Uint8Array | string) => {
    const filename = path.join(directory, `${index++}.json`);
    fs.writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
    return { path: filename, sha256: rawHash(bytes) };
  };
  const json = (value: any) => save(canonicalSeriesJson(value));
  const input: any = {
    version: "kr-adjusted-replay-preflight-v1",
    scope: p.scope,
    fieldPolicy: "TAGGED_COLLECTOR_PROXY_V1_RETAIN_INDEPENDENT",
    date: p.scope.targetDate,
    calculatedAt: new Date().toISOString(),
    frozenRun: json(liveRun),
    frozenSourceRoster: json(frozen.orderedSources),
    sources: [],
  };
  for (const r of frozen.orderedSources) {
    const fields = [
      "id",
      "original_filename",
      "storage_bucket",
      "storage_path",
      "file_hash",
      "data_hash",
      "schema_hash",
      "canonical_format",
      "content_type",
    ];
    const current = await rows("analysis_source_files", fields.join(","), { id: "eq." + r.id });
    selectedSame(r, current, fields);
    const bytes = await get(objectPath(r.storage_bucket, r.storage_path, owner));
    requireCheck(rawHash(bytes) === r.file_hash);
    input.sources.push({ ...save(bytes), id: r.id });
  }
  const refs: Record<string, any> = {};
  for (const [name, file] of Object.entries(capsule.files) as [string, any][])
    refs[name] = save(Buffer.from(file.content, "base64"));
  input.captureManifest = refs["manifest.json"];
  input.captureRows = refs[p.scope.normalizedArtifactName];
  input.captureRawPages = ["provider-page-001.json", "provider-page-002.json"].map((name) => ({
    ...refs[name],
    name,
  }));
  const books: Record<string, any> = {};
  const bookPayloads: any[] = [];
  for (const b of p.books) {
    const pair: any = {};
    for (const [role, digest, d] of [
      ["previous", b.previousStateHash, b.previousDate],
      ["completed", b.completedStateHash, b.completedDate],
    ]) {
      const row = await rows("ledger_model_sessions", "series_id,session_date,state_hash,payload", {
        series_id: "eq." + b.seriesId,
        session_date: "eq." + d,
      });
      requireCheck(
        row.series_id === b.seriesId &&
          row.session_date === d &&
          row.state_hash === digest &&
          row.payload?.stateHash === digest,
      );
      const { stateHash, canonicalPayload, ...body } = row.payload;
      requireCheck(
        (await hashSeriesValue(body)) === stateHash &&
          canonicalSeriesJson(body) === canonicalPayload,
      );
      pair[role] = { ...json(row), pointer: "/payload" };
      bookPayloads.push(row.payload);
    }
    books[b.kind] = pair;
  }
  async function evidence(market: "KR" | "US", d: string) {
    const bytes = await get(
      objectPath(
        "cloudtrend-data",
        `${owner}/staging/integrated-allocation-inputs/v1/${market}/${d}.json`,
        owner,
      ),
    );
    const envelope = JSON.parse(bytes.toString());
    requireCheck(envelope.hash === (await hashSeriesValue(envelope.payload)));
    const payload = envelope.payload;
    requireCheck((market === "KR" ? payload.date : payload.analysis?.date) === d);
    const tags = market === "KR" ? ["K", "E"] : ["U"];
    for (const tag of tags) {
      const receipts = bookPayloads
        .flatMap((b) => b.result?.receipts ?? [])
        .filter((r: any) => r.id === `session:${tag}:${d}`);
      requireCheck(
        receipts.length > 0 &&
          receipts.every((r: any) => r.record?.sourceHash === payload.clock?.sourceHash),
      );
    }
    return save(bytes);
  }
  input.krEvidence26 = await evidence("KR", p.scope.targetDate);
  input.integrated = {
    krHistory: [],
    usPrevious: await evidence("US", p.previousDate),
    usCurrent: await evidence("US", p.scope.targetDate),
    books,
  };
  for (const d of p.krHistoryDates) input.integrated.krHistory.push(await evidence("KR", d));
  const result = path.join(directory, "input.json");
  fs.writeFileSync(result, canonicalSeriesJson(input), { flag: "wx", mode: 0o600 });
  return result;
}
