import process from "node:process";
import { trustedSupabaseClient } from "./analysis-run-store";

const userId = process.env["SUPABASE_USER_ID"];
if (!userId) throw new Error("Missing SUPABASE_USER_ID");

const client = trustedSupabaseClient();
const latestPath = userId + "/results/v8-current-strategy-overshoot-entry-ab/latest.json";
const { data: latestBlob, error: latestError } = await client.storage
  .from("cloudtrend-data")
  .download(latestPath);
if (latestError || !latestBlob) throw latestError ?? new Error("Latest overshoot result not found");

const latest = JSON.parse(await latestBlob.text()) as {
  version: string;
  createdAt: string;
  runId: string;
  resultPath: string;
};

const { data: fullBlob, error: fullError } = await client.storage
  .from("cloudtrend-data")
  .download(latest.resultPath);
if (fullError || !fullBlob) throw fullError ?? new Error("Full overshoot result not found");

const result = JSON.parse(await fullBlob.text()) as {
  version: string;
  createdAt: string;
  runId: string;
  data?: { datasetVersion?: string; asOfDate?: string };
  design?: unknown;
  aggregateRows?: unknown;
  comparisonRows?: unknown;
  signalDiagnostics?: unknown;
  foldRows?: unknown;
};

const id = "research-overshoot-entry-ab-20260921";
const completedAt = new Date().toISOString();
const row = {
  id,
  user_id: userId,
  kind: "BACKTEST",
  status: "COMPLETED",
  run_key: "overshoot-entry-ab-" + result.runId,
  requested_by: "research/overshoot-entry-ab-20260921",
  code_version: process.env["GITHUB_SHA"] ?? "unknown",
  data_version: result.data?.datasetVersion ?? "unknown",
  config: result.design ?? {},
  summary: {
    version: result.version,
    createdAt: result.createdAt,
    runId: result.runId,
    aggregateRows: result.aggregateRows ?? [],
    comparisonRows: result.comparisonRows ?? [],
    signalDiagnostics: result.signalDiagnostics ?? [],
    foldRows: result.foldRows ?? [],
  },
  as_of_date: result.data?.asOfDate ?? null,
  result_path: latest.resultPath,
  completed_at: completedAt,
  error: null,
};

const { error: upsertError } = await client
  .from("analysis_runs")
  .upsert(row, { onConflict: "id" });
if (upsertError) throw upsertError;

process.stdout.write(JSON.stringify({ id, resultPath: latest.resultPath, runId: result.runId }) + "\n");
