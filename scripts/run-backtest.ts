import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createBacktestDataVersion,
  createBacktestRunBundle,
  type BacktestDataFileVersion,
  type BacktestDataVersionInput,
  type BacktestRunIndexEntry,
} from "../src/lib/backtestRunBundle";
import { buildBacktestSummary } from "../src/lib/analysisRunBundle";
import {
  DEFAULT_BACKTEST_PARAMS,
  DEFAULT_HORIZONS,
  runBacktest,
  type BacktestInputSeries,
  type BacktestParams,
} from "../src/lib/engine/backtestV4";
import { buildAlignedRankingAnalysis } from "../src/lib/engine/backtestRankingV5";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
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

interface RunConfig {
  symbols?: string[];
  limit?: number;
  includeEtf?: boolean;
  roundTripCostBps?: number;
  horizons?: number[];
  horizonDays?: number;
  sampleEvery?: number;
}

interface Options {
  inputs: string[];
  configPath: string;
  outputRoot: string;
  supabaseUserId: string | null;
  upload: boolean;
  force: boolean;
  limit: number | null;
  roundTripCostBps: number | null;
  includeEtf: boolean | null;
}

interface SupabaseInput {
  id: string;
  fileName: string | null;
  bytes: number;
  savedAt: string;
  text: string;
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npm run backtest:run -- --input data-1.csv [--input data-2.csv]",
      "  npm run backtest:run -- --supabase-user-id <uuid> [--upload]",
      "Options:",
      "  --config <path>   default: config/backtest.score-change.json",
      "  --output <dir>    default: backtest-runs",
      "  --limit <count>   override config Universe size",
      "  --round-trip-cost-bps <bps>   override config cost",
      "  --include-etf | --exclude-etf  override config ETF setting",
      "  --force           do not reuse a completed identical run",
      "Supabase mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    inputs: [],
    configPath: "config/backtest.score-change.json",
    outputRoot: "backtest-runs",
    supabaseUserId: null,
    upload: false,
    force: false,
    limit: null,
    roundTripCostBps: null,
    includeEtf: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") options.inputs.push(argv[++i] ?? usage());
    else if (arg === "--config") options.configPath = argv[++i] ?? usage();
    else if (arg === "--output") options.outputRoot = argv[++i] ?? usage();
    else if (arg === "--supabase-user-id") options.supabaseUserId = argv[++i] ?? usage();
    else if (arg === "--upload") options.upload = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--limit") options.limit = Number(argv[++i] ?? usage());
    else if (arg === "--round-trip-cost-bps")
      options.roundTripCostBps = Number(argv[++i] ?? usage());
    else if (arg === "--include-etf") options.includeEtf = true;
    else if (arg === "--exclude-etf") options.includeEtf = false;
    else usage();
  }
  if (options.inputs.length === 0 && !options.supabaseUserId) usage();
  if (options.inputs.length > 0 && options.supabaseUserId) usage();
  return options;
}

async function loadSupabaseInputs(
  client: SupabaseClient,
  userId: string,
): Promise<SupabaseInput[]> {
  const index = await downloadJson<Record<string, unknown>>(
    client,
    `${userId}/backtest/index.json`,
  );
  const files = Array.isArray(index["files"]) ? index["files"] : [];
  if (files.length === 0) throw new Error("Supabase backtest/index.json에 입력 파일이 없습니다.");
  return Promise.all(
    files.map(async (raw) => {
      const entry = raw as Record<string, unknown>;
      const id = String(entry["id"] ?? "");
      const objectPath =
        id === "__legacy__" ? `${userId}/backtest.json` : `${userId}/backtest/${id}.json`;
      const stored = await downloadJson<Record<string, unknown>>(client, objectPath);
      const text = typeof stored["text"] === "string" ? stored["text"] : "";
      if (!text) throw new Error(`Supabase 입력 본문이 비어 있습니다: ${objectPath}`);
      return {
        id,
        fileName: typeof entry["fileName"] === "string" ? entry["fileName"] : null,
        bytes: Number(entry["bytes"] ?? Buffer.byteLength(text)),
        savedAt: String(entry["savedAt"] ?? new Date(0).toISOString()),
        text,
      };
    }),
  );
}

async function loadLocalInputs(files: string[]): Promise<SupabaseInput[]> {
  return Promise.all(
    files.map(async (file) => {
      const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      return {
        id: `sha256:${sha256(text)}`,
        fileName: path.basename(file),
        bytes: Buffer.byteLength(text),
        savedAt: info.mtime.toISOString(),
        text,
      };
    }),
  );
}

async function uploadBundle(
  client: SupabaseClient,
  userId: string,
  bundleText: string,
  runId: string,
) {
  const objectPath = `${userId}/backtest/runs/${runId}.json`;
  const { error } = await client.storage.from("cloudtrend-data").upload(objectPath, bundleText, {
    contentType: "application/json",
    upsert: true,
  });
  if (error) throw new Error(`Supabase 결과 업로드 실패: ${error.message}`);
  return objectPath;
}

async function updateBacktestRunIndex(
  client: SupabaseClient,
  userId: string,
  entry: BacktestRunIndexEntry,
) {
  const indexPath = `${userId}/backtest/runs/index.json`;
  let current: BacktestRunIndexEntry[] = [];
  try {
    current =
      (await downloadJson<{ runs?: BacktestRunIndexEntry[] }>(client, indexPath)).runs ?? [];
  } catch (error) {
    if (!(error instanceof Error) || !/Object not found|not_found|404/i.test(error.message))
      throw error;
  }
  const runs = [entry, ...current.filter((run) => run.id !== entry.id)].slice(0, 100);
  await uploadJson(client, indexPath, { runs });
}

function buildSeries(
  dataset: ReturnType<typeof parseManualMarketData>["dataset"],
  config: Required<Pick<RunConfig, "symbols" | "limit" | "includeEtf">>,
): BacktestInputSeries[] {
  const selected = config.symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  const pool = selected.length
    ? dataset.instruments.filter((instrument) => selected.includes(instrument.symbol))
    : [...dataset.instruments]
        .filter((instrument) => config.includeEtf || instrument.instrumentType === "STOCK")
        .sort(
          (a, b) =>
            (dataset.bars[b.symbol]?.at(-1)?.tradingValue ?? 0) -
            (dataset.bars[a.symbol]?.at(-1)?.tradingValue ?? 0),
        )
        .slice(0, config.limit);
  return pool
    .map((instrument) => ({
      symbol: instrument.symbol,
      name: instrument.name,
      market: instrument.market === "KOSDAQ" ? ("KOSDAQ" as const) : ("KOSPI" as const),
      sectorCode: instrument.sectorCode,
      sectorName: instrument.sectorName,
      bars: dataset.bars[instrument.symbol] ?? [],
    }))
    .filter((series) => series.bars.length > 0);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(options.configPath, "utf8")) as RunConfig;
  const execution = {
    symbols: config.symbols ?? [],
    limit: Math.max(1, Math.round(options.limit ?? config.limit ?? 613)),
    includeEtf: options.includeEtf ?? config.includeEtf ?? false,
    roundTripCostBps: Math.max(0, options.roundTripCostBps ?? config.roundTripCostBps ?? 0),
  };
  const client = options.supabaseUserId ? trustedSupabaseClient() : null;
  const inputs = options.supabaseUserId
    ? await loadSupabaseInputs(client!, options.supabaseUserId)
    : await loadLocalInputs(options.inputs);
  const parsed = parseManualMarketData(inputs.map((input) => input.text));
  const series = buildSeries(parsed.dataset, execution);
  const params: BacktestParams = {
    ...DEFAULT_BACKTEST_PARAMS,
    horizons: config.horizons ?? DEFAULT_HORIZONS,
    horizonDays: config.horizonDays ?? DEFAULT_BACKTEST_PARAMS.horizonDays,
    sampleEvery: config.sampleEvery ?? DEFAULT_BACKTEST_PARAMS.sampleEvery,
    roundTripCostBps: execution.roundTripCostBps,
  };
  const files: BacktestDataFileVersion[] = inputs.map(({ id, fileName, bytes, savedAt }) => ({
    id,
    fileName,
    bytes,
    savedAt,
  }));
  const data: BacktestDataVersionInput = {
    source: options.supabaseUserId ? "SUPABASE_BACKTEST" : "LOCAL_FILES",
    datasetVersion: parsed.dataset.version,
    asOfDate: parsed.dataset.asOfDate,
    files,
    universe: series.map((item) => ({
      symbol: item.symbol,
      name: item.name,
      market: item.market ?? "KOSPI",
      sectorCode: item.sectorCode ?? "ETC",
      sectorName: item.sectorName ?? "기타",
      bars: item.bars.length,
    })),
  };
  const currentCodeVersion = codeVersion();
  const dataVersion = await createBacktestDataVersion(data);
  const runKey = analysisRunKey({
    kind: "BACKTEST",
    codeVersion: currentCodeVersion,
    dataVersion,
    config: { execution, params },
  });
  if (client && options.supabaseUserId && !options.force) {
    const reusable = await findReusableRun(client, options.supabaseUserId, "BACKTEST", runKey);
    if (reusable) {
      process.stdout.write(`${JSON.stringify({ reused: true, run: reusable }, null, 2)}\n`);
      return;
    }
  }
  const marketContext = { indexSeries: parsed.dataset.indexSeries };
  const result = runBacktest(series, params, marketContext);
  const ranking = buildAlignedRankingAnalysis(series, params, marketContext);
  result.rankIcByDate = ranking.rankIcByDate;
  result.rankIcSummary = ranking.rankIcSummary;
  result.topSelection = ranking.topSelection;
  result.quantileSpreads = ranking.quantileSpreads;

  const bundle = await createBacktestRunBundle(result, data, execution, currentCodeVersion);
  const outputDir = path.resolve(options.outputRoot, bundle.run.id);
  await mkdir(outputDir, { recursive: true });
  const bundleText = JSON.stringify(bundle, null, 2);
  const scoreChangeRows = result.strategyValidation.scoreChangeRows;
  await Promise.all([
    writeFile(path.join(outputDir, "bundle.json"), bundleText),
    writeFile(
      path.join(outputDir, "score-change-summary.json"),
      JSON.stringify(scoreChangeRows, null, 2),
    ),
  ]);
  let remotePath: string | null = null;
  if (options.upload) {
    if (!client || !options.supabaseUserId)
      throw new Error("--upload은 --supabase-user-id와 함께 사용해야 합니다.");
    remotePath = await uploadBundle(client, options.supabaseUserId, bundleText, bundle.run.id);
    const summary = buildBacktestSummary(bundle);
    await Promise.all([
      updateBacktestRunIndex(client, options.supabaseUserId, {
        id: bundle.run.id,
        createdAt: bundle.run.createdAt,
        engineVersion: bundle.run.engineVersion,
        codeVersion: bundle.run.codeVersion,
        dataVersion: bundle.run.dataVersion,
        asOfDate: bundle.data.asOfDate,
        symbolCount: bundle.result.symbolCount,
        from: bundle.result.from,
        to: bundle.result.to,
        path: `backtest/runs/${bundle.run.id}.json`,
      }),
      uploadJson(client, `${options.supabaseUserId}/analysis/latest-backtest.json`, {
        run: bundle.run,
        resultPath: remotePath,
        summary,
      }),
      saveRunRecord(client, {
        id: `backtest-${bundle.run.id}`,
        user_id: options.supabaseUserId,
        kind: "BACKTEST",
        status: "COMPLETED",
        run_key: runKey,
        requested_by: requestedBy(),
        code_version: bundle.run.codeVersion,
        data_version: bundle.run.dataVersion,
        config: { execution, engine: bundle.config.engine },
        summary,
        as_of_date: bundle.data.asOfDate,
        result_path: remotePath,
        created_at: bundle.run.createdAt,
        completed_at: new Date().toISOString(),
        error: null,
      }),
    ]);
  }
  process.stdout.write(
    `${JSON.stringify({ run: bundle.run, outputDir, remotePath, scoreChangeRows }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
