import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildPortfolioSignalContext } from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { DailyPrice } from "../src/lib/engine/types";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8 KOSPI Relative Quality Stage10 Composite" as const;
const YEARS = Array.from({ length: 10 }, (_, i) => 2017 + i);
const COMPLETE_YEARS = Array.from({ length: 9 }, (_, i) => 2017 + i);
const FOLD_YEARS = [2018, 2022, 2025] as const;
const HORIZONS = [5, 20, 40] as const;
const FEATURES = ["RS_ACCEL", "RESID_ACCEL", "RQ_COMBO_50_50"] as const;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const BETA_LOOKBACK = 120;
const MIN_BETA_PAIRS = 100;
const MIN_DAILY_CROSS_SECTION = 4;

type Horizon = (typeof HORIZONS)[number];
type Feature = (typeof FEATURES)[number];

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
  year: number;
  horizon: Horizon;
  date: string;
  symbol: string;
  score: number;
  ret: number;
  excess: number;
  rsAccel: number;
  residAccel: number;
  combo: number | null;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node scripts/run-v8-kospi-relative-quality-stage10-composite.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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
    if (arg === "--source-manifest")
      options.sourceManifest = argv[++i] ?? usage("--source-manifest 값이 없습니다.");
    else if (arg === "--source-cache-dir")
      options.sourceCacheDir = argv[++i] ?? usage("--source-cache-dir 값이 없습니다.");
    else if (arg === "--supabase-user-id")
      options.userId = argv[++i] ?? usage("--supabase-user-id 값이 없습니다.");
    else if (arg === "--upload") options.upload = true;
    else usage(`지원하지 않는 인자입니다: ${arg}`);
  }
  if (!options.sourceManifest || !options.sourceCacheDir)
    usage("source manifest와 cache dir가 필요합니다.");
  if (options.upload && !/^[0-9a-f-]{36}$/i.test(options.userId ?? ""))
    usage("업로드에는 유효한 Supabase user id가 필요합니다.");
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
function ranks(values: number[]) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const output = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i + 1;
    while (j < indexed.length && indexed[j]!.value === indexed[i]!.value) j++;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) output[indexed[k]!.index] = rank;
    i = j;
  }
  return output;
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
function partialCorrelation(rYX: number | null, rYZ: number | null, rXZ: number | null) {
  if (!finite(rYX) || !finite(rYZ) || !finite(rXZ)) return null;
  const denominator = Math.sqrt((1 - rYZ * rYZ) * (1 - rXZ * rXZ));
  return denominator > 0 ? (rYX - rYZ * rXZ) / denominator : null;
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
  )
    throw new Error("지원하지 않거나 손상된 source cache manifest입니다.");
  const texts: string[] = [];
  for (const file of manifest.files) {
    const bytes = new Uint8Array(await readFile(path.join(cacheDir, file.cacheFile)));
    const fileHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== file.bytes || fileHash !== file.fileHash)
      throw new Error(`source cache 무결성 검증 실패: ${file.fileName}`);
    texts.push(decodeSourceBytes(bytes));
  }
  process.stderr.write(
    `KOSPI Relative Quality stage10 source cache verified: ${manifest.fileCount} files / ${(manifest.totalBytes / 1_000_000).toFixed(1)} MB\n`,
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
function benchmarkReturn(
  benchmark: ReturnType<typeof benchmarkSeries>,
  entryDate: string,
  exitDate: string,
) {
  const entry = benchmark.byDate.get(entryDate);
  const exit = benchmark.byDate.get(exitDate);
  if (!entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exit.close) || exit.close <= 0)
    return null;
  return (exit.close / entry.open - 1) * 100;
}
function adjustedScore10(baseScore9p5: number | null, sectorPriceLeadership: number | null) {
  if (!finite(baseScore9p5)) return null;
  const available = finite(sectorPriceLeadership);
  const overheated = available && sectorPriceLeadership >= SECTOR_OVERHEAT_THRESHOLD;
  return Math.round((baseScore9p5 + (available && !overheated ? SECTOR_SLOT : 0)) * 100) / 100;
}

function beta120(
  bars: DailyPrice[],
  dateIndex: Map<string, number>,
  benchmark: ReturnType<typeof benchmarkSeries>,
  benchmarkIndex: number,
) {
  if (benchmarkIndex < BETA_LOOKBACK) return null;
  const stockReturns: number[] = [];
  const marketReturns: number[] = [];
  for (let i = benchmarkIndex - BETA_LOOKBACK + 1; i <= benchmarkIndex; i++) {
    const marketNow = benchmark.bars[i];
    const marketPrev = benchmark.bars[i - 1];
    if (!marketNow || !marketPrev || !finite(marketNow.close) || !finite(marketPrev.close) || marketPrev.close <= 0)
      continue;
    const stockNowIndex = dateIndex.get(marketNow.tradeDate);
    const stockPrevIndex = dateIndex.get(marketPrev.tradeDate);
    if (stockNowIndex === undefined || stockPrevIndex === undefined) continue;
    const stockNow = bars[stockNowIndex];
    const stockPrev = bars[stockPrevIndex];
    if (!stockNow || !stockPrev || !finite(stockNow.close) || !finite(stockPrev.close) || stockPrev.close <= 0)
      continue;
    stockReturns.push(stockNow.close / stockPrev.close - 1);
    marketReturns.push(marketNow.close / marketPrev.close - 1);
  }
  if (stockReturns.length < MIN_BETA_PAIRS) return null;
  const marketMean = average(marketReturns)!;
  const stockMean = average(stockReturns)!;
  let covariance = 0;
  let marketVariance = 0;
  for (let i = 0; i < stockReturns.length; i++) {
    const dm = marketReturns[i]! - marketMean;
    covariance += (stockReturns[i]! - stockMean) * dm;
    marketVariance += dm * dm;
  }
  return marketVariance > 0 ? covariance / marketVariance : null;
}
function residualMomentum(
  bars: DailyPrice[],
  dateIndex: Map<string, number>,
  benchmark: ReturnType<typeof benchmarkSeries>,
  benchmarkIndex: number,
  beta: number,
  lag: number,
) {
  if (benchmarkIndex < lag) return null;
  const residuals: number[] = [];
  for (let i = benchmarkIndex - lag + 1; i <= benchmarkIndex; i++) {
    const marketNow = benchmark.bars[i];
    const marketPrev = benchmark.bars[i - 1];
    if (!marketNow || !marketPrev || !finite(marketNow.close) || !finite(marketPrev.close) || marketPrev.close <= 0)
      continue;
    const stockNowIndex = dateIndex.get(marketNow.tradeDate);
    const stockPrevIndex = dateIndex.get(marketPrev.tradeDate);
    if (stockNowIndex === undefined || stockPrevIndex === undefined) continue;
    const stockNow = bars[stockNowIndex];
    const stockPrev = bars[stockPrevIndex];
    if (!stockNow || !stockPrev || !finite(stockNow.close) || !finite(stockPrev.close) || stockPrev.close <= 0)
      continue;
    residuals.push(stockNow.close / stockPrev.close - 1 - beta * (marketNow.close / marketPrev.close - 1));
  }
  if (residuals.length < Math.ceil(lag * 0.8)) return null;
  return residuals.reduce((sum, value) => sum + value, 0) * 100;
}
function rawFeatures(
  bars: DailyPrice[],
  dateIndex: Map<string, number>,
  benchmark: ReturnType<typeof benchmarkSeries>,
  signalDate: string,
) {
  const benchmarkIndex = benchmark.indexByDate.get(signalDate);
  if (benchmarkIndex === undefined || benchmarkIndex < BETA_LOOKBACK) return null;
  const marketNow = benchmark.bars[benchmarkIndex];
  const market20 = benchmark.bars[benchmarkIndex - 20];
  const market60 = benchmark.bars[benchmarkIndex - 60];
  if (!marketNow || !market20 || !market60) return null;
  const stockNowIndex = dateIndex.get(marketNow.tradeDate);
  const stock20Index = dateIndex.get(market20.tradeDate);
  const stock60Index = dateIndex.get(market60.tradeDate);
  if (stockNowIndex === undefined || stock20Index === undefined || stock60Index === undefined) return null;
  const stockNow = bars[stockNowIndex];
  const stock20 = bars[stock20Index];
  const stock60 = bars[stock60Index];
  if (
    !stockNow || !stock20 || !stock60 ||
    !finite(stockNow.close) || !finite(stock20.close) || !finite(stock60.close) ||
    stock20.close <= 0 || stock60.close <= 0 || market20.close <= 0 || market60.close <= 0
  ) return null;
  const rs20 = (stockNow.close / stock20.close - 1) * 100 - (marketNow.close / market20.close - 1) * 100;
  const rs60 = (stockNow.close / stock60.close - 1) * 100 - (marketNow.close / market60.close - 1) * 100;
  const beta = beta120(bars, dateIndex, benchmark, benchmarkIndex);
  if (!finite(beta)) return null;
  const resid20 = residualMomentum(bars, dateIndex, benchmark, benchmarkIndex, beta, 20);
  const resid60 = residualMomentum(bars, dateIndex, benchmark, benchmarkIndex, beta, 60);
  if (!finite(resid20) || !finite(resid60)) return null;
  return { rsAccel: rs20 - rs60, residAccel: resid20 - resid60 };
}

function addDailyComposite(rows: Observation[]) {
  const byDate = new Map<string, Observation[]>();
  for (const row of rows) {
    const bucket = byDate.get(row.date) ?? [];
    bucket.push(row);
    byDate.set(row.date, bucket);
  }
  for (const dateRows of byDate.values()) {
    const rsRanks = ranks(dateRows.map((row) => row.rsAccel));
    const residRanks = ranks(dateRows.map((row) => row.residAccel));
    const denominator = Math.max(1, dateRows.length - 1);
    for (let i = 0; i < dateRows.length; i++) {
      const rsPct = dateRows.length === 1 ? 0.5 : (rsRanks[i]! - 1) / denominator;
      const residPct = dateRows.length === 1 ? 0.5 : (residRanks[i]! - 1) / denominator;
      dateRows[i]!.combo = (rsPct + residPct) / 2;
    }
  }
}
function valueOf(row: Observation, feature: Feature) {
  if (feature === "RS_ACCEL") return row.rsAccel;
  if (feature === "RESID_ACCEL") return row.residAccel;
  return row.combo;
}
function evaluate(rows: Observation[], feature: Feature) {
  const valid = rows.filter((row) => finite(valueOf(row, feature)));
  const values = valid.map((row) => valueOf(row, feature) as number);
  const excess = valid.map((row) => row.excess);
  const scores = valid.map((row) => row.score);
  const sorted = [...valid].sort((a, b) => (valueOf(a, feature) as number) - (valueOf(b, feature) as number));
  const tailCount = Math.floor(sorted.length * 0.3);
  const bottom = tailCount >= 5 ? sorted.slice(0, tailCount) : [];
  const top = tailCount >= 5 ? sorted.slice(-tailCount) : [];
  const dailyIc: number[] = [];
  const dailySpread: number[] = [];
  const byDate = new Map<string, Observation[]>();
  for (const row of valid) {
    const bucket = byDate.get(row.date) ?? [];
    bucket.push(row);
    byDate.set(row.date, bucket);
  }
  for (const dateRows of byDate.values()) {
    if (dateRows.length < MIN_DAILY_CROSS_SECTION) continue;
    const ic = spearman(
      dateRows.map((row) => valueOf(row, feature) as number),
      dateRows.map((row) => row.excess),
    );
    if (finite(ic)) dailyIc.push(ic);
    const ordered = [...dateRows].sort((a, b) => (valueOf(a, feature) as number) - (valueOf(b, feature) as number));
    const half = Math.floor(ordered.length / 2);
    if (half >= 2) {
      const low = ordered.slice(0, half);
      const high = ordered.slice(-half);
      dailySpread.push(average(high.map((row) => row.excess))! - average(low.map((row) => row.excess))!);
    }
  }
  return {
    observations: valid.length,
    overallSpearman: round(valid.length >= 5 ? spearman(values, excess) : null),
    correlationWithV8Score: round(valid.length >= 5 ? spearman(values, scores) : null),
    top30AvgExcessPct: round(top.length ? average(top.map((row) => row.excess)) : null),
    bottom30AvgExcessPct: round(bottom.length ? average(bottom.map((row) => row.excess)) : null),
    top30MedianExcessPct: round(top.length ? median(top.map((row) => row.excess)) : null),
    bottom30MedianExcessPct: round(bottom.length ? median(bottom.map((row) => row.excess)) : null),
    topBottomAvgSpreadPct: round(top.length && bottom.length ? average(top.map((row) => row.excess))! - average(bottom.map((row) => row.excess))! : null),
    topBottomMedianSpreadPct: round(top.length && bottom.length ? median(top.map((row) => row.excess))! - median(bottom.map((row) => row.excess))! : null),
    meanDailySpearman: round(average(dailyIc)),
    positiveDailyIcRatePct: dailyIc.length ? round((dailyIc.filter((v) => v > 0).length / dailyIc.length) * 100) : null,
    meanDailyTopBottomSpreadPct: round(average(dailySpread)),
    positiveDailySpreadRatePct: dailySpread.length ? round((dailySpread.filter((v) => v > 0).length / dailySpread.length) * 100) : null,
  };
}
function diagnostics(rows: Observation[]) {
  if (rows.length < 5) return null;
  const rs = rows.map((row) => row.rsAccel);
  const resid = rows.map((row) => row.residAccel);
  const excess = rows.map((row) => row.excess);
  const rRsResid = spearman(rs, resid);
  const rResidY = spearman(resid, excess);
  const rRsY = spearman(rs, excess);
  return {
    observations: rows.length,
    rsResidSpearman: round(rRsResid),
    residVsExcessSpearman: round(rResidY),
    rsVsExcessSpearman: round(rRsY),
    residPartialSpearmanGivenRs: round(partialCorrelation(rResidY, rRsResid, rRsY)),
    rsPartialSpearmanGivenResid: round(partialCorrelation(rRsY, rRsResid, rResidY)),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const dataset = parseManualMarketData(texts).dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const benchmark = benchmarkSeries(dataset);
  const kospiSeries = context.series.filter((series) => series.market === "KOSPI");
  const observations: Observation[] = [];
  let rawOnsets = 0;

  for (const series of kospiSeries) {
    const scores = series.baseScores.map((base, index) => adjustedScore10(base, series.sectorPriceLeadership[index] ?? null));
    for (let i = 1; i + 1 < series.bars.length; i++) {
      const signal = series.bars[i]!;
      const year = Number(signal.tradeDate.slice(0, 4));
      if (!YEARS.includes(year)) continue;
      const score = scores[i];
      const previousScore = scores[i - 1];
      if (!finite(score) || !finite(previousScore) || !(previousScore < ONSET_THRESHOLD && score >= ONSET_THRESHOLD)) continue;
      rawOnsets++;
      const features = rawFeatures(series.bars, series.dateIndex, benchmark, signal.tradeDate);
      if (!features) continue;
      const entry = series.bars[i + 1];
      if (!entry || !finite(entry.open) || entry.open <= 0) continue;
      for (const horizon of HORIZONS) {
        const exit = series.bars[i + horizon];
        if (!exit || !finite(exit.close) || exit.close <= 0) continue;
        const marketReturn = benchmarkReturn(benchmark, entry.tradeDate, exit.tradeDate);
        if (!finite(marketReturn)) continue;
        const ret = (exit.close / entry.open - 1) * 100;
        observations.push({
          year,
          horizon,
          date: signal.tradeDate,
          symbol: series.symbol,
          score,
          ret,
          excess: ret - marketReturn,
          rsAccel: features.rsAccel,
          residAccel: features.residAccel,
          combo: null,
        });
      }
    }
  }

  for (const horizon of HORIZONS) addDailyComposite(observations.filter((row) => row.horizon === horizon));

  const foldResults = FOLD_YEARS.flatMap((year) =>
    HORIZONS.flatMap((horizon) => {
      const rows = observations.filter((row) => row.year === year && row.horizon === horizon);
      return FEATURES.map((feature) => ({ year, horizon, feature, ...evaluate(rows, feature) }));
    }),
  );
  const yearly20 = COMPLETE_YEARS.flatMap((year) => {
    const rows = observations.filter((row) => row.year === year && row.horizon === 20);
    return FEATURES.map((feature) => ({ year, feature, ...evaluate(rows, feature) }));
  });
  const holdoutRows = observations.filter((row) => row.year === 2026 && row.horizon === 20);
  const holdout2026 = FEATURES.map((feature) => ({ feature, ...evaluate(holdoutRows, feature) }));

  const candidateSummary = FEATURES.map((feature) => {
    const folds20 = foldResults.filter((row) => row.feature === feature && row.horizon === 20);
    const annual = yearly20.filter((row) => row.feature === feature);
    const holdout = holdout2026.find((row) => row.feature === feature)!;
    return {
      feature,
      threeFos20: {
        meanSpearman: round(average(folds20.map((row) => row.overallSpearman).filter(finite))),
        positiveSpearmanFolds: folds20.filter((row) => finite(row.overallSpearman) && row.overallSpearman > 0).length,
        meanDailySpearman: round(average(folds20.map((row) => row.meanDailySpearman).filter(finite))),
        meanTopBottomSpreadPct: round(average(folds20.map((row) => row.topBottomAvgSpreadPct).filter(finite))),
        positiveSpreadFolds: folds20.filter((row) => finite(row.topBottomAvgSpreadPct) && row.topBottomAvgSpreadPct > 0).length,
        meanCorrelationWithV8Score: round(average(folds20.map((row) => row.correlationWithV8Score).filter(finite))),
      },
      yearly2017to2025: {
        positiveSpearmanYears: annual.filter((row) => finite(row.overallSpearman) && row.overallSpearman > 0).length,
        meanSpearman: round(average(annual.map((row) => row.overallSpearman).filter(finite))),
        medianSpearman: round(median(annual.map((row) => row.overallSpearman).filter(finite))),
        positiveSpreadYears: annual.filter((row) => finite(row.topBottomAvgSpreadPct) && row.topBottomAvgSpreadPct > 0).length,
        meanTopBottomSpreadPct: round(average(annual.map((row) => row.topBottomAvgSpreadPct).filter(finite))),
        medianTopBottomSpreadPct: round(median(annual.map((row) => row.topBottomAvgSpreadPct).filter(finite))),
      },
      holdout2026: {
        observations: holdout.observations,
        spearman: holdout.overallSpearman,
        topBottomSpreadPct: holdout.topBottomAvgSpreadPct,
        medianSpreadPct: holdout.topBottomMedianSpreadPct,
        meanDailySpearman: holdout.meanDailySpearman,
        correlationWithV8Score: holdout.correlationWithV8Score,
      },
      robustness3Fos: [5, 40].map((horizon) => {
        const rows = foldResults.filter((row) => row.feature === feature && row.horizon === horizon);
        return {
          horizon,
          meanSpearman: round(average(rows.map((row) => row.overallSpearman).filter(finite))),
          positiveSpearmanFolds: rows.filter((row) => finite(row.overallSpearman) && row.overallSpearman > 0).length,
          meanTopBottomSpreadPct: round(average(rows.map((row) => row.topBottomAvgSpreadPct).filter(finite))),
          positiveSpreadFolds: rows.filter((row) => finite(row.topBottomAvgSpreadPct) && row.topBottomAvgSpreadPct > 0).length,
        };
      }),
    };
  });

  const diagnosticSummary = {
    threeFos20: FOLD_YEARS.map((year) => ({ year, ...diagnostics(observations.filter((row) => row.year === year && row.horizon === 20)) })),
    completeYears20: COMPLETE_YEARS.map((year) => ({ year, ...diagnostics(observations.filter((row) => row.year === year && row.horizon === 20)) })),
    holdout2026: diagnostics(holdoutRows),
  };

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
      rawOnsets,
      evaluatedRows: observations.length,
    },
    design: {
      objective: "Test whether beta-adjusted residual acceleration adds information beyond RSAccel and whether a fixed 50:50 daily-rank composite improves KOSPI 8-point onset discrimination.",
      completeYears: COMPLETE_YEARS,
      threeFosYears: [...FOLD_YEARS],
      holdoutYear: 2026,
      horizons: [...HORIZONS],
      features: [...FEATURES],
      composite: "On each signal date, percentile-rank RSAccel and RESID_ACCEL among strict V8 8-point KOSPI onset candidates and average the two ranks 50:50. No weight search is performed.",
      partialCorrelation: "Spearman partial-correlation diagnostic using pairwise rank correlations; used only to test incremental information, not as a production estimator.",
      target: "Future stock return minus KOSPI return over identical NEXT_OPEN to horizon-close dates.",
      pointInTime: "All inputs use information available on or before signal close; execution is NEXT_OPEN.",
    },
    candidateSummary,
    diagnosticSummary,
    holdout2026,
    yearly20,
    foldResults,
    notes: [
      "Stage10 is a fixed-combination validation, not weight optimization.",
      "V8 10-point scoring remains unchanged.",
      "The 2026 period remains a chronological holdout.",
      "If the 50:50 composite does not improve robustness over the stronger single feature, keep the simpler single feature.",
    ],
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `v8-kospi-relative-quality-stage10-composite-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kospi-relative-quality-stage10-composite/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(client, `${options.userId}/results/v8-kospi-relative-quality-stage10-composite/latest.json`, result);
  }
  process.stdout.write(`${JSON.stringify({ outputPath, remotePath, candidateSummary, diagnosticSummary }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
