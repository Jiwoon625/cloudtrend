import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chartReadyPath } from "../src/lib/instrumentChartContract";
import { trustedSupabaseClient } from "./analysis-run-store";
import { loadActiveSources, inputFingerprint } from "../src/lib/screeningSources.server";
import { parseManualMarketDataWithReferences as parseManualMarketData } from "../src/lib/krxReviewReferenceParser";
import { mergeScoringConfig } from "../src/lib/engine/scoring";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import { downloadFreshObject } from "../src/lib/freshStorage";
import { savedOperationalIdentity } from "../src/lib/screeningInputIdentity";
import { loadOperationalIndex } from "../src/lib/operationalUnderlyingIndex.server";
import {
  deterministicAnalysis,
  SCREENING_CACHE_VERSION,
  stableCacheJson,
} from "../src/lib/screeningCacheContract";
import {
  readChartBundle,
  restoreChartContext,
  warmRecentCharts,
} from "../src/lib/instrumentChartStore.server";
/** Repairs only charts for the verified saved generation. Importing this module
 * is inert; publication, screening, Shadow and execution ledgers are not called. */
export async function repairChartCache({
  client,
  uid,
  config: configInput,
  now = new Date().toISOString(),
  stage = () => {},
}: {
  client: SupabaseClient;
  uid: string;
  config?: unknown;
  now?: string;
  stage?: (name: string, detail?: unknown) => void;
}) {
  if (!uid) throw new Error("SUPABASE_USER_ID required");
  const { data: blob, error } = await downloadFreshObject(
    client,
    "cloudtrend-data",
    `${uid}/cache/screening/latest.json`,
  );
  if (error) throw error;
  const saved = JSON.parse(await blob.text()) as {
    version: string;
    inputFingerprint: string;
    resultDigest: string;
    payload: { analysis: AnalysisResult };
  };
  if (saved.version !== SCREENING_CACHE_VERSION || !saved.payload?.analysis)
    throw new Error("Saved screening version or analysis is invalid");
  const metadata = savedOperationalIdentity(saved.payload.analysis);
  if (
    createHash("sha256")
      .update(stableCacheJson(deterministicAnalysis(saved.payload.analysis)))
      .digest("hex") !== saved.resultDigest
  )
    throw new Error("Saved screening result digest differs from its analysis");
  const identity = { inputFingerprint: saved.inputFingerprint, resultDigest: saved.resultDigest };
  // Validate the identity even when a ready marker would otherwise short-circuit repair.
  const scoredReadyPath = chartReadyPath(identity, "scored");
  const etfReadyPath = chartReadyPath(identity, "etf");
  stage("saved-result");
  const { sources, texts } = await loadActiveSources(client, uid);
  stage("sources-loaded", { count: sources.length });
  const config = mergeScoringConfig(configInput);
  if (inputFingerprint(sources, config, metadata) !== saved.inputFingerprint)
    throw new Error(
      "Current source/config fingerprint differs from saved screening; supply its original --config JSON if non-default",
    );
  if (
    (await readChartBundle(client, uid, scoredReadyPath)) &&
    (await readChartBundle(client, uid, etfReadyPath))
  ) {
    stage("already-ready");
    return { reused: true, ...identity };
  }
  const parsed = parseManualMarketData(texts);
  if (parsed.dataset.asOfDate !== saved.payload.analysis.asOfDate)
    throw new Error("Current dataset date differs from saved screening");
  stage("parsed");
  // Saved identity intentionally selects the pinned reader during rollout rollback.
  // A legacy publication must never acquire today's optional provider during repair.
  const operationalIndex = metadata
    ? await loadOperationalIndex(client, uid, parsed.dataset, now, false, metadata)
    : undefined;
  if (
    metadata &&
    (!operationalIndex ||
      operationalIndex.version !== metadata.version ||
      operationalIndex.artifactSha256 !== metadata.artifactSha256 ||
      operationalIndex.asOfDate !== metadata.asOfDate ||
      operationalIndex.availableFrom !== metadata.availableFrom)
  )
    throw new Error("Saved screening and restored MA60 provider identity differ");
  const ctx = restoreChartContext(
    parsed.dataset,
    saved.payload.analysis,
    config,
    saved.resultDigest,
    operationalIndex,
  );
  stage("context-restored");
  await warmRecentCharts(client, uid, identity, ctx);
  stage("charts-ready");
  const { data: objects, error: listError } = await client.storage
    .from("cloudtrend-data")
    .list(`${uid}/${scoredReadyPath.slice(0, scoredReadyPath.lastIndexOf("/"))}`, { limit: 200 });
  if (listError) throw listError;
  stage("storage-verified", {
    files: objects?.length,
    ready: objects?.some((o) => o.name === "scored-ready.json.gz"),
  });
  stage("etf-storage-verified", {
    ready: !!(await readChartBundle(client, uid, etfReadyPath)),
  });
  return { reused: false, ...identity };
}

export function repairConfigPath(args: string[]): string | undefined {
  if (!args.length) return undefined;
  if (args.length !== 2 || args[0] !== "--config" || !args[1] || args[1].startsWith("--"))
    throw new Error("Usage: repair-chart-cache.ts [--config original-scoring-config.json]");
  return args[1];
}

async function main() {
  const configPath = repairConfigPath(process.argv.slice(2));
  const config = configPath ? JSON.parse(await readFile(configPath, "utf8")) : undefined;
  const start = Date.now();
  console.log("Starting chart cache diagnosis");
  await repairChartCache({
    client: trustedSupabaseClient(),
    uid: process.env["SUPABASE_USER_ID"] ?? "",
    config,
    stage: (name, detail = {}) =>
      console.log(JSON.stringify({ stage: name, ms: Date.now() - start, detail })),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
