import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { buildScreeningSummary } from "../src/lib/analysisRunBundle";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  DEFAULT_SCORING_CONFIG,
  mergeScoringConfig,
  type ScoringConfig,
} from "../src/lib/engine/scoring";
import { ADDITIONAL_STOCK_SECTOR_COUNT } from "../src/lib/engine/additionalStockSectorMaster";
import { REVIEWED_STOCK_SECTOR_COUNT } from "../src/lib/engine/stockSectorMaster";
import { buildSnapshot, type ScreeningSnapshot } from "../src/lib/screeningSnapshot";
import {
  analysisRunKey,
  codeVersion,
  downloadJson,
  findReusableRun,
  requestedBy,
  saveRunRecord,
  sha256,
  trustedSupabaseClient,
  uploadJson,
} from "./analysis-run-store";

interface Options {
  supabaseUserId: string;
  configPath: string | null;
  outputRoot: string;
  upload: boolean;
  force: boolean;
}

interface StoredMarketData {
  text: string;
  meta?: { savedAt?: string; fileName?: string | null; chars?: number };
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = trustedSupabaseClient();
  const objectPath = `${options.supabaseUserId}/kr.json`;
  const [stored, config] = await Promise.all([
    downloadJson<StoredMarketData>(client, objectPath),
    loadConfig(options.configPath),
  ]);
  if (!stored.text?.trim()) throw new Error("Supabase kr.json의 데이터 본문이 비어 있습니다.");

  const currentCodeVersion = codeVersion();
  const dataVersion = `sha256:${sha256(stored.text)}`;
  const runKey = analysisRunKey({
    kind: "SCREENING",
    codeVersion: currentCodeVersion,
    dataVersion,
    config,
  });
  if (!options.force) {
    const reusable = await findReusableRun(client, options.supabaseUserId, "SCREENING", runKey);
    if (reusable) {
      process.stdout.write(`${JSON.stringify({ reused: true, run: reusable }, null, 2)}\n`);
      return;
    }
  }

  const parsed = parseManualMarketData(stored.text);
  const { analysis } = runFullMarketAnalysis(parsed.dataset, config);
  const snapshot = buildSnapshot(analysis);
  const previous = await loadPreviousSnapshot(client, options.supabaseUserId, snapshot.date);
  const summary = buildScreeningSummary(analysis, snapshot, previous);
  const createdAt = new Date().toISOString();
  const runId = `${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${dataVersion.slice(7, 15)}`;
  const resultPath = `${options.supabaseUserId}/analysis/runs/screening-${runId}.json`;
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
      source: "SUPABASE_KR" as const,
      objectPath,
      fileName: stored.meta?.fileName ?? null,
      savedAt: stored.meta?.savedAt ?? null,
      bytes: Buffer.byteLength(stored.text),
      asOfDate: analysis.asOfDate,
      stats: parsed.stats,
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
  await Promise.all([
    writeFile(path.join(outputDir, "screening-bundle.json"), JSON.stringify(bundle, null, 2)),
    writeFile(path.join(outputDir, "screening-summary.json"), JSON.stringify(summary, null, 2)),
  ]);

  if (options.upload) {
    const { error: historyError } = await client
      .from("screening_history")
      .upsert(
        { user_id: options.supabaseUserId, date: snapshot.date, snapshot },
        { onConflict: "user_id,date" },
      );
    if (historyError) throw new Error(`스크리닝 이력 저장 실패: ${historyError.message}`);
    await Promise.all([
      uploadJson(client, resultPath, bundle),
      uploadJson(client, `${options.supabaseUserId}/analysis/latest-screening.json`, {
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

  process.stdout.write(
    `${JSON.stringify({ reused: false, run, outputDir, resultPath: options.upload ? resultPath : null, summary }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
