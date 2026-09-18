import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  parseSharedMarketData as parseManualMarketData,
  loadResearchTexts,
} from "./research-shared-input";
import { buildSharedSignalContext as buildPortfolioSignalContext } from "./research-shared-input";
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { DailyPrice } from "../src/lib/engine/types";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8 KOSPI Relative Quality Stage9" as const;
const YEARS = Array.from({ length: 10 }, (_, i) => 2017 + i);
const COMPLETE_YEARS = Array.from({ length: 9 }, (_, i) => 2017 + i);
const FOLD_YEARS = [2018, 2022, 2025] as const;
const HORIZONS = [5, 20, 40] as const;
const FEATURES = [
  "RS_ACCEL",
  "RESID20",
  "RESID60",
  "RESID_ACCEL",
  "REL_TREND20",
  "REL_MA60_GAP",
  "REL_HIGH120_GAP",
] as const;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const BETA_LOOKBACK = 120;
const MIN_BETA_PAIRS = 100;
const MIN_DAILY_CROSS_SECTION = 4;

type Horizon = (typeof HORIZONS)[number];
type Feature = (typeof FEATURES)[number];

type FeatureMap = Record<Feature, number | null>;

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
  features: FeatureMap;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node --script scripts/run-v8-kospi-relative-quality-stage9.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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
  const indexed = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
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

async function loadCachedTexts(manifestPath: string, cacheDir: string) {
  return loadResearchTexts(manifestPath, cacheDir);
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
  if (
    !entry ||
    !exit ||
    !finite(entry.open) ||
    entry.open <= 0 ||
    !finite(exit.close) ||
    exit.close <= 0
  )
    return null;
  return (exit.close / entry.open - 1) * 100;
}

function adjustedScore10(baseScore9p5: number | null, sectorPriceLeadership: number | null) {
  if (!finite(baseScore9p5)) return null;
  const available = finite(sectorPriceLeadership);
  const overheated = available && sectorPriceLeadership >= SECTOR_OVERHEAT_THRESHOLD;
  return Math.round((baseScore9p5 + (available && !overheated ? SECTOR_SLOT : 0)) * 100) / 100;
}

function relativeRatioAt(
  bars: DailyPrice[],
  dateIndex: Map<string, number>,
  benchmark: ReturnType<typeof benchmarkSeries>,
  benchmarkIndex: number,
) {
  const market = benchmark.bars[benchmarkIndex];
  if (!market || !finite(market.close) || market.close <= 0) return null;
  const stockIndex = dateIndex.get(market.tradeDate);
  if (stockIndex === undefined) return null;
  const stock = bars[stockIndex];
  if (!stock || !finite(stock.close) || stock.close <= 0) return null;
  return stock.close / market.close;
}

function rollingRelativeRatios(
  bars: DailyPrice[],
  dateIndex: Map<string, number>,
  benchmark: ReturnType<typeof benchmarkSeries>,
  benchmarkIndex: number,
  lookback: number,
) {
  if (benchmarkIndex < lookback - 1) return [];
  const values: number[] = [];
  for (let i = benchmarkIndex - lookback + 1; i <= benchmarkIndex; i++) {
    const ratio = relativeRatioAt(bars, dateIndex, benchmark, i);
    if (finite(ratio)) values.push(ratio);
  }
  return values;
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
    if (
      !marketNow ||
      !marketPrev ||
      !finite(marketNow.close) ||
      !finite(marketPrev.close) ||
      marketPrev.close <= 0
    )
      continue;
    const stockNowIndex = dateIndex.get(marketNow.tradeDate);
    const stockPrevIndex = dateIndex.get(marketPrev.tradeDate);
    if (stockNowIndex === undefined || stockPrevIndex === undefined) continue;
    const stockNow = bars[stockNowIndex];
    const stockPrev = bars[stockPrevIndex];
    if (
      !stockNow ||
      !stockPrev ||
      !finite(stockNow.close) ||
      !finite(stockPrev.close) ||
      stockPrev.close <= 0
    )
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
    if (
      !marketNow ||
      !marketPrev ||
      !finite(marketNow.close) ||
      !finite(marketPrev.close) ||
      marketPrev.close <= 0
    )
      continue;
    const stockNowIndex = dateIndex.get(marketNow.tradeDate);
    const stockPrevIndex = dateIndex.get(marketPrev.tradeDate);
    if (stockNowIndex === undefined || stockPrevIndex === undefined) continue;
    const stockNow = bars[stockNowIndex];
    const stockPrev = bars[stockPrevIndex];
    if (
      !stockNow ||
      !stockPrev ||
      !finite(stockNow.close) ||
      !finite(stockPrev.close) ||
      stockPrev.close <= 0
    )
      continue;
    const stockReturn = stockNow.close / stockPrev.close - 1;
    const marketReturn = marketNow.close / marketPrev.close - 1;
    residuals.push(stockReturn - beta * marketReturn);
  }
  if (residuals.length < Math.ceil(lag * 0.8)) return null;
  return residuals.reduce((sum, value) => sum + value, 0) * 100;
}

function relativeFeatures(
  bars: DailyPrice[],
  dateIndex: Map<string, number>,
  benchmark: ReturnType<typeof benchmarkSeries>,
  signalDate: string,
): FeatureMap | null {
  const benchmarkIndex = benchmark.indexByDate.get(signalDate);
  if (benchmarkIndex === undefined || benchmarkIndex < BETA_LOOKBACK) return null;
  const currentRatio = relativeRatioAt(bars, dateIndex, benchmark, benchmarkIndex);
  const past20Ratio = relativeRatioAt(bars, dateIndex, benchmark, benchmarkIndex - 20);
  if (!finite(currentRatio)) return null;

  const beta = beta120(bars, dateIndex, benchmark, benchmarkIndex);
  const resid20 = finite(beta)
    ? residualMomentum(bars, dateIndex, benchmark, benchmarkIndex, beta, 20)
    : null;
  const resid60 = finite(beta)
    ? residualMomentum(bars, dateIndex, benchmark, benchmarkIndex, beta, 60)
    : null;

  const ratios60 = rollingRelativeRatios(bars, dateIndex, benchmark, benchmarkIndex, 60);
  const ratios120 = rollingRelativeRatios(bars, dateIndex, benchmark, benchmarkIndex, 120);
  const relMa60Gap =
    ratios60.length >= 48 && average(ratios60)! > 0
      ? (currentRatio / average(ratios60)! - 1) * 100
      : null;
  const max120 = ratios120.length >= 96 ? Math.max(...ratios120) : null;
  const relHigh120Gap = finite(max120) && max120 > 0 ? (currentRatio / max120 - 1) * 100 : null;
  const relTrend20 =
    finite(past20Ratio) && past20Ratio > 0 ? (currentRatio / past20Ratio - 1) * 100 : null;

  const rs20 = (() => {
    const marketPast = benchmark.bars[benchmarkIndex - 20];
    const marketNow = benchmark.bars[benchmarkIndex];
    const stockPastIndex = marketPast ? dateIndex.get(marketPast.tradeDate) : undefined;
    const stockNowIndex = marketNow ? dateIndex.get(marketNow.tradeDate) : undefined;
    if (
      !marketPast ||
      !marketNow ||
      stockPastIndex === undefined ||
      stockNowIndex === undefined ||
      !finite(marketPast.close) ||
      marketPast.close <= 0 ||
      !finite(marketNow.close)
    )
      return null;
    const stockPast = bars[stockPastIndex];
    const stockNow = bars[stockNowIndex];
    if (
      !stockPast ||
      !stockNow ||
      !finite(stockPast.close) ||
      stockPast.close <= 0 ||
      !finite(stockNow.close)
    )
      return null;
    return (
      (stockNow.close / stockPast.close - 1) * 100 - (marketNow.close / marketPast.close - 1) * 100
    );
  })();
  const rs60 = (() => {
    const marketPast = benchmark.bars[benchmarkIndex - 60];
    const marketNow = benchmark.bars[benchmarkIndex];
    const stockPastIndex = marketPast ? dateIndex.get(marketPast.tradeDate) : undefined;
    const stockNowIndex = marketNow ? dateIndex.get(marketNow.tradeDate) : undefined;
    if (
      !marketPast ||
      !marketNow ||
      stockPastIndex === undefined ||
      stockNowIndex === undefined ||
      !finite(marketPast.close) ||
      marketPast.close <= 0 ||
      !finite(marketNow.close)
    )
      return null;
    const stockPast = bars[stockPastIndex];
    const stockNow = bars[stockNowIndex];
    if (
      !stockPast ||
      !stockNow ||
      !finite(stockPast.close) ||
      stockPast.close <= 0 ||
      !finite(stockNow.close)
    )
      return null;
    return (
      (stockNow.close / stockPast.close - 1) * 100 - (marketNow.close / marketPast.close - 1) * 100
    );
  })();

  return {
    RS_ACCEL: finite(rs20) && finite(rs60) ? rs20 - rs60 : null,
    RESID20: resid20,
    RESID60: resid60,
    RESID_ACCEL: finite(resid20) && finite(resid60) ? resid20 - resid60 : null,
    REL_TREND20: relTrend20,
    REL_MA60_GAP: relMa60Gap,
    REL_HIGH120_GAP: relHigh120Gap,
  };
}

function byDate(rows: Observation[]) {
  const output = new Map<string, Observation[]>();
  for (const row of rows) {
    const bucket = output.get(row.date) ?? [];
    bucket.push(row);
    output.set(row.date, bucket);
  }
  return output;
}

function evaluate(rows: Observation[], feature: Feature) {
  const valid = rows.filter((row) => finite(row.features[feature]));
  const values = valid.map((row) => row.features[feature] as number);
  const excess = valid.map((row) => row.excess);
  const scores = valid.map((row) => row.score);
  const overallSpearman = valid.length >= 5 ? spearman(values, excess) : null;
  const scoreCorrelation = valid.length >= 5 ? spearman(values, scores) : null;

  const sorted = [...valid].sort(
    (a, b) => (a.features[feature] as number) - (b.features[feature] as number),
  );
  const tailCount = Math.floor(sorted.length * 0.3);
  const bottom = tailCount >= 5 ? sorted.slice(0, tailCount) : [];
  const top = tailCount >= 5 ? sorted.slice(-tailCount) : [];
  const pooledSpread =
    top.length && bottom.length
      ? average(top.map((row) => row.excess))! - average(bottom.map((row) => row.excess))!
      : null;
  const pooledMedianSpread =
    top.length && bottom.length
      ? median(top.map((row) => row.excess))! - median(bottom.map((row) => row.excess))!
      : null;

  const dailyIc: number[] = [];
  const dailySpread: number[] = [];
  for (const dateRows of byDate(valid).values()) {
    if (dateRows.length < MIN_DAILY_CROSS_SECTION) continue;
    const dateValues = dateRows.map((row) => row.features[feature] as number);
    const dateExcess = dateRows.map((row) => row.excess);
    const ic = spearman(dateValues, dateExcess);
    if (finite(ic)) dailyIc.push(ic);
    const ordered = [...dateRows].sort(
      (a, b) => (a.features[feature] as number) - (b.features[feature] as number),
    );
    const half = Math.floor(ordered.length / 2);
    if (half >= 2) {
      const low = ordered.slice(0, half);
      const high = ordered.slice(-half);
      dailySpread.push(
        average(high.map((row) => row.excess))! - average(low.map((row) => row.excess))!,
      );
    }
  }

  return {
    observations: valid.length,
    overallSpearman: round(overallSpearman),
    correlationWithV8Score: round(scoreCorrelation),
    top30Count: top.length,
    bottom30Count: bottom.length,
    top30AvgExcessPct: round(top.length ? average(top.map((row) => row.excess)) : null),
    bottom30AvgExcessPct: round(bottom.length ? average(bottom.map((row) => row.excess)) : null),
    top30MedianExcessPct: round(top.length ? median(top.map((row) => row.excess)) : null),
    bottom30MedianExcessPct: round(bottom.length ? median(bottom.map((row) => row.excess)) : null),
    topBottomAvgSpreadPct: round(pooledSpread),
    topBottomMedianSpreadPct: round(pooledMedianSpread),
    dailyCrossSections: dailyIc.length,
    meanDailySpearman: round(average(dailyIc)),
    medianDailySpearman: round(median(dailyIc)),
    positiveDailyIcRatePct: dailyIc.length
      ? round((dailyIc.filter((value) => value > 0).length / dailyIc.length) * 100)
      : null,
    meanDailyTopBottomSpreadPct: round(average(dailySpread)),
    positiveDailySpreadRatePct: dailySpread.length
      ? round((dailySpread.filter((value) => value > 0).length / dailySpread.length) * 100)
      : null,
  };
}

export async function runStudy() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const parsed = parseManualMarketData(texts);
  const dataset = parsed.dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const benchmark = benchmarkSeries(dataset);
  const kospiSeries = context.series.filter((series) => series.market === "KOSPI");

  const observations: Observation[] = [];
  let rawOnsets = 0;
  for (const series of kospiSeries) {
    const scores = series.baseScores.map((base, index) =>
      adjustedScore10(base, series.sectorPriceLeadership[index] ?? null),
    );
    for (let i = 1; i + 1 < series.bars.length; i++) {
      const signal = series.bars[i]!;
      const year = Number(signal.tradeDate.slice(0, 4));
      if (!YEARS.includes(year)) continue;
      const score = scores[i];
      const previousScore = scores[i - 1];
      if (!finite(score) || !finite(previousScore)) continue;
      const onset8 = previousScore < ONSET_THRESHOLD && score >= ONSET_THRESHOLD;
      if (!onset8) continue;
      rawOnsets++;

      const features = relativeFeatures(series.bars, series.dateIndex, benchmark, signal.tradeDate);
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
          features,
        });
      }
    }
  }

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
    const fold20 = foldResults.filter((row) => row.feature === feature && row.horizon === 20);
    const annual = yearly20.filter((row) => row.feature === feature);
    const holdout = holdout2026.find((row) => row.feature === feature)!;
    const robustness = [5, 40].map((horizon) => {
      const rows = foldResults.filter((row) => row.feature === feature && row.horizon === horizon);
      return {
        horizon,
        meanSpearman: round(average(rows.map((row) => row.overallSpearman).filter(finite))),
        positiveSpearmanFolds: rows.filter(
          (row) => finite(row.overallSpearman) && row.overallSpearman > 0,
        ).length,
        meanTopBottomSpreadPct: round(
          average(rows.map((row) => row.topBottomAvgSpreadPct).filter(finite)),
        ),
        positiveSpreadFolds: rows.filter(
          (row) => finite(row.topBottomAvgSpreadPct) && row.topBottomAvgSpreadPct > 0,
        ).length,
      };
    });
    return {
      feature,
      threeFos20: {
        meanSpearman: round(average(fold20.map((row) => row.overallSpearman).filter(finite))),
        positiveSpearmanFolds: fold20.filter(
          (row) => finite(row.overallSpearman) && row.overallSpearman > 0,
        ).length,
        meanDailySpearman: round(
          average(fold20.map((row) => row.meanDailySpearman).filter(finite)),
        ),
        meanTopBottomSpreadPct: round(
          average(fold20.map((row) => row.topBottomAvgSpreadPct).filter(finite)),
        ),
        medianTopBottomSpreadPct: round(
          median(fold20.map((row) => row.topBottomAvgSpreadPct).filter(finite)),
        ),
        positiveSpreadFolds: fold20.filter(
          (row) => finite(row.topBottomAvgSpreadPct) && row.topBottomAvgSpreadPct > 0,
        ).length,
        meanCorrelationWithV8Score: round(
          average(fold20.map((row) => row.correlationWithV8Score).filter(finite)),
        ),
      },
      yearly2017to2025: {
        yearsWithData: annual.filter((row) => row.observations > 0).length,
        positiveSpearmanYears: annual.filter(
          (row) => finite(row.overallSpearman) && row.overallSpearman > 0,
        ).length,
        meanSpearman: round(average(annual.map((row) => row.overallSpearman).filter(finite))),
        medianSpearman: round(median(annual.map((row) => row.overallSpearman).filter(finite))),
        positiveSpreadYears: annual.filter(
          (row) => finite(row.topBottomAvgSpreadPct) && row.topBottomAvgSpreadPct > 0,
        ).length,
        meanTopBottomSpreadPct: round(
          average(annual.map((row) => row.topBottomAvgSpreadPct).filter(finite)),
        ),
        medianTopBottomSpreadPct: round(
          median(annual.map((row) => row.topBottomAvgSpreadPct).filter(finite)),
        ),
      },
      holdout2026: {
        observations: holdout.observations,
        spearman: holdout.overallSpearman,
        topBottomSpreadPct: holdout.topBottomAvgSpreadPct,
        medianSpreadPct: holdout.topBottomMedianSpreadPct,
        meanDailySpearman: holdout.meanDailySpearman,
        correlationWithV8Score: holdout.correlationWithV8Score,
      },
      robustness3Fos: robustness,
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
      rawOnsets,
      evaluatedRows: observations.length,
    },
    design: {
      objective:
        "Find a KOSPI-only relative-quality feature that explains future KOSPI excess return inside existing strict V8 8-point onset candidates, without changing the V8 10-point score.",
      completeYears: COMPLETE_YEARS,
      threeFosYears: [...FOLD_YEARS],
      holdoutYear: 2026,
      horizons: [...HORIZONS],
      features: [...FEATURES],
      featureDefinitions: {
        RS_ACCEL: "Existing baseline: RS20 - RS60 using identical KOSPI trading dates.",
        RESID20:
          "Sum of the last 20 aligned daily stock residual returns after removing beta120 * KOSPI daily return; beta120 is estimated point-in-time from up to 120 prior aligned daily returns with at least 100 pairs.",
        RESID60: "Same beta-adjusted residual momentum over the last 60 KOSPI trading days.",
        RESID_ACCEL: "RESID20 - RESID60; recent idiosyncratic momentum improvement.",
        REL_TREND20: "20-day return of the stock/KOSPI relative-price ratio.",
        REL_MA60_GAP: "Current stock/KOSPI relative-price ratio versus its trailing 60-day mean.",
        REL_HIGH120_GAP:
          "Current stock/KOSPI relative-price ratio versus its trailing 120-day high; values closer to zero are stronger.",
      },
      target:
        "Future stock return minus KOSPI return over identical NEXT_OPEN to horizon-close dates.",
      crossSection:
        "Research is restricted to strict V8 8-point upward onset candidates. Top/bottom spread compares the highest and lowest 30% of each feature within the evaluation period; daily statistics use onset dates with at least four candidates.",
      pointInTime:
        "Every feature uses only data observable on or before the signal close; execution remains NEXT_OPEN.",
      selectionRule:
        "No production feature is selected in this run. Prefer candidates with positive 3-FOS 20D signs, broad 2017-2025 year consistency, low redundancy with V8, and positive 2026 holdout separation.",
    },
    candidateSummary,
    holdout2026,
    yearly20,
    foldResults,
    notes: [
      "This is a feature-screening study, not a production score change.",
      "2026 is treated as a chronological holdout; only onset signals with realized future 20-day outcomes before the dataset end are evaluated.",
      "Residual-momentum beta is not clipped or optimized in Stage9.",
      "The 30% tail threshold, beta lookback 120, and relative-price lookbacks were fixed before inspecting Stage9 outcomes.",
    ],
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `v8-kospi-relative-quality-stage9-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kospi-relative-quality-stage9/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(
      client,
      `${options.userId}/results/v8-kospi-relative-quality-stage9/latest.json`,
      result,
    );
  }

  process.stdout.write(
    `${JSON.stringify({ outputPath, remotePath, candidateSummary, holdout2026 }, null, 2)}\n`,
  );
}

if (process.argv[1]?.endsWith("run-v8-kospi-relative-quality-stage9.ts"))
  runStudy().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
