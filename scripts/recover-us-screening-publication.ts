/** Re-publish a completed immutable result. Never import or invoke a model/replay runner. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { ANALYSIS_BUCKET, sha256, stableJson, trustedSupabaseClient } from "./analysis-run-store";
import { publishBrowserViews } from "./us-screening-publication";
import { usBrowserViews } from "../src/lib/usBrowserViews";
import type { UsProspectiveCache } from "../src/lib/usProspectiveCloud";

type Client = ReturnType<typeof trustedSupabaseClient>;
export interface PublicationRecoveryRequest {
  version: "us-publication-only-recovery-v1";
  date: string;
  dataHash: string;
  ruleVersion: string;
  expectedRows: number;
}
export function assertPublicationRecoveryRequest(
  value: unknown,
): asserts value is PublicationRecoveryRequest {
  const r = value as PublicationRecoveryRequest;
  if (
    !r ||
    Object.keys(r).sort().join(",") !== "dataHash,date,expectedRows,ruleVersion,version" ||
    r.version !== "us-publication-only-recovery-v1" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
    !/^sha256:[a-f0-9]{64}$/.test(r.dataHash) ||
    !r.ruleVersion ||
    !Number.isSafeInteger(r.expectedRows) ||
    r.expectedRows < 1
  )
    throw new Error("Invalid bounded publication recovery request");
}
async function download(client: Client, path: string) {
  const { data, error } = await client.storage
    .from(ANALYSIS_BUCKET)
    .download(path, { cacheNonce: crypto.randomUUID() }, { cache: "no-store" });
  if (error || !data) throw new Error("Publication recovery artifact read failed");
  return Buffer.from(await data.arrayBuffer());
}
async function admission(client: Client, uid: string, r: PublicationRecoveryRequest) {
  const { data: ingest, error: ingestError } = await client
    .from("us_screening_ingest")
    .select("as_of_date,data_hash,storage_bucket")
    .eq("user_id", uid)
    .single();
  const { data: history, error: historyError } = await client
    .from("us_screening_history")
    .select("date,data_hash,rule_version,created_at")
    .eq("user_id", uid)
    .order("date", { ascending: false })
    .limit(1)
    .single();
  if (
    ingestError ||
    historyError ||
    !ingest ||
    !history ||
    ingest.as_of_date !== r.date ||
    ingest.data_hash !== r.dataHash ||
    ingest.storage_bucket !== ANALYSIS_BUCKET ||
    history.date !== r.date ||
    history.data_hash !== r.dataHash ||
    history.rule_version !== r.ruleVersion
  )
    throw new Error("Publication recovery requires the exact latest completed date/hash/rule");
  return history;
}
export async function recoverUsScreeningPublication(
  client: Client,
  uid: string,
  request: PublicationRecoveryRequest,
) {
  assertPublicationRecoveryRequest(request);
  if (!uid || uid.includes("/")) throw new Error("Invalid publication owner");
  const beforeHistory = await admission(client, uid, request);
  const resultPath = `${uid}/results/us-screening/${request.date}.json`;
  const originalBytes = await download(client, resultPath);
  const result = JSON.parse(originalBytes.toString("utf8")) as UsProspectiveCache;
  if (
    result.dataHash !== request.dataHash ||
    result.analysis?.date !== request.date ||
    result.analysis.ruleVersion !== request.ruleVersion ||
    result.analysis.rows.length !== request.expectedRows ||
    result.analysis.rows.some((row) => row.date !== request.date) ||
    new Set(result.analysis.rows.map((row) => row.symbol)).size !== request.expectedRows
  )
    throw new Error("Immutable result identity or universe differs from recovery request");
  // A later or reviewed replacement must never be rolled back by this repair.
  const latestPath = `${uid}/cache/us-screening/latest.json`;
  const latestBytes = await download(client, latestPath);
  if (stableJson(JSON.parse(latestBytes.toString("utf8"))) !== stableJson(result))
    throw new Error(
      "Current latest differs from the immutable result; publication-only recovery is held",
    );
  await admission(client, uid, request);
  if (sha256(await download(client, resultPath)) !== sha256(originalBytes))
    throw new Error("Immutable result changed before publication");
  await publishBrowserViews(client, uid, result);
  const views = usBrowserViews(result);
  const actualView = JSON.parse(
    gunzipSync(await download(client, `${uid}/cache/us-screening/view-v1.json.gz`)).toString(
      "utf8",
    ),
  );
  const actualSummary = JSON.parse(
    (await download(client, `${uid}/cache/us-screening/summary-v1.json`)).toString("utf8"),
  );
  if (
    stableJson(actualView) !== stableJson(views.screening) ||
    stableJson(actualSummary) !== stableJson(views.summary)
  )
    throw new Error("Published browser view or summary differs from the immutable result");
  if (
    stableJson(await admission(client, uid, request)) !== stableJson(beforeHistory) ||
    sha256(await download(client, resultPath)) !== sha256(originalBytes) ||
    sha256(await download(client, latestPath)) !== sha256(latestBytes)
  )
    throw new Error("Protected result/history/latest changed during publication recovery");
  return {
    ok: true,
    date: request.date,
    dataHash: request.dataHash,
    ruleVersion: request.ruleVersion,
    rows: request.expectedRows,
    immutableResultHash: `sha256:${sha256(originalBytes)}`,
    archiveVerified: true,
    browserViewVerified: true,
    summaryVerified: true,
    protectedResultHistoryLatestUnchanged: true,
  };
}
async function main() {
  if (
    process.env["GITHUB_ACTIONS"] !== "true" ||
    process.env["GITHUB_REF"] !== "refs/heads/main" ||
    process.env["GITHUB_WORKFLOW"] !== "US publication-only recovery" ||
    process.env["GITHUB_EVENT_NAME"] !== "push"
  )
    throw new Error("Publication recovery must use the serialized main-branch recovery workflow");
  const requestPath = process.argv[process.argv.indexOf("--request") + 1];
  if (!process.argv.includes("--apply") || !process.argv.includes("--request") || !requestPath)
    throw new Error("Explicit request file and --apply are required");
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  assertPublicationRecoveryRequest(request);
  if (
    request.date !== "2026-10-19" ||
    request.dataHash !==
      "sha256:e0eea4c6e2736a345e4735a727917a6eaef7f861649720b1e268df061d0af845" ||
    request.ruleVersion !== "us-prospective-1.1.0-a0-anchor" ||
    request.expectedRows !== 5347
  )
    throw new Error("Request differs from the specifically approved October 19 recovery");
  const uid = process.env["SUPABASE_USER_ID"];
  if (!uid) throw new Error("Missing publication owner");
  console.log(
    JSON.stringify(await recoverUsScreeningPublication(trustedSupabaseClient(), uid, request)),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      `Publication-only recovery stopped: ${sha256(error instanceof Error ? error.message : "unknown").slice(0, 12)}`,
    );
    process.exitCode = 1;
  });
