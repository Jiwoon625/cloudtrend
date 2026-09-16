import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildPortfolioSignalContext } from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { DailyPrice } from "../src/lib/engine/types";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8 KOSPI Explanatory Baseline 3-FOS" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const HORIZONS = [5, 20, 40] as const;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const MIN_IC_CROSS_SECTION = 10;

const SCORE_BUCKETS = [
  { id: "LT6", label: "<6", min: Number.NEGATIVE_INFINITY, max: 6 },
  { id: "6_7", label: "6-<7", min: 6, max: 7 },
  { id: "7_8", label: "7-<8", min: 7, max: 8 },
  { id: "8_9", label: "8-<9", min: 8, max: 9 },
  { id: "GE9", label: ">=9", min: 9, max: Number.POSITIVE_INFINITY },
] as const;

type FoldYear = (typeof FOLD_YEARS)[number];
type Horizon = (typeof HORIZONS)[number];
type BucketId = (typeof SCORE_BUCKETS)[number]["id"];

interface CacheManifestFile {
  id: string;
  fileName: string;
  bytes: number;
  savedAt: string;
  fileHash: string;
  cacheFile: string;
}

interface CacheManifest {
  schemaVersion: 1;
  sourceType: "backtest";
  cacheKey: string;
  fileCount: number;
  totalBytes: number;
  files: CacheManifestFile[];
}

interface Options {
  sourceManifest: string;
  sourceCacheDir: string;
  userId: string | null;
  upload: boolean;
}

interface Observation {
  date: string;
  symbol: string;
  score: number;
  ret: number;
  excess: number;
  onset8: boolean;
}

interface MetricSummary {
  count: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  avgExcessReturn: number | null;
  medianExcessReturn: number | null;
  excessWinRate: number | null;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node scripts/run-v8-kospi-explanatory-baseline-3fos.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    sourceManifest: "",
    sourceCacheDir: "",
    userId: process.env["SUPABASE_USER_ID"] ?? null,
    upload: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source-manifest") options.sourceManifest = argv[++i] ?? usage("--source-manifest 값이 없습니다.");
    else if (arg === "--source-cache-dir") options.sourceCacheDir = argv[++i] ?? usage("--source-cache-dir 값이 없습니다.");
    else if (arg === "--supabase-user-id") options.userId = argv[++i] ?? usage("--supabase-user-id 값이 없습니다.");
    else if (arg === "--upload") options.upload = true;
    else usage(`지원하지 않는 인자입니다: ${arg}`);
  }
  if (!options.sourceManifest || !options.sourceCacheDir) usage("source manifest와 cache dir가 필요합니다.");
  if (options.upload && !/^[0-9a-f-]{36}$/i.test(options.userId ?? "")) usage("업로드에는 유효한 Supabase user id가 필요합니다.");
  return options;
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)]! + sorted[Math.ceil(mid)]!) / 2;
}

function round(value: number | null, digits = 6) {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function decodeSourceBytes(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

async function loadCachedTexts(manifestPath: string, cacheDir: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CacheManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.sourceType !== "backtest" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== manifest.fileCount
  ) throw new Error("지원하지 않거나 손상된 source cache manifest입니다.");

  const texts: string[] = [];
  for (const file of manifest.files) {
    const bytes = new Uint8Array(await readFile(path.join(cacheDir, file.cacheFile)));
    const fileHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== file.bytes || fileHash !== file.fileHash)
      throw new Error(`source cache 무결성 검증 실패: ${file.fileName}`);
    texts.push(decodeSourceBytes(bytes));
  }
  process.stderr.write(
    `KOSPI baseline source cache verified: ${manifest.fileCount} files / ${(manifest.totalBytes / 1_000_000).toFixed(1)} MB\n`,
  );
  return { texts, manifest };
}

function benchmarkMap(dataset: MarketDataset) {
  const series = dataset.indexSeries.find((item) => item.indexCode === "KOSPI");
  return new Map((series?.bars ?? []).map((bar) => [bar.tradeDate, bar]));
}

function benchmarkReturn(map: Map<string, DailyPrice>, entryDate: string, exitDate: string) {
  const entry = map.get(entryDate);
  const exit = map.get(exitDate);
  if (!entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exit.close) || exit.close <= 0) return null;
  return (exit.close / entry.open - 1) * 100;
}

function adjustedScore10(baseScore9p5: number | null, sectorPriceLeadership: number | null) {
  if (!finite(baseScore9p5)) return null;
  const sectorAvailable = finite(sectorPriceLeadership);
  const sectorOverheated = sectorAvailable && sectorPriceLeadership >= SECTOR_OVERHEAT_THRESHOLD;
  const sectorContribution = sectorAvailable && !sectorOverheated ? SECTOR_SLOT : 0;
  return Math.round((baseScore9p5 + sectorContribution) * 100) / 100;
}

function bucketFor(score: number): BucketId {
  return SCORE_BUCKETS.find((bucket) => score >= bucket.min && score < bucket.max)!.id;
}

function summarize(rows: Observation[]): MetricSummary {
  const returns = rows.map((row) => row.ret);
  const excess = rows.map((row) => row.excess);
  return {
    count: rows.length,
    avgReturn: round(average(returns)),
    medianReturn: round(median(returns)),
    winRate: rows.length ? round((returns.filter((value) => value > 0).length / rows.length) * 100) : null,
    avgExcessReturn: round(average(excess)),
    medianExcessReturn: round(median(excess)),
    excessWinRate: rows.length ? round((excess.filter((value) => value > 0).length / rows.length) * 100) : null,
  };
}

function ranks(values: number[]) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i + 1;
    while (j < indexed.length && indexed[j]!.value === indexed[i]!.value) j++;
    const averageRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) out[indexed[k]!.index] = averageRank;
    i = j;
  }
  return out;
}

function pearson(xs: number[], ys: number[]) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = average(xs)!;
  const my = average(ys)!;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  const denominator = Math.sqrt(vx * vy);
  return denominator > 0 ? cov / denominator : null;
}

function spearman(xs: number[], ys: number[]) {
  return pearson(ranks(xs), ranks(ys));
}

function dailyIc(rows: Observation[], target: "return" | "excess") {
  const byDate = new Map<string, Observation[]>();
  for (const row of rows) {
    const bucket = byDate.get(row.date) ?? [];
    bucket.push(row);
    byDate.set(row.date, bucket);
  }
  const values: number[] = [];
  for (const dateRows of byDate.values()) {
    if (dateRows.length < MIN_IC_CROSS_SECTION) continue;
    const ic = spearman(
      dateRows.map((row) => row.score),
      dateRows.map((row) => (target === "return" ? row.ret : row.excess)),
    );
    if (finite(ic)) values.push(ic);
  }
  return {
    dates: values.length,
    mean: round(average(values)),
    median: round(median(values)),
    positiveRate: values.length ? round((values.filter((value) => value > 0).length / values.length) * 100) : null,
  };
}

function bucketRows(rows: Observation[]) {
  return SCORE_BUCKETS.map((bucket) => ({
    bucket: bucket.id,
    label: bucket.label,
    ...summarize(rows.filter((row) => bucketFor(row.score) === bucket.id)),
  }));
}

function monotonicity(bucketMetrics: ReturnType<typeof bucketRows>, field: "avgReturn" | "avgExcessReturn") {
  const valid = bucketMetrics.map((row, index) => ({ x: index, y: row[field] })).filter((row): row is { x: number; y: number } => finite(row.y));
  if (valid.length < 3) return null;
  return round(spearman(valid.map((row) => row.x), valid.map((row) => row.y)));
}

function foldRows(rows: Observation[]) {
  return FOLD_YEARS.flatMap((fold) => HORIZONS.map((horizon) => {
    const selected = rows.filter((row) => Number(row.date.slice(0, 4)) === fold && (row as Observation & { horizon?: Horizon }).horizon === undefined);
    return { fold, horizon, count: selected.length };
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const parsed = parseManualMarketData(texts);
  const dataset = parsed.dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const kospiBenchmark = benchmarkMap(dataset);

  const observations = new Map<string, Observation[]>();
  for (const fold of FOLD_YEARS) for (const horizon of HORIZONS) observations.set(`${fold}|${horizon}`, []);

  const kospiSeries = context.series.filter((series) => series.market === "KOSPI");
  for (const series of kospiSeries) {
    const scores = series.baseScores.map((base, index) => adjustedScore10(base, series.sectorPriceLeadership[index] ?? null));
    for (let i = 1; i + 1 < series.bars.length; i++) {
      const signal = series.bars[i]!;
      const fold = Number(signal.tradeDate.slice(0, 4));
      if (!FOLD_YEARS.includes(fold as FoldYear)) continue;
      const score = scores[i];
      if (!finite(score)) continue;
      const entry = series.bars[i + 1];
      if (!entry || !finite(entry.open) || entry.open <= 0) continue;
      const prevScore = scores[i - 1];
      const onset8 = finite(prevScore) && prevScore < ONSET_THRESHOLD && score >= ONSET_THRESHOLD;

      for (const horizon of HORIZONS) {
        const exit = series.bars[i + horizon];
        if (!exit || !finite(exit.close) || exit.close <= 0) continue;
        const benchmark = benchmarkReturn(kospiBenchmark, entry.tradeDate, exit.tradeDate);
        if (!finite(benchmark)) continue;
        const ret = (exit.close / entry.open - 1) * 100;
        const excess = ret - benchmark;
        observations.get(`${fold}|${horizon}`)!.push({
          date: signal.tradeDate,
          symbol: series.symbol,
          score,
          ret,
          excess,
          onset8,
        });
      }
    }
  }

  const folds = FOLD_YEARS.flatMap((fold) => HORIZONS.map((horizon) => {
    const rows = observations.get(`${fold}|${horizon}`) ?? [];
    const buckets = bucketRows(rows);
    const onsetRows = rows.filter((row) => row.onset8);
    return {
      fold,
      horizon,
      all: summarize(rows),
      scoreBuckets: buckets,
      monotonicity: {
        absoluteReturn: monotonicity(buckets, "avgReturn"),
        excessReturn: monotonicity(buckets, "avgExcessReturn"),
      },
      dailySpearmanIc: {
        absoluteReturn: dailyIc(rows, "return"),
        excessReturn: dailyIc(rows, "excess"),
      },
      onset8: summarize(onsetRows),
    };
  }));

  const aggregates = HORIZONS.map((horizon) => {
    const selected = folds.filter((row) => row.horizon === horizon);
    const bucketAggregate = SCORE_BUCKETS.map((bucket) => {
      const rows = selected.map((fold) => fold.scoreBuckets.find((row) => row.bucket === bucket.id)!).filter((row) => row.count > 0);
      return {
        bucket: bucket.id,
        label: bucket.label,
        foldsWithData: rows.length,
        totalObservations: rows.reduce((sum, row) => sum + row.count, 0),
        equalWeightAvgReturn: round(average(rows.map((row) => row.avgReturn).filter(finite))),
        equalWeightAvgExcessReturn: round(average(rows.map((row) => row.avgExcessReturn).filter(finite))),
        equalWeightExcessWinRate: round(average(rows.map((row) => row.excessWinRate).filter(finite))),
      };
    });
    const onsetRows = selected.map((row) => row.onset8).filter((row) => row.count > 0);
    return {
      horizon,
      scoreBuckets: bucketAggregate,
      meanFoldMonotonicityAbsolute: round(average(selected.map((row) => row.monotonicity.absoluteReturn).filter(finite))),
      meanFoldMonotonicityExcess: round(average(selected.map((row) => row.monotonicity.excessReturn).filter(finite))),
      meanFoldDailyIcAbsolute: round(average(selected.map((row) => row.dailySpearmanIc.absoluteReturn.mean).filter(finite))),
      meanFoldDailyIcExcess: round(average(selected.map((row) => row.dailySpearmanIc.excessReturn.mean).filter(finite))),
      onset8: {
        foldsWithSignals: onsetRows.length,
        totalSignals: onsetRows.reduce((sum, row) => sum + row.count, 0),
        equalWeightAvgReturn: round(average(onsetRows.map((row) => row.avgReturn).filter(finite))),
        equalWeightAvgExcessReturn: round(average(onsetRows.map((row) => row.avgExcessReturn).filter(finite))),
        equalWeightExcessWinRate: round(average(onsetRows.map((row) => row.excessWinRate).filter(finite))),
      },
    };
  });

  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const result = {
    version: STUDY_VERSION,
    createdAt,
    runId,
    data: {
      datasetVersion: dataset.version,
      asOfDate: dataset.asOfDate,
      sourceCacheKey: manifest.cacheKey,
      sourceFiles: manifest.fileCount,
      sourceBytes: manifest.totalBytes,
      contextSymbolCount: context.symbolCount,
      kospiSeriesCount: kospiSeries.length,
      kospiBenchmarkBars: kospiBenchmark.size,
    },
    design: {
      market: "KOSPI",
      folds: [...FOLD_YEARS],
      horizons: [...HORIZONS],
      score: "Current strict V8 10-point score = historical base 9.5 + 0.5 sector slot when sector PL is available and <80; PL>=80 receives no sector slot.",
      entryExecution: "NEXT_OPEN",
      exitExecution: "HORIZON_CLOSE",
      benchmark: "KOSPI NEXT_OPEN to same HORIZON_CLOSE",
      targets: ["absoluteReturn", "kospiExcessReturn"],
      scoreBuckets: SCORE_BUCKETS.map(({ id, label }) => ({ id, label })),
      onset8: "previous score <8 and current score >=8",
      ic: `Daily cross-sectional Spearman rank correlation; minimum ${MIN_IC_CROSS_SECTION} KOSPI stocks per date.`,
      modelSelectionRule: "Baseline measurement only. No score weights or thresholds are changed in this study.",
    },
    aggregates,
    folds,
    notes: [
      "This is a frozen-baseline explanatory study. It does not modify production scoring or screening behavior.",
      "Returns start at the next trading-day open so the signal-day close score cannot use future execution information.",
      "3-FOS fold years match the existing CloudTrend V8 research convention: 2018, 2022, and 2025.",
      "Primary explanatory target is KOSPI excess return; absolute return is retained for economic interpretation.",
    ],
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `v8-kospi-explanatory-baseline-3fos-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kospi-explanatory-baseline-3fos/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(client, `${options.userId}/results/v8-kospi-explanatory-baseline-3fos/latest.json`, {
      version: STUDY_VERSION,
      createdAt,
      runId,
      resultPath: remotePath,
      aggregates,
    });
  }

  process.stdout.write(`${JSON.stringify({ outputPath, remotePath, aggregates }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
