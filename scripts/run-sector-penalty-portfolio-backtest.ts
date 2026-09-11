import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { runSectorPenaltyPortfolioBacktest, SECTOR_PENALTY_PORTFOLIO_VERSION } from "../src/lib/engine/sectorPenaltyPortfolioBacktest";
import {
  buildPortfolioSignalContext,
  createPortfolioFeatureCache,
  PORTFOLIO_FEATURE_CACHE_VERSION,
  type PortfolioFeatureCache,
} from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import { ANALYSIS_BUCKET, codeVersion, downloadJson, sha256, stableJson, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

interface Options {
  supabaseUserId: string | null;
  outputRoot: string;
  upload: boolean;
  limit: number;
  initialCapital: number;
}

interface ProfileStep {
  name: string;
  elapsedMs: number;
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  externalMb: number;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npx vite-node scripts/run-sector-penalty-portfolio-backtest.ts --supabase-user-id <uuid> [--upload]",
    "Options:",
    "  --output <dir>             default: v8-sector-penalty-portfolio-runs",
    "  --limit <count>            default: 613",
    "  --initial-capital <won>    default: 100000000",
    "Supabase mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = { supabaseUserId: null, outputRoot: "v8-sector-penalty-portfolio-runs", upload: false, limit: 613, initialCapital: 100_000_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--supabase-user-id") options.supabaseUserId = argv[++i] ?? usage();
    else if (arg === "--output") options.outputRoot = argv[++i] ?? usage();
    else if (arg === "--upload") options.upload = true;
    else if (arg === "--limit") options.limit = Number(argv[++i] ?? usage());
    else if (arg === "--initial-capital") options.initialCapital = Number(argv[++i] ?? usage());
    else usage();
  }
  if (!options.supabaseUserId) usage();
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 2000) throw new Error("limit은 1~2000 정수여야 합니다.");
  if (!Number.isFinite(options.initialCapital) || options.initialCapital <= 0) throw new Error("initial-capital은 양수여야 합니다.");
  return options;
}

function memorySnapshot() {
  const m = process.memoryUsage(), mb = (value: number) => Math.round(value / 1024 / 1024 * 100) / 100;
  return { heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), rssMb: mb(m.rss), externalMb: mb(m.external) };
}

function recordStep(steps: ProfileStep[], name: string, startedAt: number) {
  steps.push({ name, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100, ...memorySnapshot() });
}

async function measured<T>(steps: ProfileStep[], name: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = performance.now(); const value = await fn(); recordStep(steps, name, startedAt); return value;
}

function measuredSync<T>(steps: ProfileStep[], name: string, fn: () => T): T {
  const startedAt = performance.now(); const value = fn(); recordStep(steps, name, startedAt); return value;
}

async function maybeDownloadFeatureCache(client: ReturnType<typeof trustedSupabaseClient>, objectPath: string) {
  try { return await downloadJson<PortfolioFeatureCache>(client, objectPath); }
  catch (error) { if (error instanceof Error && /Object not found|not_found|404/i.test(error.message)) return null; throw error; }
}

async function uploadCompactJson(client: ReturnType<typeof trustedSupabaseClient>, objectPath: string, value: unknown) {
  const body = JSON.stringify(value);
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(objectPath, body, { contentType: "application/json", upsert: true });
  if (error) throw new Error(`Supabase 업로드 실패 (${objectPath}): ${error.message}`);
  return body.length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2)), steps: ProfileStep[] = [], totalStartedAt = performance.now();
  const client = trustedSupabaseClient();
  const inputs = await measured(steps, "load_source_inputs", () => loadAnalysisSourceInputs(client, options.supabaseUserId!, "backtest"));
  const parsed = measuredSync(steps, "parse_dataset", () => parseManualMarketData(inputs.map((input) => input.text)));
  const sourceFingerprint = sha256(stableJson({
    featureVersion: PORTFOLIO_FEATURE_CACHE_VERSION,
    limit: options.limit,
    sources: inputs.map((input) => ({ dataHash: input.dataHash, schemaHash: input.schemaHash })).sort((a, b) => `${a.dataHash}:${a.schemaHash}`.localeCompare(`${b.dataHash}:${b.schemaHash}`)),
  }));
  const featureCachePath = `${options.supabaseUserId}/results/cache/sector-v8-portfolio/${PORTFOLIO_FEATURE_CACHE_VERSION}/l${options.limit}-${sourceFingerprint.slice(0, 24)}.json`;
  const featureCache = await measured(steps, "load_feature_cache", () => maybeDownloadFeatureCache(client, featureCachePath));
  const signalContext = measuredSync(steps, "build_signal_context", () => buildPortfolioSignalContext(parsed.dataset, options.limit, featureCache));
  let featureCacheBytes: number | null = null;
  if (!signalContext.featureCacheUsed && options.upload) {
    const cache = measuredSync(steps, "serialize_feature_cache", () => createPortfolioFeatureCache(signalContext, parsed.dataset, options.limit));
    featureCacheBytes = await measured(steps, "persist_feature_cache", () => uploadCompactJson(client, featureCachePath, cache));
  }
  const result = measuredSync(steps, "portfolio_backtest", () => runSectorPenaltyPortfolioBacktest(parsed.dataset, {
    limit: options.limit,
    initialCapital: options.initialCapital,
    roundTripCostBps: [0, 15, 30],
    maxPositions: [5, 10, 20],
    weightModes: ["EQUAL_WEIGHT", "MAX_20", "MAX_10"],
    signalContext,
  }));
  if (!result) throw new Error("V8 섹터 과열 포트폴리오 백테스트 결과를 계산하지 못했습니다.");

  const createdAt = new Date().toISOString(), runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const profile = {
    totalElapsedMsBeforeWrite: Math.round((performance.now() - totalStartedAt) * 100) / 100,
    peakRssMb: Math.max(0, ...steps.map((step) => step.rssMb)),
    peakHeapUsedMb: Math.max(0, ...steps.map((step) => step.heapUsedMb)),
    steps,
  };
  const payload = {
    schemaVersion: 2,
    run: {
      id: runId,
      createdAt,
      engineVersion: SECTOR_PENALTY_PORTFOLIO_VERSION,
      codeVersion: codeVersion(),
      datasetVersion: parsed.dataset.version,
      asOfDate: parsed.dataset.asOfDate,
      limit: options.limit,
      initialCapital: options.initialCapital,
      roundTripCostBps: [0, 15, 30],
      maxPositions: [5, 10, 20],
      weightModes: ["EQUAL_WEIGHT", "MAX_20", "MAX_10"],
    },
    featureCache: { version: PORTFOLIO_FEATURE_CACHE_VERSION, used: signalContext.featureCacheUsed, path: featureCachePath, fingerprint: sourceFingerprint, uploadedBytes: featureCacheBytes },
    profile,
    sourceFiles: inputs.map((input) => ({ id: input.id, fileName: input.fileName, bytes: input.bytes, savedAt: input.savedAt, dataHash: input.dataHash, schemaHash: input.schemaHash })),
    result,
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await measured(steps, "write_result", () => writeFile(path.join(outputDir, "sector-penalty-portfolio-backtest.json"), JSON.stringify(payload, null, 2)));

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/sector-v8-penalty-portfolio/latest.json`;
    await measured(steps, "upload_result", () => uploadJson(client, remotePath!, payload));
  }

  process.stdout.write(`${JSON.stringify({
    outputDir,
    remotePath,
    featureCache: payload.featureCache,
    profile: { ...profile, totalElapsedMs: Math.round((performance.now() - totalStartedAt) * 100) / 100, finalMemory: memorySnapshot() },
    run: payload.run,
    summary: {
      metadata: result.metadata,
      optimizationStats: result.optimizationStats,
      scenarioDefinitions: result.scenarioDefinitions,
      portfolioAssumptions: result.portfolioAssumptions,
      bestRows: result.bestRows,
      rowCount: result.rows.length,
    },
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
