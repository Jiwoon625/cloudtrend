/** One bounded, privately anchored activation. No source collection or economic reset.
 * The ordinary KOSPI runner's workflow_dispatch guard remains unchanged.
 * This separate push route needs its own reviewed commit and private approval metadata.
 * Writes are NOT atomic across PostgreSQL and Storage. Any failure stops the sequence;
 * a repeated attempt only inspects private state and requires review, never force-resumes or claims completion.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ANALYSIS_BUCKET, sha256, stableJson, trustedSupabaseClient } from "./analysis-run-store";
import {
  loadAnalysisSourceInputs,
  listSourceRecords,
  type SourceRecord,
  type LoadedSourceInput,
} from "./source-registry-store";
import { verifyShadowRuntimeManifests } from "./verify-shadow-runtime-manifests";
import {
  canonicalSeriesJson,
  hashSeriesValue,
  verifyFrozenSeries,
  type FrozenModelSeries,
} from "../src/lib/ledger/modelSeries";
import { assertStoredOctoberRun, type OctoberRun } from "../src/lib/ledger/octoberShadowPipeline";
import { readKrSourceVintageApproval } from "../src/lib/krSourceVintageApproval.server";
import { KR_SOURCE_VINTAGE_REVIEW_ID } from "../src/lib/ledger/krSourceVintage";
import { replayKrShadow } from "../src/lib/shadowReplay.server";
import { parseManualMarketDataWithReferences } from "../src/lib/krxReviewReferenceParser";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import {
  KOSPI_SHADOW_POLICY,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "../src/lib/engine/kospiShadow";
import { buildKospiShadowSession } from "../src/lib/engine/kospiShadowDataset";
import {
  KOSPI_SHADOW_NAMESPACE,
  shadowObjectPath,
  type ShadowObjectStore,
} from "../src/lib/kospiShadowStore";
import {
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
  initializeKospiShadowRevision,
  openKospiShadowRevisionStore,
  kospiShadowRevisionPath,
  type KospiShadowRevisionApproval,
} from "../src/lib/kospiShadowSeries";
import { validDate } from "../src/lib/ledger/date";
import { sourceTimingEvidence } from "../src/lib/sourceTimingEvidence";
import { loadKospiShadowFromReader } from "../src/lib/kospiShadowCloud";
import { readIntegratedAllocationOutbox } from "../src/lib/integratedAllocationRecovery.server";
import { readIntegratedAllocationBook } from "../src/lib/integratedAllocationStore.server";

export const ACTIVATION_REF = "refs/heads/fix/shadow-private-activation-20261015";
export const ACTIVATION_WORKFLOW = "Approved private Shadow activation";
export const ACTIVATION_FILES = [
  ".github/workflows/shadow-private-activation.yml",
  "scripts/activate-approved-shadow.ts",
  "tests/shadow-private-activation.test.ts",
];
export const TARGET_DATE = "2026-10-14";
export const PREDECESSOR_DATE = "2026-10-13";
export const KR_BOOKS = [
  "ETF_V02",
  "KR_KOSDAQ",
  "KR_KOSPI",
  "KR_KOSPI_CONFIRM1_BEAR",
  "KR_MIXED",
].map((kind) => `adopted-shadow-2026-10-12-v1:${kind}`);
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const digest = /^sha256:[a-f\d]{64}$/;
const gitSha = /^[a-f\d]{40}$/;
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const clone = <T>(value: T): T => structuredClone(value);
function requireThat(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: object, keys: string[]) {
  return same(Object.keys(value).sort(), [...keys].sort());
}
export type SourcePin = Pick<
  SourceRecord,
  | "id"
  | "storage_bucket"
  | "storage_path"
  | "file_hash"
  | "data_hash"
  | "schema_hash"
  | "min_date"
  | "max_date"
  | "activated_at"
  | "created_at"
> & { timing_evidence: ReturnType<typeof timingPins> };
export interface ModelPin {
  series_id: string;
  session_date: string;
  state_hash: string;
}
export interface ActivationApproval {
  version: "shadow-private-activation-v1";
  status: "APPROVED";
  activationRef: typeof ACTIVATION_REF;
  expectedMainSha: string;
  expectedActivationSha: string;
  asOf: typeof TARGET_DATE;
  predecessorDate: typeof PREDECESSOR_DATE;
  expectedOctoberRuntimeHash: string;
  expectedIntegratedRuntimeHash: string;
  diagnosticPredecessorHash: string;
  diagnosticOriginalTargetHash: string;
  expectedCorrectedSourceHash: string;
  sources: SourcePin[];
  modelSessions: ModelPin[];
}
export function validateActivationApproval(value: unknown): ActivationApproval {
  requireThat(
    record(value) &&
      exactKeys(value, [
        "version",
        "status",
        "activationRef",
        "expectedMainSha",
        "expectedActivationSha",
        "asOf",
        "predecessorDate",
        "expectedOctoberRuntimeHash",
        "expectedIntegratedRuntimeHash",
        "diagnosticPredecessorHash",
        "diagnosticOriginalTargetHash",
        "expectedCorrectedSourceHash",
        "sources",
        "modelSessions",
      ]),
    "APPROVAL_SCHEMA",
  );
  requireThat(
    value["version"] === "shadow-private-activation-v1" &&
      value["status"] === "APPROVED" &&
      value["activationRef"] === ACTIVATION_REF &&
      value["asOf"] === TARGET_DATE &&
      value["predecessorDate"] === PREDECESSOR_DATE,
    "APPROVAL_SCOPE",
  );
  requireThat(
    gitSha.test(String(value["expectedMainSha"])) &&
      gitSha.test(String(value["expectedActivationSha"])) &&
      value["expectedMainSha"] !== value["expectedActivationSha"],
    "APPROVAL_COMMIT",
  );
  for (const field of [
    "expectedOctoberRuntimeHash",
    "expectedIntegratedRuntimeHash",
    "diagnosticPredecessorHash",
    "diagnosticOriginalTargetHash",
    "expectedCorrectedSourceHash",
  ])
    requireThat(digest.test(String(value[field])), "APPROVAL_DIGEST");
  requireThat(
    Array.isArray(value["sources"]) &&
      value["sources"].length > 0 &&
      value["sources"].length <= 100,
    "APPROVAL_SOURCES",
  );
  const ids = new Set<string>();
  for (const source of value["sources"]) {
    requireThat(
      record(source) &&
        exactKeys(source, [
          "id",
          "storage_bucket",
          "storage_path",
          "file_hash",
          "data_hash",
          "schema_hash",
          "min_date",
          "max_date",
          "activated_at",
          "created_at",
          "timing_evidence",
        ]) &&
        uuid.test(String(source["id"])) &&
        !ids.has(String(source["id"])) &&
        source["storage_bucket"] === ANALYSIS_BUCKET,
      "APPROVAL_SOURCE_SCHEMA",
    );
    requireThat(
      Array.isArray(source["timing_evidence"]) &&
        source["timing_evidence"].length > 0 &&
        source["timing_evidence"].length <= 1000,
      "APPROVAL_TIMING_BOUNDARY",
    );
    const timingIds = new Set<string>();
    for (const timing of source["timing_evidence"]) {
      requireThat(
        record(timing) &&
          exactKeys(timing, ["id", "min_date", "max_date", "activated_at", "created_at"]) &&
          typeof timing["id"] === "string" &&
          timing["id"].length > 0 &&
          !timingIds.has(timing["id"]),
        "APPROVAL_TIMING_SCHEMA",
      );
      timingIds.add(timing["id"]);
      requireThat(
        (timing["min_date"] === null ||
          (typeof timing["min_date"] === "string" && validDate(timing["min_date"]))) &&
          (timing["max_date"] === null ||
            (typeof timing["max_date"] === "string" &&
              validDate(timing["max_date"]) &&
              timing["max_date"] <= TARGET_DATE)),
        "APPROVAL_TIMING_DATE",
      );
      requireThat(
        typeof timing["created_at"] === "string" &&
          normalizedTimestamp(timing["created_at"]) === timing["created_at"] &&
          (timing["activated_at"] === null ||
            (typeof timing["activated_at"] === "string" &&
              normalizedTimestamp(timing["activated_at"]) === timing["activated_at"])),
        "APPROVAL_TIMING_TIMESTAMP",
      );
    }
    ids.add(String(source["id"]));
    requireThat(
      [source["file_hash"], source["data_hash"], source["schema_hash"]].every((x) =>
        digest.test(String(x)),
      ) &&
        typeof source["storage_path"] === "string" &&
        !source["storage_path"].includes("..") &&
        typeof source["max_date"] === "string" &&
        source["max_date"] <= TARGET_DATE,
      "APPROVAL_SOURCE_BOUNDARY",
    );
  }
  requireThat(
    Array.isArray(value["modelSessions"]) &&
      value["modelSessions"].length > 0 &&
      value["modelSessions"].length <= 1000,
    "APPROVAL_MODEL_PINS",
  );
  const sessions = new Set<string>();
  for (const pin of value["modelSessions"]) {
    requireThat(
      record(pin) &&
        exactKeys(pin, ["series_id", "session_date", "state_hash"]) &&
        typeof pin["series_id"] === "string" &&
        typeof pin["session_date"] === "string" &&
        pin["session_date"] <= TARGET_DATE &&
        digest.test(String(pin["state_hash"])),
      "APPROVAL_MODEL_PIN_SCHEMA",
    );
    const key = `${pin["series_id"]}:${pin["session_date"]}`;
    requireThat(
      !sessions.has(key) &&
        !(KR_BOOKS.includes(pin["series_id"]) && pin["session_date"] > PREDECESSOR_DATE),
      "APPROVAL_MODEL_PIN_BOUNDARY",
    );
    sessions.add(key);
  }
  for (const book of KR_BOOKS)
    requireThat(
      value["modelSessions"].some(
        (pin) => pin.series_id === book && pin.session_date === PREDECESSOR_DATE,
      ),
      "APPROVAL_MISSING_HEAD",
    );
  return clone(value) as unknown as ActivationApproval;
}
export function assertActivationEnvironment(env: NodeJS.ProcessEnv, approval?: ActivationApproval) {
  requireThat(
    env["GITHUB_ACTIONS"] === "true" &&
      env["GITHUB_EVENT_NAME"] === "push" &&
      env["GITHUB_WORKFLOW"] === ACTIVATION_WORKFLOW &&
      env["GITHUB_REF"] === ACTIVATION_REF &&
      env["GITHUB_REPOSITORY"] === "Jiwoon625/cloudtrend" &&
      /^[1-9]\d*$/.test(env["GITHUB_RUN_ATTEMPT"] ?? "") &&
      gitSha.test(env["GITHUB_SHA"] ?? ""),
    "ACTIVATION_ENVIRONMENT",
  );
  if (approval)
    requireThat(env["GITHUB_SHA"] === approval.expectedActivationSha, "ACTIVATION_COMMIT");
}
export function normalizedTimestamp(value: string | null) {
  if (value === null) return null;
  const parsed =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(
      value,
    );
  requireThat(
    parsed && validDate(parsed[1]!) && Number.isFinite(Date.parse(value)),
    "INVALID_SOURCE_TIMESTAMP",
  );
  // PostgreSQL stores microseconds. Preserve all six digits rather than truncating
  // order-sensitive activation timestamps to JavaScript's millisecond precision.
  return new Date(value).toISOString().slice(0, 19) + "." + (parsed[3] ?? "").padEnd(6, "0") + "Z";
}
export function timingPins(source: SourceRecord) {
  return sourceTimingEvidence(source)
    .map((row) => ({
      id: row.id ?? "",
      min_date: row.min_date ?? null,
      max_date: row.max_date ?? null,
      activated_at: normalizedTimestamp(row.activated_at ?? null),
      created_at: normalizedTimestamp(row.created_at ?? ""),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function sourcePins(records: SourceRecord[]): SourcePin[] {
  return records
    .map((record) => {
      const {
        id,
        storage_bucket,
        storage_path,
        file_hash,
        data_hash,
        schema_hash,
        min_date,
        max_date,
        activated_at,
        created_at,
      } = record;
      return {
        id,
        storage_bucket,
        storage_path,
        file_hash,
        data_hash,
        schema_hash,
        min_date,
        max_date,
        activated_at: normalizedTimestamp(activated_at),
        created_at: normalizedTimestamp(created_at)!,
        timing_evidence: timingPins(record),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function assertPinnedSources(
  records: SourceRecord[],
  approval: ActivationApproval,
  uid: string,
) {
  requireThat(
    records.every(
      (r) =>
        r.user_id === uid &&
        r.status === "active" &&
        r.source_type === "screening" &&
        r.storage_path.startsWith(`${uid}/source/screening/`),
    ),
    "SOURCE_OWNER_SCOPE",
  );
  requireThat(
    same(
      sourcePins(records),
      [...approval.sources].sort((a, b) => a.id.localeCompare(b.id)),
    ),
    "SOURCE_SET_CHANGED",
  );
}
async function readActivationApproval(client: SupabaseClient, uid: string) {
  const { data, error } = await client
    .from("shadow_replay_audit")
    .select("details,signal_date,status,replay_mode")
    .eq("user_id", uid)
    .eq("market", "KR")
    .eq("strategy_version", KR_SOURCE_VINTAGE_REVIEW_ID);
  requireThat(!error && data?.length === 2, "APPROVAL_ROWS_REQUIRED");
  requireThat(
    data.every(
      (row) =>
        row.signal_date === TARGET_DATE &&
        row.status === "RECORDED" &&
        row.replay_mode === "RETROSPECTIVE",
    ),
    "APPROVAL_ROW_SCOPE",
  );
  requireThat(
    data.filter((row) => row.details?.krSourceVintageApproval).length === 1 &&
      data.filter((row) => row.details?.krSourceVintageReview).length === 1,
    "APPROVAL_ROW_KEYS",
  );
  const a = validateActivationApproval(data[0]!.details?.shadowActivation),
    b = validateActivationApproval(data[1]!.details?.shadowActivation);
  requireThat(same(a, b), "ACTIVATION_APPROVAL_CONFLICT");
  requireThat(await readKrSourceVintageApproval(client, uid), "VINTAGE_APPROVAL_REQUIRED");
  return a;
}
function verifyGitBoundary(approval: ActivationApproval) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  requireThat(
    git("rev-parse", "HEAD") === approval.expectedActivationSha &&
      git("rev-parse", "HEAD^") === approval.expectedMainSha &&
      git("rev-list", "--parents", "-n", "1", "HEAD").split(/\s+/).length === 2,
    "ACTIVATION_PARENT",
  );
  const changed = git("diff", "--name-status", approval.expectedMainSha, "HEAD")
    .split("\n")
    .filter(Boolean);
  requireThat(
    same(changed.sort(), ACTIVATION_FILES.map((file) => `A\t${file}`).sort()),
    "ACTIVATION_DIFF",
  );
  requireThat(git("status", "--porcelain", "--untracked-files=no") === "", "ACTIVATION_DIRTY");
  const remoteMain = git("ls-remote", "--exit-code", "origin", "refs/heads/main").split(/\s+/)[0];
  requireThat(remoteMain === approval.expectedMainSha, "MAIN_ADVANCED");
}
export function correctionApprovalPath(uid: string) {
  return `${uid}/${KOSPI_SHADOW_NAMESPACE}/correction-approvals/${KOSPI_SHADOW_CORRECTION_REVISION_ID}.json`;
}
/** Executes the production replay against read-through snapshots and in-memory writes.
 * This is a calculation/collision preflight, not an emulation of PostgreSQL permission rules.
 */
export function stagedReplayClient(source: SupabaseClient, uid: string) {
  type Row = Record<string, unknown>;
  type Result = { data: Row[] | Row | null; error: unknown; count?: number | null | undefined };
  const tables = new Map<string, Row[]>(),
    objects = new Map<string, Blob>();
  const rows = (table: string) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };
  const contains = (actual: unknown, expected: unknown): boolean =>
    actual === undefined || expected === undefined
      ? actual === expected
      : record(expected)
        ? record(actual) &&
          Object.entries(expected).every(([key, value]) => contains(actual[key], value))
        : same(actual, expected);
  const client = {
    from(table: string) {
      requireThat(
        [
          "ledger_model_series",
          "ledger_model_sessions",
          "ledger_provenance_archive",
          "shadow_replay_audit",
        ].includes(table),
        "STAGED_TABLE_SCOPE",
      );
      let remote: unknown = source.from(table),
        single = false,
        selected = "*",
        limit: number | undefined,
        start = 0;
      const filters: Array<(row: Row) => boolean> = [],
        orders: Array<[string, boolean]> = [];
      const call = (name: string, args: unknown[]) => {
        const fn = Reflect.get(remote as object, name);
        requireThat(typeof fn === "function", "STAGED_QUERY_METHOD");
        remote = Reflect.apply(fn, remote, args);
      };
      const query = {
        select(...args: unknown[]) {
          selected = typeof args[0] === "string" ? args[0] : "*";
          call("select", args);
          return query;
        },
        eq(key: string, value: unknown) {
          filters.push((row) => row[key] !== undefined && same(row[key], value));
          call("eq", [key, value]);
          return query;
        },
        contains(key: string, value: unknown) {
          filters.push((row) => contains(row[key], value));
          call("contains", [key, value]);
          return query;
        },
        order(key: string, options?: { ascending?: boolean }) {
          orders.push([key, options?.ascending !== false]);
          call("order", [key, options]);
          return query;
        },
        limit(count: number) {
          limit = count;
          call("limit", [count]);
          return query;
        },
        range(from: number, to: number) {
          start = from;
          limit = to - from + 1;
          call("range", [from, to]);
          return query;
        },
        maybeSingle() {
          single = true;
          call("maybeSingle", []);
          return query;
        },
        async insert(value: Row | Row[]) {
          requireThat(table === "shadow_replay_audit", "STAGED_INSERT_SCOPE");
          rows(table).push(...clone(Array.isArray(value) ? value : [value]));
          return { data: null, error: null };
        },
        then(resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) {
          return (async () => {
            const result = await (remote as PromiseLike<Result>);
            if (result.error) return result;
            const additions = rows(table).filter((row) => filters.every((filter) => filter(row)));
            const data = [
              ...(Array.isArray(result.data) ? result.data : result.data ? [result.data] : []),
              ...clone(additions),
            ];
            data.sort((a, b) => {
              for (const [key, asc] of orders) {
                const left = String(a[key] ?? ""),
                  right = String(b[key] ?? "");
                if (left !== right) return (left < right ? -1 : 1) * (asc ? 1 : -1);
              }
              return 0;
            });
            const sliced = (limit === undefined ? data : data.slice(start, start + limit)).map(
              (row) =>
                selected === "*"
                  ? row
                  : Object.fromEntries(
                      selected.split(",").map((key) => [key.trim(), row[key.trim()]]),
                    ),
            );
            requireThat(!single || sliced.length <= 1, "STAGED_MULTIPLE_ROWS");
            return {
              data: single ? (sliced[0] ?? null) : sliced,
              error: null,
              count:
                typeof result.count === "number"
                  ? result.count + additions.length
                  : (result.count ?? null),
            };
          })().then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      requireThat(
        name === "ledger_append_model_session" && args["p_user_id"] === uid,
        "STAGED_RPC_SCOPE",
      );
      const run = args["p_run"] as Row,
        series = args["p_series"] as FrozenModelSeries;
      await verifyFrozenSeries(series);
      if (record(run["publicationArtifact"])) {
        const artifact = run["publicationArtifact"],
          payload = artifact["payload"] as Row;
        requireThat((await hashSeriesValue(payload)) === artifact["hash"], "STAGED_ARTIFACT_HASH");
        const sourceId =
          artifact["kind"] === "KR_DAILY_INPUT"
            ? `october-input:KR:${payload["date"]}:${String(artifact["hash"]).slice(7)}`
            : `october-prepared:KR:${payload["date"]}`;
        const old = await client
          .from("ledger_provenance_archive")
          .select("payload,source_hash")
          .eq("user_id", uid)
          .eq("source_id", sourceId)
          .eq("source_revision", "1")
          .maybeSingle();
        requireThat(
          !old.error &&
            (!old.data ||
              (record(old.data) &&
                same(old.data["payload"], payload) &&
                old.data["source_hash"] === artifact["hash"])),
          "STAGED_ARTIFACT_COLLISION",
        );
        if (!old.data)
          rows("ledger_provenance_archive").push({
            user_id: uid,
            source_id: sourceId,
            source_revision: "1",
            source_hash: artifact["hash"],
            payload: clone(payload),
          });
        return { data: { artifact: clone(payload) }, error: null };
      }
      await assertStoredOctoberRun(series, run as unknown as OctoberRun);
      const receipt = run["receipt"] as Row;
      const old = await client
        .from("ledger_model_sessions")
        .select("payload")
        .eq("user_id", uid)
        .eq("series_id", run["bookId"])
        .eq("session_date", receipt["date"])
        .maybeSingle();
      requireThat(
        !old.error && (!old.data || (record(old.data) && same(old.data["payload"], run))),
        "STAGED_SESSION_COLLISION",
      );
      if (!old.data) {
        const previous = await client
          .from("ledger_model_sessions")
          .select("payload")
          .eq("user_id", uid)
          .eq("series_id", run["bookId"])
          .order("session_date", { ascending: false })
          .limit(1)
          .maybeSingle();
        const prior = (previous.data as Row | null)?.["payload"] as OctoberRun | undefined;
        requireThat(
          !previous.error &&
            (prior?.receipt.date ?? null) === args["p_previous_date"] &&
            (prior?.stateHash ?? null) === args["p_previous_hash"],
          "STAGED_PREDECESSOR_CHANGED",
        );
        rows("ledger_model_sessions").push({
          user_id: uid,
          series_id: run["bookId"],
          session_date: receipt["date"],
          state_hash: run["stateHash"],
          payload: clone(run),
        });
      }
      return { data: { reused: !!old.data, stateHash: run["stateHash"] }, error: null };
    },
    storage: {
      from(bucket: string) {
        requireThat(bucket === ANALYSIS_BUCKET, "STAGED_BUCKET_SCOPE");
        return {
          async download(path: string, ...args: unknown[]) {
            if (objects.has(path)) return { data: objects.get(path)!, error: null };
            return Reflect.apply(
              source.storage.from(bucket).download,
              source.storage.from(bucket),
              [path, ...args],
            );
          },
          async upload(path: string, body: Blob | string, options?: { upsert?: boolean }) {
            requireThat(options?.upsert === false, "STAGED_STORAGE_UPSERT");
            const remote = objects.has(path)
              ? { data: objects.get(path), error: null }
              : await source.storage
                  .from(bucket)
                  .download(path, { cacheNonce: crypto.randomUUID() }, { cache: "no-store" });
            if (remote.error)
              requireThat(
                String(remote.error.statusCode) === "404" ||
                  remote.error.message === "Object not found",
                "STAGED_STORAGE_READ_FAILED",
              );
            const old = remote.data;
            const next = body instanceof Blob ? body : new Blob([body]);
            requireThat(
              !old || (await old.text()) === (await next.text()),
              "STAGED_STORAGE_COLLISION",
            );
            if (old) return { data: null, error: { statusCode: "409", message: "Duplicate" } };
            objects.set(path, next);
            return { data: null, error: null };
          },
        };
      },
    },
  };
  return { client: client as unknown as SupabaseClient, tables, objects };
}

/** No original-object writes; exact correction namespace only, always insert-only. */
export function privateShadowStore(client: SupabaseClient, uid: string): ShadowObjectStore {
  requireThat(uuid.test(uid), "OWNER_INVALID");
  const revisionRoot = kospiShadowRevisionPath(uid, "latest.json").replace(/\/latest.json$/, "");
  const store: ShadowObjectStore = {
    async read<T>(path: string) {
      requireThat(
        path.startsWith(`${uid}/${KOSPI_SHADOW_NAMESPACE}/`) && !path.includes(".."),
        "STORAGE_READ_SCOPE",
      );
      const { data, error } = await client.storage
        .from(ANALYSIS_BUCKET)
        .download(path, { cacheNonce: crypto.randomUUID() }, { cache: "no-store" });
      if (error) {
        if (String(error.statusCode) === "404" || error.message === "Object not found") return null;
        throw new Error("STORAGE_READ_FAILED");
      }
      requireThat(data, "STORAGE_EMPTY");
      return JSON.parse(await data.text()) as T;
    },
    async latestSessionDate(path: string) {
      requireThat(
        [`${uid}/${KOSPI_SHADOW_NAMESPACE}/sessions`, `${revisionRoot}/sessions`].includes(path),
        "STORAGE_LIST_SCOPE",
      );
      const { data, error } = await client.storage
        .from(ANALYSIS_BUCKET)
        .list(path, { limit: 1, sortBy: { column: "name", order: "desc" } });
      requireThat(!error, "STORAGE_LIST_FAILED");
      const name = data?.[0]?.name;
      requireThat(!name || /^\d{4}-\d{2}-\d{2}\.json$/.test(name), "STORAGE_SESSION_NAME");
      return name?.slice(0, -5) ?? null;
    },
    async putImmutable(path: string, value: unknown) {
      requireThat(
        path === correctionApprovalPath(uid) ||
          path === `${revisionRoot}/revision.json` ||
          path === `${revisionRoot}/registry.json` ||
          (path.startsWith(`${revisionRoot}/sessions/`) &&
            validDate(path.slice(`${revisionRoot}/sessions/`.length, -5)) &&
            path.endsWith(".json") &&
            path.slice(`${revisionRoot}/sessions/`.length, -5) <= TARGET_DATE),
        "STORAGE_WRITE_SCOPE",
      );
      const old = await store.read(path);
      if (old !== null) {
        requireThat(same(old, value), "STORAGE_COLLISION");
        return;
      }
      await client.storage.from(ANALYSIS_BUCKET).upload(path, JSON.stringify(value), {
        upsert: false,
        contentType: "application/json",
        cacheControl: "0",
      });
      requireThat(same(await store.read(path), value), "STORAGE_WRITE_UNCERTAIN");
    },
    async putLatest(path: string, value: unknown) {
      requireThat(path === `${revisionRoot}/latest.json`, "STORAGE_LATEST_SCOPE");
      const old = await store.read(path);
      if (old !== null) {
        requireThat(same(old, value), "STORAGE_LATEST_COLLISION");
        return;
      }
      await client.storage.from(ANALYSIS_BUCKET).upload(path, JSON.stringify(value), {
        upsert: false,
        contentType: "application/json",
        cacheControl: "0",
      });
      requireThat(same(await store.read(path), value), "STORAGE_LATEST_UNCERTAIN");
    },
  };
  return store;
}
/** Read-through, in-memory writes only. Never invokes a mutation on its source store. */
export function stagingStore(source: Pick<ShadowObjectStore, "read" | "latestSessionDate">) {
  const staged = new Map<string, unknown>();
  const store: ShadowObjectStore = {
    read: async <T>(path: string) =>
      staged.has(path) ? (clone(staged.get(path)) as T) : source.read<T>(path),
    latestSessionDate: async (path) => {
      const remote = await source.latestSessionDate(path);
      const local = [...staged.keys()]
        .filter((key) => key.startsWith(`${path}/`))
        .map((key) => key.slice(path.length + 1))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .map((name) => name.slice(0, -5));
      return [...local, ...(remote ? [remote] : [])].sort().at(-1) ?? null;
    },
    putImmutable: async (path, value) => {
      const old = await store.read(path);
      requireThat(old === null || same(old, value), "STAGED_COLLISION");
      staged.set(path, clone(value));
    },
    putLatest: async (path, value) => {
      staged.set(path, clone(value));
    },
  };
  return { store, staged };
}
export async function prepareCorrectionApproval(
  store: ShadowObjectStore,
  uid: string,
  approval: ActivationApproval,
  session: KospiShadowSession,
  config: unknown,
  computedAt: string,
) {
  const predecessor = await store.read<KospiShadowSnapshot>(
    shadowObjectPath(uid, `sessions/${PREDECESSOR_DATE}.json`),
  );
  const original = await store.read<KospiShadowSnapshot>(
    shadowObjectPath(uid, `sessions/${TARGET_DATE}.json`),
  );
  requireThat(predecessor && original, "ORIGINALS_MISSING");
  requireThat(
    `sha256:${sha256(stableJson(predecessor))}` === approval.diagnosticPredecessorHash &&
      `sha256:${sha256(stableJson(original))}` === approval.diagnosticOriginalTargetHash,
    "DIAGNOSTIC_ANCHOR_CHANGED",
  );
  requireThat(
    session.date === TARGET_DATE && session.sourceHash === approval.expectedCorrectedSourceHash,
    "CORRECTED_SOURCE_CHANGED",
  );
  const result: Omit<KospiShadowRevisionApproval, "computedAt"> = {
    revisionId: KOSPI_SHADOW_CORRECTION_REVISION_ID,
    predecessorDate: PREDECESSOR_DATE,
    correctionDate: TARGET_DATE,
    expectedPredecessorHash: await hashSeriesValue(predecessor),
    expectedOriginalTargetHash: await hashSeriesValue(original),
    expectedCorrectedSourceHash: session.sourceHash,
  };
  // Complete registry, chain, prefix, config, source timing and collision validation, in memory.
  const staged = stagingStore(store);
  const existingRevision = await store.read<{ computedAt: string }>(
    kospiShadowRevisionPath(uid, "revision.json"),
  );
  const effectiveTime = existingRevision?.computedAt ?? computedAt;
  await initializeKospiShadowRevision(staged.store, uid, session, config, {
    ...result,
    computedAt: effectiveTime,
  });
  return { approval: result, computedAt: effectiveTime, staged };
}
interface ModelRow {
  series_id: string;
  session_date: string;
  state_hash: string;
  payload: OctoberRun;
}
async function readModels(client: SupabaseClient, uid: string) {
  const [r, s] = await Promise.all([
    client
      .from("ledger_model_series")
      .select("series_id,payload", { count: "exact" })
      .eq("user_id", uid)
      .order("series_id")
      .range(0, 999),
    client
      .from("ledger_model_sessions")
      .select("series_id,session_date,state_hash,payload", { count: "exact" })
      .eq("user_id", uid)
      .order("series_id")
      .order("session_date")
      .range(0, 999),
  ]);
  requireThat(
    !r.error &&
      !s.error &&
      r.count === r.data?.length &&
      s.count === s.data?.length &&
      r.data.length > 0,
    "MODEL_READ_INCOMPLETE",
  );
  return {
    registries: r.data as Array<{ series_id: string; payload: FrozenModelSeries }>,
    sessions: s.data as ModelRow[],
  };
}
export async function assertModelPins(
  models: Awaited<ReturnType<typeof readModels>>,
  approval: ActivationApproval,
  completed: boolean,
) {
  const key = (row: ModelPin) => `${row.series_id}:${row.session_date}`;
  const pins = new Map(approval.modelSessions.map((pin) => [key(pin), pin]));
  requireThat(
    models.sessions.length === pins.size + (completed ? KR_BOOKS.length : 0),
    "MODEL_COUNT_CHANGED",
  );
  const registries = new Map(models.registries.map((row) => [row.series_id, row.payload]));
  for (const row of models.sessions) {
    const pin = pins.get(key(row));
    requireThat(
      pin
        ? row.state_hash === pin.state_hash
        : completed && KR_BOOKS.includes(row.series_id) && row.session_date === TARGET_DATE,
      "MODEL_SESSION_CHANGED",
    );
    requireThat(row.payload.stateHash === row.state_hash, "MODEL_STORED_HASH");
    const { stateHash, canonicalPayload, ...body } = row.payload as OctoberRun & {
      canonicalPayload?: string;
    };
    requireThat(
      (await hashSeriesValue(body)) === stateHash &&
        (canonicalPayload === undefined || canonicalPayload === canonicalSeriesJson(body)),
      "MODEL_CONTENT_CHANGED",
    );
    if (row.series_id.startsWith("adopted-shadow-")) {
      const series = registries.get(row.series_id);
      requireThat(series, "MODEL_REGISTRY_MISSING");
      await verifyFrozenSeries(series);
      await assertStoredOctoberRun(series, row.payload);
    }
  }
  for (const book of KR_BOOKS)
    requireThat(
      models.sessions.filter((row) => row.series_id === book).at(-1)?.session_date ===
        (completed ? TARGET_DATE : PREDECESSOR_DATE),
      "MODEL_HEAD_CHANGED",
    );
}
/** An additional client-side fence. Frozen RPCs remain the authoritative atomic validator. */
export function boundedReplayClient(client: SupabaseClient, uid: string): SupabaseClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === "rpc")
        return (name: string, args: Record<string, unknown>) => {
          const run = args["p_run"] as Record<string, unknown>,
            series = args["p_series"] as Record<string, unknown>;
          requireThat(
            name === "ledger_append_model_session" &&
              args["p_user_id"] === uid &&
              record(run) &&
              record(series) &&
              KR_BOOKS.includes(String(series["bookId"])) &&
              run["bookId"] === series["bookId"],
            "RPC_SCOPE",
          );
          if (record(run["publicationArtifact"])) {
            const artifact = run["publicationArtifact"],
              payload = artifact["payload"] as Record<string, unknown>;
            requireThat(
              ["KR_DAILY_INPUT", "PREPARED_PUBLICATION"].includes(String(artifact["kind"])) &&
                record(payload) &&
                payload["date"] === TARGET_DATE &&
                (artifact["kind"] !== "PREPARED_PUBLICATION" || payload["market"] === "KR") &&
                args["p_previous_date"] === null &&
                args["p_previous_hash"] === null,
              "RPC_ARTIFACT_SCOPE",
            );
          } else
            requireThat(
              record(run["receipt"]) &&
                run["receipt"]["date"] === TARGET_DATE &&
                args["p_previous_date"] === PREDECESSOR_DATE &&
                typeof args["p_previous_hash"] === "string",
              "RPC_SESSION_SCOPE",
            );
          return target.rpc(name, args);
        };
      if (property === "from")
        return (table: string) =>
          new Proxy(target.from(table), {
            get(query, method) {
              if (["update", "delete", "upsert"].includes(String(method)))
                return () => {
                  throw new Error("TABLE_MUTATION_FORBIDDEN");
                };
              if (method === "insert")
                return (values: Record<string, unknown> | Record<string, unknown>[]) => {
                  const rows = Array.isArray(values) ? values : [values];
                  requireThat(
                    table === "shadow_replay_audit" &&
                      rows.every(
                        (row) =>
                          row["user_id"] === uid &&
                          row["market"] === "KR" &&
                          row["signal_date"] === TARGET_DATE &&
                          [
                            "adopted-shadow-2026-10-12-v1",
                            "integrated-allocation-shadow-2026-10-12-v1",
                          ].includes(String(row["strategy_version"])) &&
                          record(row["details"]) &&
                          !Object.hasOwn(row["details"], "shadowActivation") &&
                          !Object.hasOwn(row["details"], "krSourceVintageApproval") &&
                          !Object.hasOwn(row["details"], "krSourceVintageReview"),
                      ),
                    "AUDIT_SCOPE",
                  );
                  return query.insert(values);
                };
              const member = Reflect.get(query, method);
              return typeof member === "function" ? member.bind(query) : member;
            },
          });
      if (property === "storage")
        return {
          from: (bucket: string) => {
            requireThat(bucket === ANALYSIS_BUCKET, "REPLAY_BUCKET_SCOPE");
            const bucketClient = target.storage.from(bucket);
            return new Proxy(bucketClient, {
              get(storage, method) {
                if (method === "upload")
                  return (
                    path: string,
                    body: Parameters<typeof storage.upload>[1],
                    options: Parameters<typeof storage.upload>[2],
                  ) => {
                    requireThat(
                      path ===
                        `${uid}/staging/integrated-allocation-inputs/v1/KR/${TARGET_DATE}.json` &&
                        options?.upsert === false,
                      "REPLAY_STORAGE_WRITE_SCOPE",
                    );
                    return storage.upload(path, body, options);
                  };
                requireThat(["download", "list"].includes(String(method)), "REPLAY_STORAGE_METHOD");
                const member = Reflect.get(storage, method);
                return typeof member === "function" ? member.bind(storage) : member;
              },
            });
          },
        };
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
async function assertOriginalsUnchanged(
  store: ShadowObjectStore,
  uid: string,
  originals: Map<string, unknown>,
) {
  for (const [path, value] of originals)
    requireThat(same(await store.read(path), value), "ORIGINAL_CHANGED");
  requireThat(
    (await store.latestSessionDate(`${uid}/${KOSPI_SHADOW_NAMESPACE}/sessions`)) === TARGET_DATE,
    "ORIGINAL_ADVANCED",
  );
}
async function snapshotOriginals(store: ShadowObjectStore, uid: string) {
  const result = new Map<string, unknown>();
  for (const suffix of ["registry.json", "latest.json"]) {
    const path = shadowObjectPath(uid, suffix);
    const value = await store.read(path);
    requireThat(value, "ORIGINAL_MISSING");
    result.set(path, value);
  }
  let date: string | null = TARGET_DATE;
  while (date) {
    const path = shadowObjectPath(uid, `sessions/${date}.json`);
    const value: KospiShadowSnapshot | null = await store.read(path);
    requireThat(value && result.size < 1000, "ORIGINAL_CHAIN_MISSING");
    result.set(path, value);
    const registry = result.get(shadowObjectPath(uid, "registry.json")) as {
      initializedDate: string;
    };
    if (date === registry.initializedDate) break;
    requireThat(
      value.source.previousSessionDate && value.source.previousSessionDate < date,
      "ORIGINAL_CHAIN_INVALID",
    );
    date = value.source.previousSessionDate;
  }
  return result;
}
function sessionFromInputs(inputs: LoadedSourceInput[], expected: ActivationApproval, now: string) {
  const { dataset } = parseManualMarketData(inputs.map((input) => input.text));
  requireThat(dataset.asOfDate === TARGET_DATE, "SOURCE_DATE_CHANGED");
  const sourceHash = `sha256:${sha256(
    inputs
      .map((input) => input.dataHash)
      .sort()
      .join("\n"),
  )}`;
  requireThat(sourceHash === expected.expectedCorrectedSourceHash, "SOURCE_DIGEST_CHANGED");
  const timing = inputs
    .flatMap((input) =>
      sourceTimingEvidence(
        input.sourceRecord ?? {
          min_date: input.validation.stats.minDate,
          max_date: input.validation.stats.maxDate,
          savedAt: input.savedAt,
        },
      ),
    )
    .filter((row) => row.max_date === TARGET_DATE)
    .map((row) => row.activated_at ?? row.savedAt ?? row.created_at ?? "");
  requireThat(
    timing.length > 0 && timing.every((at) => Number.isFinite(Date.parse(at))),
    "SOURCE_TIMING_MISSING",
  );
  const sourceCollectedAt = timing.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)!;
  const config = { policy: KOSPI_SHADOW_POLICY, scoring: DEFAULT_SCORING_CONFIG };
  const session = buildKospiShadowSession(
    dataset,
    DEFAULT_SCORING_CONFIG,
    {
      sourceHash,
      configHash: `sha256:${sha256(stableJson(config))}`,
      codeVersion: expected.expectedActivationSha,
      sourceCollectedAt,
      now,
    },
    TARGET_DATE,
  );
  const krDataset = parseManualMarketDataWithReferences(inputs.map((input) => input.text)).dataset;
  requireThat(krDataset.asOfDate === TARGET_DATE, "KR_SOURCE_DATE_CHANGED");
  return { dataset: krDataset, config, session };
}
export function assertReplayResult(value: Awaited<ReturnType<typeof replayKrShadow>>) {
  const result = value as typeof value & {
    integratedAllocation?: { recorded: number; waiting: string | null };
  };
  requireThat(
    result.deferred === null &&
      result.throughDate === TARGET_DATE &&
      result.processed.length === 1 &&
      result.processed[0]?.date === TARGET_DATE &&
      result.processed[0]?.records.length === KR_BOOKS.length &&
      result.integratedAllocation?.recorded === 0 &&
      result.integratedAllocation.waiting === null,
    "KR_RESUME_INCOMPLETE",
  );
}
let activationStage = "NOT_STARTED";
function stage(value: string) {
  activationStage = value;
  console.log(JSON.stringify({ stage: value }));
}
export async function activateApprovedShadow() {
  stage("PREFLIGHT_START");
  assertActivationEnvironment(process.env);
  const runtime = await verifyShadowRuntimeManifests();
  const uid = process.env["SUPABASE_USER_ID"];
  requireThat(uid && uuid.test(uid), "OWNER_REQUIRED");
  const client = trustedSupabaseClient(),
    approval = await readActivationApproval(client, uid);
  assertActivationEnvironment(process.env, approval);
  verifyGitBoundary(approval);
  requireThat(
    runtime.octoberRuntimeCodeHash === approval.expectedOctoberRuntimeHash &&
      runtime.integratedRuntimeCodeHash === approval.expectedIntegratedRuntimeHash,
    "RUNTIME_APPROVAL_CHANGED",
  );
  const records = await listSourceRecords(client, uid, "screening");
  assertPinnedSources(records, approval, uid);
  const inputs = await loadAnalysisSourceInputs(client, uid, "screening", { compact: true });
  requireThat(
    inputs.every((input) => input.sourceRecord),
    "LEGACY_SOURCE_FORBIDDEN",
  );
  assertPinnedSources(
    inputs.map((input) => input.sourceRecord!),
    approval,
    uid,
  );
  const now = new Date().toISOString(),
    { dataset, config, session } = sessionFromInputs(inputs, approval, now);
  const store = privateShadowStore(client, uid),
    originals = await snapshotOriginals(store, uid);
  const prepared = await prepareCorrectionApproval(store, uid, approval, session, config, now);
  const before = await readModels(client, uid),
    existingApproval = await store.read(correctionApprovalPath(uid));
  const completed = KR_BOOKS.every((book) =>
    before.sessions.some((row) => row.series_id === book && row.session_date === TARGET_DATE),
  );
  await assertModelPins(before, approval, completed);
  for (const kind of ["O1", "S07"] as const)
    requireThat(
      (await readIntegratedAllocationBook(client, uid, kind)).head?.receipt.date === TARGET_DATE,
      "INTEGRATED_HEAD_CHANGED",
    );
  if (existingApproval !== null) {
    requireThat(same(existingApproval, prepared.approval), "EXISTING_APPROVAL_CONFLICT");
    // Never claim an exact replay plan from independently valid heads alone.
    // Repeated jobs inspect state but require a separate review before any conclusion or write.
    requireThat(false, "REPEATED_ACTIVATION_REQUIRES_REVIEW");
  }

  requireThat(
    !completed &&
      process.env["GITHUB_RUN_ATTEMPT"] === "1" &&
      prepared.staged.staged.size > 0 &&
      !(await store.read(kospiShadowRevisionPath(uid, "revision.json"))),
    "ACTIVATION_NOT_PRISTINE",
  );
  // Last read-only gate. Changed main, inputs, approval, originals or model rows stops before writes.
  verifyGitBoundary(approval);
  requireThat(same(await readActivationApproval(client, uid), approval), "APPROVAL_CHANGED");
  assertPinnedSources(await listSourceRecords(client, uid, "screening"), approval, uid);
  await assertOriginalsUnchanged(store, uid, originals);
  requireThat(same(await readModels(client, uid), before), "MODEL_RACED");
  const replayInput = {
    userId: uid,
    dataset,
    config: DEFAULT_SCORING_CONFIG,
    calculatedAt: now,
    mode: "service",
    sources: inputs.map((input) => ({
      id: input.id,
      min_date: input.validation.stats.minDate,
      max_date: input.validation.stats.maxDate,
      activated_at: input.sourceRecord!.activated_at,
      created_at: input.sourceRecord!.created_at,
      savedAt: input.savedAt,
      validation_result: input.sourceRecord!.validation_result,
    })),
  } as const;
  const stagedKr = stagedReplayClient(client, uid);
  const preview = await replayKrShadow({
    ...replayInput,
    client: boundedReplayClient(stagedKr.client, uid),
  });
  assertReplayResult(preview);
  const plannedModels = await readModels(stagedKr.client, uid);
  await assertModelPins(plannedModels, approval, true);
  requireThat(same(plannedModels.registries, before.registries), "STAGED_REGISTRY_CHANGED");
  const evidencePath = `${uid}/staging/integrated-allocation-inputs/v1/KR/${TARGET_DATE}.json`;
  const evidenceRead = await stagedKr.client.storage.from(ANALYSIS_BUCKET).download(evidencePath);
  requireThat(!evidenceRead.error && evidenceRead.data, "STAGED_EVIDENCE_REQUIRED");
  const evidence = JSON.parse(await evidenceRead.data.text()) as { hash: string; payload: unknown };
  requireThat((await hashSeriesValue(evidence.payload)) === evidence.hash, "STAGED_EVIDENCE_HASH");
  const retained = await readIntegratedAllocationOutbox(client, uid, "KR", TARGET_DATE);
  requireThat(retained === null || same(retained, evidence.payload), "RETAINED_EVIDENCE_CONFLICT");
  // Repeat immediately after the expensive no-write calculation and before the first write.
  verifyGitBoundary(approval);
  requireThat(same(await readActivationApproval(client, uid), approval), "APPROVAL_CHANGED");
  assertPinnedSources(await listSourceRecords(client, uid, "screening"), approval, uid);
  await assertOriginalsUnchanged(store, uid, originals);
  requireThat(same(await readModels(client, uid), before), "MODEL_RACED");
  requireThat(
    same(await readIntegratedAllocationOutbox(client, uid, "KR", TARGET_DATE), retained),
    "RETAINED_EVIDENCE_RACED",
  );
  stage("PREFLIGHT_VERIFIED");
  await store.putImmutable(correctionApprovalPath(uid), prepared.approval);
  stage("APPROVAL_FILE_VERIFIED");
  const replay = await replayKrShadow({ ...replayInput, client: boundedReplayClient(client, uid) });
  assertReplayResult(replay);
  const afterKr = await readModels(client, uid);
  await assertModelPins(afterKr, approval, true);
  requireThat(same(afterKr, plannedModels), "LIVE_PLAN_MISMATCH");
  requireThat(same(before.registries, afterKr.registries), "REGISTRIES_CHANGED");
  await assertOriginalsUnchanged(store, uid, originals);
  assertPinnedSources(await listSourceRecords(client, uid, "screening"), approval, uid);
  verifyGitBoundary(approval);
  stage("KR_VERIFIED");
  await initializeKospiShadowRevision(store, uid, session, config, {
    ...prepared.approval,
    computedAt: prepared.computedAt,
  });
  await openKospiShadowRevisionStore(store, uid);
  await assertOriginalsUnchanged(store, uid, originals);
  stage("KOSPI_VERIFIED");
  const final = await readModels(client, uid);
  requireThat(same(final, afterKr), "MODEL_CHANGED_DURING_KOSPI");
  // Read-only staged repetition verifies idempotent reuse without a second live bootstrap.
  const check = stagingStore(store);
  const reused = await initializeKospiShadowRevision(check.store, uid, session, config, {
    ...prepared.approval,
    computedAt: prepared.computedAt,
  });
  requireThat(reused.reused && check.staged.size === 0, "IDEMPOTENCY_CHECK_FAILED");
  const appReader = <T>(path: string) => store.read<T>(`${uid}/${path}`);
  const correctedView = await loadKospiShadowFromReader(appReader);
  const originalView = await loadKospiShadowFromReader(appReader, true);
  requireThat(
    correctedView?.latest.source.date === TARGET_DATE &&
      correctedView.latest.source.sourceHash === approval.expectedCorrectedSourceHash &&
      same(originalView, originals.get(shadowObjectPath(uid, "latest.json"))),
    "APP_READ_MODEL_MISMATCH",
  );
  stage("FINAL_VERIFIED");
  console.log(
    JSON.stringify({
      status: "VERIFIED",
      date: TARGET_DATE,
      krBooks: KR_BOOKS.length,
      kospiRetrospective: true,
      originalsPreserved: true,
      capitalReset: false,
      sourceCollection: false,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  activateApprovedShadow().catch(() => {
    console.error(
      JSON.stringify({
        status: "STOPPED",
        stage: activationStage,
        code: "PRIVATE_VALIDATION_OR_WRITE_FAILED",
      }),
    );
    console.error(
      "Private Shadow activation stopped. No automatic retry or further write was attempted; inspect private state before continuing.",
    );
    process.exitCode = 1;
  });
