import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  createBacktestRunBundle,
  type BacktestDataFileVersion,
} from "../src/lib/backtestRunBundle";
import {
  DEFAULT_BACKTEST_PARAMS,
  DEFAULT_HORIZONS,
  runBacktest,
  type BacktestInputSeries,
  type BacktestParams,
} from "../src/lib/engine/backtestV4";
import { buildAlignedRankingAnalysis } from "../src/lib/engine/backtestRankingV5";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";

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
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") options.inputs.push(argv[++i] ?? usage());
    else if (arg === "--config") options.configPath = argv[++i] ?? usage();
    else if (arg === "--output") options.outputRoot = argv[++i] ?? usage();
    else if (arg === "--supabase-user-id") options.supabaseUserId = argv[++i] ?? usage();
    else if (arg === "--upload") options.upload = true;
    else usage();
  }
  if (options.inputs.length === 0 && !options.supabaseUserId) usage();
  if (options.inputs.length > 0 && options.supabaseUserId) usage();
  return options;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function codeVersion() {
  const explicit = process.env["GITHUB_SHA"] ?? process.env["VERCEL_GIT_COMMIT_SHA"];
  if (explicit) return explicit;
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const diff = execFileSync("git", ["diff", "--no-ext-diff", "--binary", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    return diff ? `${commit}+dirty:${sha256(diff).slice(0, 12)}` : commit;
  } catch {
    return "unknown";
  }
}

function supabaseClient() {
  const url = process.env["SUPABASE_URL"];
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase 모드에는 SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY가 필요합니다.");
  }
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

async function downloadJson(client: SupabaseClient, objectPath: string) {
  const { data, error } = await client.storage.from("cloudtrend-data").download(objectPath);
  if (error) throw new Error(`Supabase 다운로드 실패 (${objectPath}): ${error.message}`);
  return JSON.parse(await data.text()) as Record<string, unknown>;
}

async function loadSupabaseInputs(
  client: SupabaseClient,
  userId: string,
): Promise<SupabaseInput[]> {
  const index = await downloadJson(client, `${userId}/backtest/index.json`);
  const files = Array.isArray(index["files"]) ? index["files"] : [];
  if (files.length === 0) throw new Error("Supabase backtest/index.json에 입력 파일이 없습니다.");
  return Promise.all(
    files.map(async (raw) => {
      const entry = raw as Record<string, unknown>;
      const id = String(entry["id"] ?? "");
      const objectPath =
        id === "__legacy__" ? `${userId}/backtest.json` : `${userId}/backtest/${id}.json`;
      const stored = await downloadJson(client, objectPath);
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
      bars: dataset.bars[instrument.symbol] ?? [],
    }))
    .filter((series) => series.bars.length > 0);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(options.configPath, "utf8")) as RunConfig;
  const execution = {
    symbols: config.symbols ?? [],
    limit: Math.max(1, Math.round(config.limit ?? 613)),
    includeEtf: config.includeEtf ?? false,
    roundTripCostBps: Math.max(0, config.roundTripCostBps ?? 0),
  };
  const client = options.supabaseUserId ? supabaseClient() : null;
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
  const marketContext = { indexSeries: parsed.dataset.indexSeries };
  const result = runBacktest(series, params, marketContext);
  const ranking = buildAlignedRankingAnalysis(series, params, marketContext);
  result.rankIcByDate = ranking.rankIcByDate;
  result.rankIcSummary = ranking.rankIcSummary;
  result.topSelection = ranking.topSelection;
  result.quantileSpreads = ranking.quantileSpreads;

  const files: BacktestDataFileVersion[] = inputs.map(({ id, fileName, bytes, savedAt }) => ({
    id,
    fileName,
    bytes,
    savedAt,
  }));
  const bundle = await createBacktestRunBundle(
    result,
    {
      source: options.supabaseUserId ? "SUPABASE_BACKTEST" : "LOCAL_FILES",
      datasetVersion: parsed.dataset.version,
      asOfDate: parsed.dataset.asOfDate,
      files,
    },
    execution,
    codeVersion(),
  );
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
  }
  process.stdout.write(
    `${JSON.stringify({ run: bundle.run, outputDir, remotePath, scoreChangeRows }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
