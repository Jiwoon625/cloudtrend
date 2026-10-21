/** Bounded historical-input adapter. It never changes the frozen economic engine. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { gunzipSync } from "node:zlib";
import publicationRuntime from "../src/lib/kospiShadowPublicationRuntime.generated.json";
import {
  ANALYSIS_BUCKET,
  codeVersion,
  downloadJson,
  sha256,
  stableJson,
} from "./analysis-run-store";
import { type SourceRecord } from "./source-registry-store";
import { validateSourceBytes } from "../src/lib/sourceData";
import { sourceTimingEvidence } from "../src/lib/sourceTimingEvidence";
import { nextKrRegularSession } from "../src/lib/ledger/krShadowDecision";
import { regularOpenAt } from "../src/lib/ledger/octoberShadowCalendar";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { KOSPI_SHADOW_POLICY, type KospiShadowSession } from "../src/lib/engine/kospiShadow";
import { buildKospiShadowSession } from "../src/lib/engine/kospiShadowDataset";
import { openKospiShadowRevisionStore } from "../src/lib/kospiShadowSeries";
import {
  persistKospiShadow,
  shadowObjectPath,
  type KospiShadowView,
  type ShadowObjectStore,
} from "../src/lib/kospiShadowStore";

const digest = (value: unknown) => `sha256:${sha256(stableJson(value))}`;
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const time = (s: string) => {
  const n = Date.parse(s);
  if (!Number.isFinite(n)) throw new Error("Missing or invalid historical timestamp");
  return n;
};
export function recoveryCutoff(date: string) {
  const next = nextKrRegularSession(date);
  if (!next) throw new Error("Historical decision calendar is not covered");
  return { next, cutoff: regularOpenAt("KR", next) };
}
export interface HistoricalSource {
  id: string;
  objectPath: string;
  savedAt: string;
  fileHash: string;
  dataHash: string;
  schemaHash: string;
}
interface HistoricalBundle {
  run: { id: string; kind: string; createdAt: string; codeVersion: string; dataVersion: string };
  data: { asOfDate: string; sources: HistoricalSource[] };
  config: unknown;
}
/** Reject ambiguity rather than inferring historical membership from mutable current status. */
export function historicalRecords(records: SourceRecord[], cutoff: string) {
  const before = records.filter((r) => time(r.created_at) < time(cutoff));
  if (before.some((r) => time(r.updated_at) >= time(cutoff)))
    throw new Error(
      "Historical source membership changed after cutoff; immutable membership evidence required",
    );
  return before.filter(
    (r) => r.status === "active" && r.activated_at && time(r.activated_at) < time(cutoff),
  );
}
export function assertHistoricalManifest(
  bundle: HistoricalBundle,
  records: SourceRecord[],
  date: string,
  expectedVersion: string,
) {
  const { cutoff, next } = recoveryCutoff(date);
  const sources = bundle?.data?.sources;
  if (
    bundle?.run?.kind !== "SCREENING" ||
    bundle.data.asOfDate !== date ||
    !Array.isArray(sources) ||
    !sources.length
  )
    throw new Error("Exact-date historical screening manifest required");
  if (bundle.run.dataVersion !== expectedVersion || !hashPattern.test(expectedVersion))
    throw new Error("Historical run data version mismatch");
  const selected = historicalRecords(records, cutoff);
  if (
    sources.length !== selected.length ||
    new Set(sources.map((s) => s.id)).size !== sources.length
  )
    throw new Error("Incomplete historical source set");
  sources.forEach((source, i) => {
    const record = selected[i]!;
    if (
      source.id !== record.id ||
      source.objectPath !== record.storage_path ||
      source.fileHash !== record.file_hash ||
      source.dataHash !== record.data_hash ||
      source.schemaHash !== record.schema_hash ||
      !record.activated_at ||
      time(source.savedAt) !== time(record.activated_at) ||
      time(source.savedAt) >= time(cutoff) ||
      ![source.fileHash, source.dataHash, source.schemaHash].every((h) => hashPattern.test(h))
    )
      throw new Error("Historical source order, identity, availability or hash changed");
    if (
      record.storage_bucket !== ANALYSIS_BUCKET ||
      record.source_type !== "screening" ||
      !record.max_date ||
      record.max_date > date
    )
      throw new Error("Historical input contains newer or unrelated source data");
  });
  if (
    `sha256:${sha256(
      sources
        .map((s) => s.dataHash)
        .sort()
        .join("\n"),
    )}` !== expectedVersion
  )
    throw new Error("Historical complete source-set digest mismatch");
  const targetTiming = selected.flatMap(sourceTimingEvidence).filter((r) => r.max_date === date);
  if (!targetTiming.length) throw new Error("No historical target-date source timing evidence");
  const sourceCollectedAt = targetTiming
    .map((r) => r.activated_at ?? r.created_at ?? "")
    .sort((a, b) => time(a) - time(b))
    .at(-1)!;
  if (
    time(sourceCollectedAt) < time(`${next}T08:00:00+09:00`) ||
    time(sourceCollectedAt) >= time(cutoff)
  )
    throw new Error("No verified pre-open morning refresh for this date");
  if (stableJson(bundle.config) !== stableJson(DEFAULT_SCORING_CONFIG))
    throw new Error("Historical screening config differs from the frozen current scoring config");
  return { selected, sourceCollectedAt, cutoff, manifestHash: digest(sources) };
}
export async function verifyHistoricalBytes(record: SourceRecord, bytes: Uint8Array) {
  if (`sha256:${sha256(Buffer.from(bytes))}` !== record.file_hash)
    throw new Error("Historical stored source byte hash mismatch");
  const gzip = record.canonical_format === "csv.gz" || record.storage_path.endsWith(".gz");
  const logical = gzip ? new Uint8Array(gunzipSync(bytes)) : bytes;
  const validated = await validateSourceBytes({
    bytes: logical,
    filename: record.original_filename,
    contentType: gzip ? "text/csv" : record.content_type,
    streamingCsv: true,
  });
  if (
    !validated.valid ||
    validated.dataHash !== record.data_hash ||
    validated.schemaHash !== record.schema_hash ||
    validated.stats.minDate !== record.min_date ||
    validated.stats.maxDate !== record.max_date ||
    validated.stats.rowCount !== Number(record.row_count)
  )
    throw new Error("Historical logical source validation failed");
  return validated.canonicalCsv;
}
async function allHistoricalRecords(client: SupabaseClient, uid: string): Promise<SourceRecord[]> {
  const { data, error, count } = await client
    .from("analysis_source_files")
    .select("*", { count: "exact" })
    .eq("user_id", uid)
    .eq("source_type", "screening")
    .order("activated_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error || count === null || data?.length !== count)
    throw new Error("Historical source registry incomplete or unavailable");
  return data as SourceRecord[];
}
function evidenceIdentity(session: KospiShadowSession) {
  const { computedAt: _computedAt, ...identity } =
    (session as KospiShadowSession & { lateRecovery?: Record<string, unknown> }).lateRecovery ?? {};
  return identity;
}
function assertPersistedEvidence(stored: KospiShadowSession, proposed: KospiShadowSession) {
  if (stableJson(evidenceIdentity(stored)) !== stableJson(evidenceIdentity(proposed)))
    throw new Error("Persisted retrospective provenance mismatch");
}
async function loadHistoricalSession(
  client: SupabaseClient,
  uid: string,
  date: string,
  computedAt: string,
) {
  const records = await allHistoricalRecords(client, uid);
  const { data: runs, error } = await client
    .from("analysis_runs")
    .select("id,user_id,kind,status,as_of_date,data_version,result_path,created_at,code_version")
    .eq("user_id", uid)
    .eq("kind", "SCREENING")
    .eq("status", "COMPLETED")
    .eq("as_of_date", date)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error || !runs?.length) throw new Error("No completed historical screening evidence");
  let accepted:
    | {
        bundle: HistoricalBundle;
        proof: ReturnType<typeof assertHistoricalManifest>;
        runId: string;
      }
    | undefined;
  for (const run of runs) {
    if (!run.result_path?.startsWith(`${uid}/results/screening/`)) continue;
    const bundle = await downloadJson<HistoricalBundle>(client, run.result_path);
    if (
      `screening-${bundle.run?.id}` !== run.id ||
      (bundle.run.createdAt !== run.created_at &&
        time(bundle.run.createdAt) !== time(run.created_at)) ||
      bundle.run.codeVersion !== run.code_version
    )
      continue;
    try {
      const proof = assertHistoricalManifest(bundle, records, date, run.data_version);
      accepted = { bundle, proof, runId: run.id };
      break;
    } catch {
      /* A newer result may contain post-cutoff input. Never silently use those bytes. */
    }
  }
  if (!accepted) throw new Error(`No exact historical pre-open full-source manifest for ${date}`);
  const { bundle, proof, runId } = accepted;
  if (time(computedAt) < time(proof.cutoff))
    throw new Error("Late recovery is only for a closed decision window");
  const texts: string[] = [];
  for (const record of proof.selected) {
    if (record.user_id !== uid || !record.storage_path.startsWith(`${uid}/source/screening/`))
      throw new Error("Cross-owner historical source path");
    const { data, error } = await client.storage
      .from(ANALYSIS_BUCKET)
      .download(record.storage_path, { cacheNonce: crypto.randomUUID() }, { cache: "no-store" });
    if (error || !data) throw new Error("Historical source download failed");
    texts.push(await verifyHistoricalBytes(record, new Uint8Array(await data.arrayBuffer())));
  }
  const { dataset } = parseManualMarketData(texts);
  if (dataset.asOfDate !== date) throw new Error("Historical merged dataset is not exact-date");
  const config = { policy: KOSPI_SHADOW_POLICY, scoring: DEFAULT_SCORING_CONFIG };
  const session = buildKospiShadowSession(
    dataset,
    DEFAULT_SCORING_CONFIG,
    {
      sourceHash: bundle.run.dataVersion,
      configHash: digest(config),
      codeVersion: codeVersion(),
      sourceCollectedAt: proof.sourceCollectedAt,
      now: computedAt,
    },
    date,
  );
  const recovery = {
    version: "kospi-preopen-late-v1",
    runtimeCodeHash: publicationRuntime.codeHash,
    retrospective: true,
    computedAt,
    dataCutoffAt: proof.cutoff,
    sourceCollectedAt: proof.sourceCollectedAt,
    evidenceRunId: runId,
    evidenceCodeVersion: bundle.run.codeVersion,
    orderedSourceManifestHash: proof.manifestHash,
    sourceCount: proof.selected.length,
  };
  const after = await allHistoricalRecords(client, uid);
  if (digest(historicalRecords(after, proof.cutoff)) !== digest(proof.selected))
    throw new Error("Historical source registry changed during verification");
  return { session: Object.assign(session, { lateRecovery: recovery }), config, recovery };
}
/** Copy-on-write adapter: the full original validation path executes, no remote writes. */
export function memoryOverlay(base: ShadowObjectStore): ShadowObjectStore {
  const values = new Map<string, unknown>();
  return {
    read: async <T>(path: string) =>
      structuredClone(values.has(path) ? values.get(path) : await base.read<T>(path)) as T | null,
    latestSessionDate: async (path) => {
      const dates = [...values.keys()]
        .filter((p) => p.startsWith(`${path}/`))
        .map((p) => p.slice(path.length + 1, -5));
      const remote = await base.latestSessionDate(path);
      if (remote) dates.push(remote);
      return dates.sort().at(-1) ?? null;
    },
    putImmutable: async (path, value) => {
      const old = values.has(path) ? values.get(path) : await base.read(path);
      if (old && stableJson(old) !== stableJson(value))
        throw new Error("Dry-run immutable conflict");
      values.set(path, structuredClone(value));
    },
    putLatest: async (path, value) => {
      values.set(path, structuredClone(value));
    },
  };
}
export async function planLateSessions(
  base: ShadowObjectStore,
  uid: string,
  items: Array<{ session: KospiShadowSession; config: unknown }>,
) {
  const overlay = memoryOverlay(base);
  const revision = await openKospiShadowRevisionStore(overlay, uid);
  const baseline = await revision.read<KospiShadowView>(shadowObjectPath(uid, "latest.json"));
  if (!baseline || baseline.latest.state.lastDate !== baseline.latest.source.date)
    throw new Error("Authoritative predecessor state/date mismatch");
  const summaries = [];
  let previousDate = baseline.latest.source.date;
  for (const item of items) {
    if (
      item.session.date !== previousDate &&
      nextKrRegularSession(previousDate) !== item.session.date
    )
      throw new Error("Recovery requires the exact next session on the KR calendar");
    const existing = await revision.read<{ source: KospiShadowSession }>(
      shadowObjectPath(uid, `sessions/${item.session.date}.json`),
    );
    if (existing) assertPersistedEvidence(existing.source, item.session);
    const result = await persistKospiShadow(revision, uid, item.session, item.config);
    assertPersistedEvidence(result.view.latest.source, item.session);
    previousDate = item.session.date;
    summaries.push({
      date: item.session.date,
      previousSessionDate: item.session.previousSessionDate,
      sourceHash: item.session.sourceHash,
      reused: result.reused,
      stateHash: digest(result.view.latest.state),
      navKrw: result.view.latest.daily.navKrw,
      tradeCount: result.view.latest.trades.length,
      sessionCount: result.view.latest.state.sessions,
    });
  }
  // Full revision history/projection check after all proposed appends.
  await openKospiShadowRevisionStore(overlay, uid);
  const predecessorHash = digest(baseline.latest);
  const planHash = digest({
    version: "kospi-preopen-late-v1",
    predecessorHash,
    summaries,
    sessions: items.map((i) => ({
      date: i.session.date,
      sourceHash: i.session.sourceHash,
      configHash: i.session.configHash,
      runtimeCodeHash: publicationRuntime.codeHash,
      sourceCollectedAt: i.session.sourceCollectedAt,
      evidence: evidenceIdentity(i.session),
    })),
  });
  return { planHash, predecessorHash, predecessorDate: baseline.latest.source.date, summaries };
}
export async function runLateRecovery(
  client: SupabaseClient,
  base: ShadowObjectStore,
  uid: string,
  dates: string[],
  mode: "dry-run" | "apply" | "auto",
  expected?: string,
) {
  if (
    !dates.length ||
    dates.length > 5 ||
    new Set(dates).size !== dates.length ||
    dates.some((d, i) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || (i > 0 && d <= dates[i - 1]!))
  )
    throw new Error("Recovery requires one to five ascending exact session dates");
  if (mode === "apply" && !hashPattern.test(expected ?? ""))
    throw new Error("Apply requires the reviewed dry-run plan hash");
  const computedAt = new Date().toISOString();
  const items = [];
  for (const date of dates) items.push(await loadHistoricalSession(client, uid, date, computedAt));
  const plan = await planLateSessions(base, uid, items);
  if (mode === "apply" && plan.planHash !== expected)
    throw new Error("Recovery plan changed since reviewed dry-run");
  console.log(
    JSON.stringify({
      stage: "KOSPI_LATE_PLAN_VERIFIED",
      mode,
      ...plan,
      evidence: items.map((i) => i.recovery),
    }),
  );
  if (mode === "dry-run") return plan;
  const revision = await openKospiShadowRevisionStore(base, uid);
  const baseline = await revision.read<KospiShadowView>(shadowObjectPath(uid, "latest.json"));
  if (!baseline || digest(baseline.latest) !== plan.predecessorHash)
    throw new Error("Predecessor changed before publication");
  for (const item of items) await persistKospiShadow(revision, uid, item.session, item.config);
  const verified = await openKospiShadowRevisionStore(base, uid);
  const latest = await verified.read<KospiShadowView>(shadowObjectPath(uid, "latest.json"));
  if (
    !latest ||
    latest.latest.source.date !== dates.at(-1) ||
    digest(latest.latest.state) !== plan.summaries.at(-1)!.stateHash
  )
    throw new Error("Late publication readback mismatch");
  assertPersistedEvidence(latest.latest.source, items.at(-1)!.session);
  console.log(
    JSON.stringify({
      stage: "KOSPI_LATE_PUBLICATION_VERIFIED",
      planHash: plan.planHash,
      lastDate: latest.latest.state.lastDate,
      retrospective: true,
      computedAt,
    }),
  );
  return plan;
}
