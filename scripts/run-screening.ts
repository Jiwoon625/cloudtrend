import { hashSeriesValue, MODEL_ACCOUNTING_START } from "../src/lib/ledger/modelSeries";
import { isKrOfficialShadowDecision } from "../src/lib/ledger/krShadowDecision";
import {
  octoberShadowAlreadyRecorded,
  publishOctoberShadow,
  sourceSeriesHash,
} from "./october-shadow-publication";
import { memory } from "./screening-memory";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { buildScreeningSummary } from "../src/lib/analysisRunBundle";
import { withOnsetProfiles } from "../src/lib/onsetProfile";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  DEFAULT_SCORING_CONFIG,
  mergeScoringConfig,
  type ScoringConfig,
} from "../src/lib/engine/scoring";
import { ADDITIONAL_STOCK_SECTOR_COUNT } from "../src/lib/engine/additionalStockSectorMaster";
import { REVIEWED_STOCK_SECTOR_COUNT } from "../src/lib/engine/stockSectorMaster";
import {
  latestSourceRegistration,
  buildSnapshot,
  persistScreeningSnapshot,
  type ScreeningSnapshot,
} from "../src/lib/screeningSnapshot";
import {
  analysisRunKey,
  codeVersion,
  findReusableRun,
  requestedBy,
  saveRunRecord,
  sha256,
  trustedSupabaseClient,
  uploadJson,
} from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";
import { publishRecentPrices, warmRecentCharts } from "../src/lib/instrumentChartStore.server";
import { writeScreeningJson, uploadScreeningJsonFile } from "./screening-json-file";
import { persistWebScreeningCaches } from "./web-screening-cache-store";

interface Options {
  supabaseUserId: string;
  configPath: string | null;
  outputRoot: string;
  upload: boolean;
  force: boolean;
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npm run screening:run -- --supabase-user-id <uuid> [--upload]",
      "Options:",
      "  --config <path>   optional partial/full scoring config JSON",
      "  --output <dir>    default: analysis-runs",
      "  --force           do not reuse a completed identical run",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: "",
    configPath: null,
    outputRoot: "analysis-runs",
    upload: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--supabase-user-id") options.supabaseUserId = argv[++i] ?? usage();
    else if (arg === "--config") options.configPath = argv[++i] ?? usage();
    else if (arg === "--output") options.outputRoot = argv[++i] ?? usage();
    else if (arg === "--upload") options.upload = true;
    else if (arg === "--force") options.force = true;
    else usage();
  }
  if (!/^[0-9a-f-]{36}$/i.test(options.supabaseUserId)) usage();
  return options;
}

async function loadConfig(configPath: string | null): Promise<ScoringConfig> {
  if (!configPath) return mergeScoringConfig(DEFAULT_SCORING_CONFIG);
  return mergeScoringConfig(JSON.parse(await readFile(configPath, "utf8")));
}

async function loadPreviousSnapshot(
  client: ReturnType<typeof trustedSupabaseClient>,
  userId: string,
  currentDate: string,
): Promise<ScreeningSnapshot | null> {
  const { data, error } = await client
    .from("screening_history")
    .select("snapshot")
    .eq("user_id", userId)
    .lt("date", currentDate)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`이전 스크리닝 이력 조회 실패: ${error.message}`);
  return (data?.snapshot as ScreeningSnapshot | undefined) ?? null;
}

function analyzeInputs(
  inputs: Awaited<ReturnType<typeof loadAnalysisSourceInputs>>,
  config: ScoringConfig,
) {
  const parsed = parseManualMarketData(inputs.map((input) => input.text));
  memory("parse-end");
  const result = runFullMarketAnalysis(parsed.dataset, config);
  memory("analysis-end");
  return { ...result, stats: parsed.stats };
}

function releaseSourcePayloads(inputs: Awaited<ReturnType<typeof loadAnalysisSourceInputs>>) {
  for (const input of inputs) {
    input.text = "";
    input.validation.canonicalCsv = "";
    input.validation.rows = [];
  }
}

export async function runScreening(argv = process.argv.slice(2)) {
  memory("start");
  const options = parseArgs(argv);
  const client = trustedSupabaseClient();
  const [inputs, config] = await Promise.all([
    loadAnalysisSourceInputs(client, options.supabaseUserId, "screening", { compact: true }),
    loadConfig(options.configPath),
  ]);

  memory("inputs-loaded");
  const currentCodeVersion = codeVersion();
  const dataVersion = `sha256:${sha256(
    inputs
      .map((input) => input.dataHash)
      .sort()
      .join("\n"),
  )}`;
  const runKey = analysisRunKey({
    kind: "SCREENING",
    codeVersion: currentCodeVersion,
    dataVersion,
    config,
  });
  if (!options.force) {
    const reusable = await findReusableRun(client, options.supabaseUserId, "SCREENING", runKey);
    const reusableDate =
      reusable?.as_of_date ??
      inputs
        .map((input) => input.validation.stats?.maxDate)
        .filter((date): date is string => typeof date === "string")
        .sort()
        .at(-1);
    if (
      reusable &&
      (!options.upload ||
        (reusableDate &&
          (await octoberShadowAlreadyRecorded(
            client,
            options.supabaseUserId,
            "KR",
            reusableDate,
            dataVersion,
          ))))
    ) {
      process.stdout.write(`${JSON.stringify({ reused: true, run: reusable }, null, 2)}\n`);
      return;
    }
  }

  memory("parse-start");
  const { analysis: engineAnalysis, dataset, stats } = analyzeInputs(inputs, config);
  const analysis = withOnsetProfiles(engineAnalysis, dataset, config);
  const sourceRegisteredAt = latestSourceRegistration(
    inputs.flatMap((input) => (input.sourceRecord ? [input.sourceRecord] : [])),
    analysis.asOfDate,
  );
  const snapshot = buildSnapshot(analysis, sourceRegisteredAt);
  // The October Shadow code/config contract remains bound to the untouched frozen engine payload.
  const shadowSnapshot = buildSnapshot(engineAnalysis, sourceRegisteredAt);
  const previous = await loadPreviousSnapshot(client, options.supabaseUserId, snapshot.date);
  const summary = buildScreeningSummary(analysis, snapshot, previous);
  const createdAt = new Date().toISOString();
  const runId = `${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${dataVersion.slice(7, 15)}`;
  const resultPath = `${options.supabaseUserId}/results/screening/${runId}.json`;
  const run = {
    id: runId,
    kind: "SCREENING" as const,
    createdAt,
    engineVersion: `CloudTrend ${analysis.strategyVersion}`,
    codeVersion: currentCodeVersion,
    dataVersion,
    runKey,
  };
  const bundle = {
    schemaVersion: 1 as const,
    run,
    data: {
      source: inputs.some((input) => input.sourceRecord)
        ? ("SUPABASE_SOURCE_REGISTRY" as const)
        : ("SUPABASE_KR" as const),
      sources: inputs.map((input) => ({
        id: input.id,
        objectPath: input.sourceRecord?.storage_path ?? `${options.supabaseUserId}/kr.json`,
        fileName: input.fileName,
        savedAt: input.savedAt,
        bytes: input.bytes,
        fileHash: input.fileHash,
        dataHash: input.dataHash,
        schemaHash: input.schemaHash,
      })),
      fileName: inputs.at(-1)?.fileName ?? null,
      savedAt: inputs.at(-1)?.savedAt ?? null,
      bytes: inputs.reduce((sum, input) => sum + input.bytes, 0),
      asOfDate: analysis.asOfDate,
      stats,
      sectorMapping: {
        reviewedSymbols: REVIEWED_STOCK_SECTOR_COUNT,
        additionalSymbols: ADDITIONAL_STOCK_SECTOR_COUNT,
        sourceColumnOverridesRepositoryMapping: true,
      },
    },
    config,
    summary,
    result: analysis,
  };

  const outputDir = path.resolve(options.outputRoot, `screening-${runId}`);
  await mkdir(outputDir, { recursive: true });
  memory("bundle-write-start");
  const bundleFile = path.join(outputDir, "screening-bundle.json");
  await writeScreeningJson(bundleFile, bundle);
  await writeFile(path.join(outputDir, "screening-summary.json"), JSON.stringify(summary, null, 2));

  memory("bundle-write-end");
  let webCache: Awaited<ReturnType<typeof persistWebScreeningCaches>> | null = null;
  if (options.upload) {
    await persistScreeningSnapshot(client, options.supabaseUserId, snapshot);

    memory("cache-publish-start");
    webCache = await persistWebScreeningCaches({
      client,
      userId: options.supabaseUserId,
      inputs,
      config,
      analysis,
      snapshot,
      previous,
    });

    memory("cache-publish-end");
    if (analysis.asOfDate >= MODEL_ACCOUNTING_START) {
      const currentSources = inputs.filter((i) => i.validation.stats.maxDate === analysis.asOfDate);
      const availableAt = inputs
        .map((i) => i.savedAt)
        .sort((a, b) => Date.parse(a) - Date.parse(b))
        .at(-1);
      if (
        !availableAt ||
        !isKrOfficialShadowDecision(analysis.asOfDate, availableAt, createdAt)
      ) {
        process.stdout.write(
          `${JSON.stringify({
            octoberShadow: {
              status: "PREVIEW_ONLY",
              date: analysis.asOfDate,
              reason: "KR Shadow waits for the next regular-session morning KRX refresh",
            },
          })}\n`,
        );
      } else {
        const octoberShadow = await publishOctoberShadow(client, options.supabaseUserId, {
          market: "KR",
          dataset,
          analysis: engineAnalysis,
          snapshot: shadowSnapshot,
          config,
          sourceHash: sourceSeriesHash(dataVersion),
          availableAt,
          decisionAt: createdAt,
          confirmedRegularClose: currentSources.length > 0,
          failedSymbols: previous
            ? previous.entries.filter(
                (entry) => !analysis.rows.some((row) => row.instrument.symbol === entry.symbol),
              ).length
            : -1,
          universeEvidence: {
            asOfDate: previous?.asOfDate ?? "",
            sourceHash: await hashSeriesValue(previous),
            symbols: [...new Set(previous?.entries.map((entry) => entry.symbol) ?? [])].sort(),
          },
          sourceEvidence: inputs.map((source) => ({
            sourceHash: sourceSeriesHash(source.dataHash),
            asOfDate: source.validation.stats.maxDate ?? "",
            registeredAt: source.savedAt,
          })),
        });
        process.stdout.write(`${JSON.stringify({ octoberShadow })}\n`);
      }
    }
    releaseSourcePayloads(inputs);
    await Promise.all([
      uploadScreeningJsonFile(client, resultPath, bundleFile),
      uploadJson(client, `${options.supabaseUserId}/results/screening/latest.json`, {
        run,
        resultPath,
        summary,
      }),
      saveRunRecord(client, {
        id: `screening-${runId}`,
        user_id: options.supabaseUserId,
        kind: "SCREENING",
        status: "COMPLETED",
        run_key: runKey,
        requested_by: requestedBy(),
        code_version: currentCodeVersion,
        data_version: dataVersion,
        config: config as unknown as Record<string, unknown>,
        summary,
        as_of_date: analysis.asOfDate,
        result_path: resultPath,
        created_at: createdAt,
        completed_at: new Date().toISOString(),
        error: null,
      }),
    ]);
  }

  releaseSourcePayloads(inputs);
  memory("publish-end");
  if (options.upload && webCache) {
    try {
      const ctx = { dataset, analysis, config };
      await publishRecentPrices(
        client,
        options.supabaseUserId,
        webCache.inputFingerprint,
        webCache.resultDigest,
        ctx,
      );
      await warmRecentCharts(client, options.supabaseUserId, webCache, ctx);
    } catch (error) {
      process.stderr.write(
        `차트 사전 준비 실패 (스크리닝 결과는 저장됨): ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  memory("charts-end");
  process.stdout.write(
    `${JSON.stringify({ reused: false, run, outputDir, resultPath: options.upload ? resultPath : null, webCache, summary }, null, 2)}\n`,
  );
}

if (!process.env["VITEST"])
  runScreening().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
