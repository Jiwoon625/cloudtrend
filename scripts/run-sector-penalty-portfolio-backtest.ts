import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { MarketDataset } from "../src/lib/engine/dataset";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  runSectorPenaltyPortfolioBacktest,
  SECTOR_PENALTY_PORTFOLIO_VERSION,
  type SectorPenaltyPortfolioBacktestResult,
} from "../src/lib/engine/sectorPenaltyPortfolioBacktest";
import {
  buildPortfolioSignalContext,
  createPortfolioFeatureCache,
  PORTFOLIO_FEATURE_CACHE_VERSION,
  PORTFOLIO_STRATEGIES,
  type PortfolioFeatureCache,
} from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import { ANALYSIS_BUCKET, codeVersion, downloadJson, sha256, stableJson, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import {
  buildBacktestSourceManifest,
  createPortfolioRuntimeCache,
  maybeDownloadPortfolioRuntimeCache,
  PORTFOLIO_RUNTIME_CACHE_VERSION,
  runtimeSourceFiles,
  uploadPortfolioRuntimeCache,
  type RuntimeSourceFile,
} from "./sector-penalty-runtime-cache";
import { loadAnalysisSourceInputs } from "./source-registry-store";

const ROUND_TRIP_COST_BPS = [0, 15, 30] as const;
const MAX_POSITIONS = [5, 10, 20] as const;
const WEIGHT_MODES = ["EQUAL_WEIGHT", "MAX_20", "MAX_10"] as const;
const REGRESSION_GUARD_VERSION = "sector-v8-regression-v1" as const;

interface Options { supabaseUserId: string | null; outputRoot: string; upload: boolean; limit: number; initialCapital: number; allowResultChange: boolean; }
interface ProfileStep { name: string; elapsedMs: number; heapUsedMb: number; heapTotalMb: number; rssMb: number; externalMb: number; }
interface RegressionBaseline { version: typeof REGRESSION_GUARD_VERSION; sourceFingerprint: string; configFingerprint: string; resultDigest: string; createdAt: string; codeVersion: string; }
interface PreviousPayload {
  run?: { id?: string; limit?: number; initialCapital?: number; roundTripCostBps?: number[]; maxPositions?: number[]; weightModes?: string[]; };
  sourceFiles?: RuntimeSourceFile[];
  result?: SectorPenaltyPortfolioBacktestResult;
}

function usage(): never {
  throw new Error(["Usage:", "  npx vite-node scripts/run-sector-penalty-portfolio-backtest.ts --supabase-user-id <uuid> [--upload]", "Options:", "  --output <dir>             default: v8-sector-penalty-portfolio-runs", "  --limit <count>            default: 613", "  --initial-capital <won>    default: 100000000", "  --allow-result-change      같은 원천/설정의 regression baseline 변경을 명시적으로 허용", "Supabase mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = { supabaseUserId: null, outputRoot: "v8-sector-penalty-portfolio-runs", upload: false, limit: 613, initialCapital: 100_000_000, allowResultChange: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--supabase-user-id") options.supabaseUserId = argv[++i] ?? usage();
    else if (arg === "--output") options.outputRoot = argv[++i] ?? usage();
    else if (arg === "--upload") options.upload = true;
    else if (arg === "--limit") options.limit = Number(argv[++i] ?? usage());
    else if (arg === "--initial-capital") options.initialCapital = Number(argv[++i] ?? usage());
    else if (arg === "--allow-result-change") options.allowResultChange = true;
    else usage();
  }
  if (!options.supabaseUserId) usage();
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 2000) throw new Error("limit은 1~2000 정수여야 합니다.");
  if (!Number.isFinite(options.initialCapital) || options.initialCapital <= 0) throw new Error("initial-capital은 양수여야 합니다.");
  return options;
}

function memorySnapshot() { const m = process.memoryUsage(), mb = (value: number) => Math.round(value / 1024 / 1024 * 100) / 100; return { heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), rssMb: mb(m.rss), externalMb: mb(m.external) }; }
function recordStep(steps: ProfileStep[], name: string, startedAt: number) { steps.push({ name, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100, ...memorySnapshot() }); }
async function measured<T>(steps: ProfileStep[], name: string, fn: () => Promise<T>): Promise<T> { const startedAt = performance.now(); const value = await fn(); recordStep(steps, name, startedAt); return value; }
function measuredSync<T>(steps: ProfileStep[], name: string, fn: () => T): T { const startedAt = performance.now(); const value = fn(); recordStep(steps, name, startedAt); return value; }

async function maybeDownloadJson<T>(client: ReturnType<typeof trustedSupabaseClient>, objectPath: string): Promise<T | null> {
  try { return await downloadJson<T>(client, objectPath); }
  catch (error) { if (error instanceof Error && /Object not found|not_found|404/i.test(error.message)) return null; throw error; }
}

async function uploadCompactJson(client: ReturnType<typeof trustedSupabaseClient>, objectPath: string, value: unknown) {
  const body = JSON.stringify(value); const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(objectPath, body, { contentType: "application/json", upsert: true });
  if (error) throw new Error(`Supabase 업로드 실패 (${objectPath}): ${error.message}`); return body.length;
}

function sourceFingerprintFor(files: RuntimeSourceFile[], limit: number) {
  return sha256(stableJson({ featureVersion: PORTFOLIO_FEATURE_CACHE_VERSION, limit, sources: files.map((file) => ({ dataHash: file.dataHash, schemaHash: file.schemaHash })).sort((a, b) => `${a.dataHash}:${a.schemaHash}`.localeCompare(`${b.dataHash}:${b.schemaHash}`)) }));
}

function configFingerprint(options: Options) {
  return sha256(stableJson({ engineVersion: SECTOR_PENALTY_PORTFOLIO_VERSION, limit: options.limit, initialCapital: options.initialCapital, roundTripCostBps: ROUND_TRIP_COST_BPS, maxPositions: MAX_POSITIONS, weightModes: WEIGHT_MODES, scenarioDefinitions: PORTFOLIO_STRATEGIES }));
}

/** optimizationStats는 cache hit 여부에 따라 달라지므로 계산결과 회귀 digest에서는 제외한다. */
function coreResultDigest(result: SectorPenaltyPortfolioBacktestResult) { const { optimizationStats: _optimizationStats, ...deterministicResult } = result; return sha256(stableJson(deterministicResult)); }

function previousPayloadSourceFingerprint(payload: PreviousPayload) {
  const limit = payload.run?.limit, files = payload.sourceFiles;
  if (!Number.isInteger(limit) || !files?.length || files.some((file) => !file.dataHash || !file.schemaHash)) return null;
  return sourceFingerprintFor(files, limit!);
}

function previousPayloadConfigFingerprint(payload: PreviousPayload) {
  const run = payload.run, scenarios = payload.result?.scenarioDefinitions;
  if (!run || !scenarios || !Number.isInteger(run.limit) || !Number.isFinite(run.initialCapital)) return null;
  return sha256(stableJson({ engineVersion: payload.result?.version, limit: run.limit, initialCapital: run.initialCapital, roundTripCostBps: run.roundTripCostBps, maxPositions: run.maxPositions, weightModes: run.weightModes, scenarioDefinitions: scenarios }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2)), steps: ProfileStep[] = [], totalStartedAt = performance.now();
  const client = trustedSupabaseClient(), userId = options.supabaseUserId!;

  const manifest = await measured(steps, "build_source_manifest", () => buildBacktestSourceManifest(client, userId, options.limit));
  const runtimeCachePath = `${userId}/results/cache/sector-v8-portfolio/${PORTFOLIO_RUNTIME_CACHE_VERSION}/l${options.limit}-${manifest.fingerprint.slice(0, 24)}.json.gz`;
  const runtimeDownload = await measured(steps, "load_runtime_cache", () => maybeDownloadPortfolioRuntimeCache(client, runtimeCachePath, manifest.fingerprint, options.limit));

  let dataset: MarketDataset, sourceFiles: RuntimeSourceFile[];
  let runtimeCacheUsed = false;
  let runtimeCacheUpload: { uncompressedBytes: number; compressedBytes: number } | null = null;
  if (runtimeDownload.cache) {
    dataset = runtimeDownload.cache.dataset; sourceFiles = runtimeDownload.cache.sourceFiles; runtimeCacheUsed = true;
  } else {
    const inputs = await measured(steps, "load_source_inputs", () => loadAnalysisSourceInputs(client, userId, "backtest"));
    const parsed = measuredSync(steps, "parse_dataset", () => parseManualMarketData(inputs.map((input) => input.text)));
    dataset = parsed.dataset; sourceFiles = runtimeSourceFiles(inputs);
    if (options.upload) {
      const cache = measuredSync(steps, "serialize_runtime_cache", () => createPortfolioRuntimeCache({ manifestFingerprint: manifest.fingerprint, limit: options.limit, sourceFiles, dataset }));
      runtimeCacheUpload = await measured(steps, "persist_runtime_cache", () => uploadPortfolioRuntimeCache(client, runtimeCachePath, cache));
    }
  }

  const sourceFingerprint = sourceFingerprintFor(sourceFiles, options.limit);
  const featureCachePath = `${userId}/results/cache/sector-v8-portfolio/${PORTFOLIO_FEATURE_CACHE_VERSION}/l${options.limit}-${sourceFingerprint.slice(0, 24)}.json`;
  const featureCache = await measured(steps, "load_feature_cache", () => maybeDownloadJson<PortfolioFeatureCache>(client, featureCachePath));
  const signalContext = measuredSync(steps, "build_signal_context", () => buildPortfolioSignalContext(dataset, options.limit, featureCache));
  let featureCacheBytes: number | null = null;
  if (!signalContext.featureCacheUsed && options.upload) {
    const cache = measuredSync(steps, "serialize_feature_cache", () => createPortfolioFeatureCache(signalContext, dataset, options.limit));
    featureCacheBytes = await measured(steps, "persist_feature_cache", () => uploadCompactJson(client, featureCachePath, cache));
  }

  const currentConfigFingerprint = configFingerprint(options);
  const regressionPath = `${userId}/results/cache/sector-v8-portfolio/${REGRESSION_GUARD_VERSION}/l${options.limit}-${sourceFingerprint.slice(0, 16)}-${currentConfigFingerprint.slice(0, 16)}.json`;
  let regressionBaseline = await measured(steps, "load_regression_baseline", () => maybeDownloadJson<RegressionBaseline>(client, regressionPath));
  let regressionBaselineSource: "BASELINE" | "LATEST" | "NONE" = regressionBaseline ? "BASELINE" : "NONE";
  let previousRunId: string | null = null;
  if (!regressionBaseline) {
    const previous = await measured(steps, "load_previous_latest_for_regression", () => maybeDownloadJson<PreviousPayload>(client, `${userId}/results/sector-v8-penalty-portfolio/latest.json`));
    if (previous?.result && previousPayloadSourceFingerprint(previous) === sourceFingerprint && previousPayloadConfigFingerprint(previous) === currentConfigFingerprint) {
      regressionBaseline = { version: REGRESSION_GUARD_VERSION, sourceFingerprint, configFingerprint: currentConfigFingerprint, resultDigest: coreResultDigest(previous.result), createdAt: new Date().toISOString(), codeVersion: previous.run?.id ?? "previous-latest" };
      regressionBaselineSource = "LATEST"; previousRunId = previous.run?.id ?? null;
    }
  }

  const result = measuredSync(steps, "portfolio_backtest", () => runSectorPenaltyPortfolioBacktest(dataset, { limit: options.limit, initialCapital: options.initialCapital, roundTripCostBps: [...ROUND_TRIP_COST_BPS], maxPositions: [...MAX_POSITIONS], weightModes: [...WEIGHT_MODES], signalContext }));
  if (!result) throw new Error("V8 섹터 과열 포트폴리오 백테스트 결과를 계산하지 못했습니다.");
  const resultDigest = measuredSync(steps, "result_digest", () => coreResultDigest(result));
  const expectedDigest = regressionBaseline?.resultDigest ?? null, regressionMatched = expectedDigest === null || expectedDigest === resultDigest;
  if (!regressionMatched && !options.allowResultChange) throw new Error(`V8 regression guard 실패: 같은 원천/전략 설정인데 결과 digest가 변경되었습니다. expected=${expectedDigest}, actual=${resultDigest}. 의도적인 산식 변경이면 --allow-result-change를 사용하세요.`);

  if (options.upload && (!regressionBaseline || (!regressionMatched && options.allowResultChange))) {
    regressionBaseline = { version: REGRESSION_GUARD_VERSION, sourceFingerprint, configFingerprint: currentConfigFingerprint, resultDigest, createdAt: new Date().toISOString(), codeVersion: codeVersion() };
    await measured(steps, "persist_regression_baseline", () => uploadCompactJson(client, regressionPath, regressionBaseline));
  } else if (options.upload && regressionBaselineSource === "LATEST" && regressionMatched) {
    await measured(steps, "persist_regression_baseline", () => uploadCompactJson(client, regressionPath, regressionBaseline));
  }

  const createdAt = new Date().toISOString(), runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const profile = { totalElapsedMsBeforeWrite: Math.round((performance.now() - totalStartedAt) * 100) / 100, peakRssMb: Math.max(0, ...steps.map((step) => step.rssMb)), peakHeapUsedMb: Math.max(0, ...steps.map((step) => step.heapUsedMb)), steps };
  const payload = {
    schemaVersion: 3,
    run: { id: runId, createdAt, engineVersion: SECTOR_PENALTY_PORTFOLIO_VERSION, codeVersion: codeVersion(), datasetVersion: dataset.version, asOfDate: dataset.asOfDate, limit: options.limit, initialCapital: options.initialCapital, roundTripCostBps: [...ROUND_TRIP_COST_BPS], maxPositions: [...MAX_POSITIONS], weightModes: [...WEIGHT_MODES] },
    runtimeCache: { version: PORTFOLIO_RUNTIME_CACHE_VERSION, used: runtimeCacheUsed, path: runtimeCachePath, manifestFingerprint: manifest.fingerprint, manifestRegisteredCount: manifest.registeredCount, manifestLegacyObjectCount: manifest.legacyObjectCount, downloadedBytes: runtimeDownload.compressedBytes, uploadedBytes: runtimeCacheUpload?.compressedBytes ?? null, uncompressedBytes: runtimeCacheUpload?.uncompressedBytes ?? null },
    featureCache: { version: PORTFOLIO_FEATURE_CACHE_VERSION, used: signalContext.featureCacheUsed, path: featureCachePath, fingerprint: sourceFingerprint, uploadedBytes: featureCacheBytes },
    regressionGuard: { version: REGRESSION_GUARD_VERSION, path: regressionPath, baselineSource: regressionBaselineSource, previousRunId, checked: expectedDigest !== null, expectedDigest, resultDigest, matched: regressionMatched, overrideAllowed: options.allowResultChange },
    profile, sourceFiles, result,
  };

  const outputDir = path.resolve(options.outputRoot, runId); await mkdir(outputDir, { recursive: true });
  await measured(steps, "write_result", () => writeFile(path.join(outputDir, "sector-penalty-portfolio-backtest.json"), JSON.stringify(payload, null, 2)));
  let remotePath: string | null = null;
  if (options.upload) { remotePath = `${userId}/results/sector-v8-penalty-portfolio/latest.json`; await measured(steps, "upload_result", () => uploadJson(client, remotePath!, payload)); }

  process.stdout.write(`${JSON.stringify({ outputDir, remotePath, runtimeCache: payload.runtimeCache, featureCache: payload.featureCache, regressionGuard: payload.regressionGuard, profile: { ...profile, totalElapsedMs: Math.round((performance.now() - totalStartedAt) * 100) / 100, finalMemory: memorySnapshot() }, run: payload.run, summary: { metadata: result.metadata, optimizationStats: result.optimizationStats, scenarioDefinitions: result.scenarioDefinitions, portfolioAssumptions: result.portfolioAssumptions, bestRows: result.bestRows, rowCount: result.rows.length } }, null, 2)}\n`);
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
