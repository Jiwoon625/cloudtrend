import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildPortfolioSignalContext } from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { DailyPrice } from "../src/lib/engine/types";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8 KOSPI Relative Strength 3-FOS" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const HORIZONS = [5, 20, 40] as const;
const FEATURES = ["RS20", "RS60", "RS_ACCEL"] as const;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const MIN_IC_CROSS_SECTION = 10;
const QUINTILES = [1, 2, 3, 4, 5] as const;

type FoldYear = (typeof FOLD_YEARS)[number];
type Horizon = (typeof HORIZONS)[number];
type Feature = (typeof FEATURES)[number];
type Quintile = (typeof QUINTILES)[number];

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
  rs20: number;
  rs60: number;
  rsAccel: number;
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
  throw new Error([
    ...(message ? [message, ""] : []),
    "Usage:",
    "  npx vite-node scripts/run-v8-kospi-relative-strength-3fos.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
  ].join("\n"));
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
    `KOSPI RS source cache verified: ${manifest.fileCount} files / ${(manifest.totalBytes / 1_000_000).toFixed(1)} MB\n`,
  );
  return { texts, manifest };
}

function benchmarkSeries(dataset: MarketDataset) {
  const series = dataset.indexSeries.find((item) => item.indexCode === "KOSPI");
  if (!series?.bars.length) throw new Error("KOSPI 지수 일봉이 없습니다.");
  const bars = [...series.bars].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  return {
    bars,
    byDate: new Map(bars.map((bar) => [bar.tradeDate, bar])),
    indexByDate: new Map(bars.map((bar, index) => [bar.tradeDate, index])),
  };
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

function alignedRelativeStrength(
  bars: DailyPrice[],
  dateIndex: Map<string, number>,
  signalDate: string,
  benchmark: ReturnType<typeof benchmarkSeries>,
  lag: number,
) {
  const benchmarkIndex = benchmark.indexByDate.get(signalDate);
  if (benchmarkIndex === undefined || benchmarkIndex < lag) return null;
  const pastBenchmark = benchmark.bars[benchmarkIndex - lag];
  const currentBenchmark = benchmark.bars[benchmarkIndex];
  if (!pastBenchmark || !currentBenchmark || !finite(pastBenchmark.close) || !finite(currentBenchmark.close) || pastBenchmark.close <= 0) return null;

  const currentStockIndex = dateIndex.get(signalDate);
  const pastStockIndex = dateIndex.get(pastBenchmark.tradeDate);
  if (currentStockIndex === undefined || pastStockIndex === undefined) return null;
  const currentStock = bars[currentStockIndex];
  const pastStock = bars[pastStockIndex];
  if (!currentStock || !pastStock || !finite(currentStock.close) || !finite(pastStock.close) || pastStock.close <= 0) return null;

  const stockReturn = (currentStock.close / pastStock.close - 1) * 100;
  const marketReturn = (currentBenchmark.close / pastBenchmark.close - 1) * 100;
  return stockReturn - marketReturn;
}

function featureValue(row: Observation, feature: Feature) {
  if (feature === "RS20") return row.rs20;
  if (feature === "RS60") return row.rs60;
  return row.rsAccel;
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

function byDate(rows: Observation[]) {
  const out = new Map<string, Observation[]>();
  for (const row of rows) {
    const bucket = out.get(row.date) ?? [];
    bucket.push(row);
    out.set(row.date, bucket);
  }
  return out;
}

function dailyIc(rows: Observation[], feature: Feature, target: "excess" | "score") {
  const values: number[] = [];
  for (const dateRows of byDate(rows).values()) {
    if (dateRows.length < MIN_IC_CROSS_SECTION) continue;
    const ic = spearman(
      dateRows.map((row) => featureValue(row, feature)),
      dateRows.map((row) => target === "excess" ? row.excess : row.score),
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

function dailyQuintileMap(rows: Observation[], feature: Feature) {
  const result = new Map<string, Quintile>();
  for (const [date, dateRows] of byDate(rows)) {
    if (dateRows.length < 5) continue;
    const featureRanks = ranks(dateRows.map((row) => featureValue(row, feature)));
    for (let i = 0; i < dateRows.length; i++) {
      const rank = featureRanks[i]!;
      const quintile = Math.min(5, Math.max(1, Math.floor(((rank - 1) * 5) / dateRows.length) + 1)) as Quintile;
      result.set(`${date}|${dateRows[i]!.symbol}`, quintile);
    }
  }
  return result;
}

function quintileRows(rows: Observation[], feature: Feature) {
  const qMap = dailyQuintileMap(rows, feature);
  return QUINTILES.map((quintile) => ({
    quintile,
    ...summarize(rows.filter((row) => qMap.get(`${row.date}|${row.symbol}`) === quintile)),
  }));
}

function monotonicity(rows: ReturnType<typeof quintileRows>) {
  const valid = rows
    .map((row) => ({ x: row.quintile, y: row.avgExcessReturn }))
    .filter((row): row is { x: Quintile; y: number } => finite(row.y));
  if (valid.length < 3) return null;
  return round(spearman(valid.map((row) => row.x), valid.map((row) => row.y)));
}

function spread(qRows: ReturnType<typeof quintileRows>) {
  const q1 = qRows.find((row) => row.quintile === 1)?.avgExcessReturn;
  const q5 = qRows.find((row) => row.quintile === 5)?.avgExcessReturn;
  return finite(q1) && finite(q5) ? round(q5 - q1) : null;
}

function onsetBreakdown(rows: Observation[], feature: Feature) {
  const qMap = dailyQuintileMap(rows, feature);
  const onsetRows = rows.filter((row) => row.onset8);
  const quintiles = QUINTILES.map((quintile) => ({
    quintile,
    ...summarize(onsetRows.filter((row) => qMap.get(`${row.date}|${row.symbol}`) === quintile)),
  }));
  return {
    all: summarize(onsetRows),
    quintiles,
    q5MinusQ1AvgExcess: spread(quintiles),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const parsed = parseManualMarketData(texts);
  const dataset = parsed.dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const benchmark = benchmarkSeries(dataset);

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

      const rs20 = alignedRelativeStrength(series.bars, series.dateIndex, signal.tradeDate, benchmark, 20);
      const rs60 = alignedRelativeStrength(series.bars, series.dateIndex, signal.tradeDate, benchmark, 60);
      if (!finite(rs20) || !finite(rs60)) continue;
      const rsAccel = rs20 - rs60;

      const entry = series.bars[i + 1];
      if (!entry || !finite(entry.open) || entry.open <= 0) continue;
      const prevScore = scores[i - 1];
      const onset8 = finite(prevScore) && prevScore < ONSET_THRESHOLD && score >= ONSET_THRESHOLD;

      for (const horizon of HORIZONS) {
        const exit = series.bars[i + horizon];
        if (!exit || !finite(exit.close) || exit.close <= 0) continue;
        const marketReturn = benchmarkReturn(benchmark.byDate, entry.tradeDate, exit.tradeDate);
        if (!finite(marketReturn)) continue;
        const ret = (exit.close / entry.open - 1) * 100;
        observations.get(`${fold}|${horizon}`)!.push({
          date: signal.tradeDate,
          symbol: series.symbol,
          score,
          rs20,
          rs60,
          rsAccel,
          ret,
          excess: ret - marketReturn,
          onset8,
        });
      }
    }
  }

  const folds = FOLD_YEARS.flatMap((fold) => HORIZONS.flatMap((horizon) => {
    const rows = observations.get(`${fold}|${horizon}`) ?? [];
    return FEATURES.map((feature) => {
      const quintiles = quintileRows(rows, feature);
      return {
        fold,
        horizon,
        feature,
        observations: rows.length,
        dailySpearmanIcExcess: dailyIc(rows, feature, "excess"),
        dailySpearmanCorrelationWithV8Score: dailyIc(rows, feature, "score"),
        quintiles,
        monotonicityExcess: monotonicity(quintiles),
        q5MinusQ1AvgExcess: spread(quintiles),
        onset8: onsetBreakdown(rows, feature),
      };
    });
  }));

  const aggregates = HORIZONS.flatMap((horizon) => FEATURES.map((feature) => {
    const selected = folds.filter((row) => row.horizon === horizon && row.feature === feature);
    const validIc = selected.map((row) => row.dailySpearmanIcExcess.mean).filter(finite);
    const validScoreCorr = selected.map((row) => row.dailySpearmanCorrelationWithV8Score.mean).filter(finite);
    const validMonotonicity = selected.map((row) => row.monotonicityExcess).filter(finite);
    const validSpread = selected.map((row) => row.q5MinusQ1AvgExcess).filter(finite);
    const validOnsetSpread = selected.map((row) => row.onset8.q5MinusQ1AvgExcess).filter(finite);
    const foldPositiveIc = selected.filter((row) => finite(row.dailySpearmanIcExcess.mean) && row.dailySpearmanIcExcess.mean > 0).length;
    const foldPositiveSpread = selected.filter((row) => finite(row.q5MinusQ1AvgExcess) && row.q5MinusQ1AvgExcess > 0).length;
    const foldPositiveOnsetSpread = selected.filter((row) => finite(row.onset8.q5MinusQ1AvgExcess) && row.onset8.q5MinusQ1AvgExcess > 0).length;

    const quintiles = QUINTILES.map((quintile) => {
      const qRows = selected
        .map((row) => row.quintiles.find((item) => item.quintile === quintile)!)
        .filter((row) => row.count > 0);
      return {
        quintile,
        foldsWithData: qRows.length,
        totalObservations: qRows.reduce((sum, row) => sum + row.count, 0),
        equalWeightAvgExcessReturn: round(average(qRows.map((row) => row.avgExcessReturn).filter(finite))),
        equalWeightMedianExcessReturn: round(average(qRows.map((row) => row.medianExcessReturn).filter(finite))),
        equalWeightExcessWinRate: round(average(qRows.map((row) => row.excessWinRate).filter(finite))),
      };
    });

    return {
      horizon,
      feature,
      foldsWithData: selected.length,
      foldPositiveIc,
      foldPositiveSpread,
      foldPositiveOnsetSpread,
      equalWeightDailyIcExcess: round(average(validIc)),
      equalWeightDailyCorrelationWithV8Score: round(average(validScoreCorr)),
      equalWeightMonotonicityExcess: round(average(validMonotonicity)),
      equalWeightQ5MinusQ1AvgExcess: round(average(validSpread)),
      equalWeightOnsetQ5MinusQ1AvgExcess: round(average(validOnsetSpread)),
      quintiles,
    };
  }));

  const candidateSummary = FEATURES.map((feature) => {
    const rows = aggregates.filter((row) => row.feature === feature);
    return {
      feature,
      meanIcAcrossHorizons: round(average(rows.map((row) => row.equalWeightDailyIcExcess).filter(finite))),
      meanQ5MinusQ1AcrossHorizons: round(average(rows.map((row) => row.equalWeightQ5MinusQ1AvgExcess).filter(finite))),
      meanOnsetQ5MinusQ1AcrossHorizons: round(average(rows.map((row) => row.equalWeightOnsetQ5MinusQ1AvgExcess).filter(finite))),
      meanCorrelationWithV8Score: round(average(rows.map((row) => row.equalWeightDailyCorrelationWithV8Score).filter(finite))),
      positiveIcFoldTests: rows.reduce((sum, row) => sum + row.foldPositiveIc, 0),
      positiveSpreadFoldTests: rows.reduce((sum, row) => sum + row.foldPositiveSpread, 0),
      positiveOnsetSpreadFoldTests: rows.reduce((sum, row) => sum + row.foldPositiveOnsetSpread, 0),
      totalFoldHorizonTests: rows.length * FOLD_YEARS.length,
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
      contextSymbols: context.symbolCount,
      kospiSymbols: kospiSeries.length,
    },
    design: {
      folds: [...FOLD_YEARS],
      horizons: [...HORIZONS],
      features: [...FEATURES],
      definitions: {
        RS20: "stock 20-KOSPI-trading-day close return minus KOSPI return over identical dates",
        RS60: "stock 60-KOSPI-trading-day close return minus KOSPI return over identical dates",
        RS_ACCEL: "RS20 - RS60",
      },
      quintiles: "Daily KOSPI cross-sectional quintiles; Q5 is strongest relative strength.",
      onset8: "Current strict V8 score crosses from <8 to >=8 on signal close.",
      entryExecution: "NEXT_OPEN",
      exitExecution: "HORIZON_CLOSE",
      benchmark: "KOSPI, same entry/exit dates",
      pointInTimeRule: "All RS inputs use data available on or before the signal date only.",
    },
    candidateSummary,
    aggregates,
    folds,
    notes: [
      "This is an explanatory research run only. No production V8 scoring weight or threshold is changed.",
      "Lookback dates are aligned to the KOSPI trading calendar, and the stock must have observations on both aligned dates.",
      "Daily Spearman IC measures cross-sectional ordering power for future KOSPI excess return.",
      "Q5-Q1 spread tests economic separation; the Onset subset tests incremental separation inside existing V8 >=8 entry events.",
      "Correlation with the current V8 score is reported to assess redundancy before assigning any new score weight.",
    ],
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `v8-kospi-relative-strength-3fos-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kospi-relative-strength-3fos/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(client, `${options.userId}/results/v8-kospi-relative-strength-3fos/latest.json`, {
      version: STUDY_VERSION,
      createdAt,
      runId,
      resultPath: remotePath,
      candidateSummary,
      aggregates,
    });
  }

  process.stdout.write(`${JSON.stringify({ outputPath, remotePath, candidateSummary, aggregates }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
