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

const STUDY_VERSION = "CloudTrend V8 KOSPI Relative Quality Stage12 Sector Relative" as const;
const YEARS = Array.from({ length: 10 }, (_, i) => 2017 + i);
const COMPLETE_YEARS = Array.from({ length: 9 }, (_, i) => 2017 + i);
const FOLD_YEARS = [2018, 2022, 2025] as const;
const HORIZONS = [5, 20, 40] as const;
const FEATURES = ["RS_ACCEL", "SECTOR_RS_ACCEL", "SECTOR_REL_RS_ACCEL"] as const;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const MIN_SECTOR_PEERS = 3;
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
interface Seed {
  year: number;
  date: string;
  symbol: string;
  sectorCode: string;
  score: number;
  signalIndex: number;
  seriesIndex: number;
  rsAccel: number;
}
interface Observation {
  year: number;
  horizon: Horizon;
  date: string;
  symbol: string;
  sectorCode: string;
  score: number;
  ret: number;
  indexReturn: number;
  indexExcess: number;
  sectorReturn: number | null;
  sectorExcess: number | null;
  features: FeatureMap;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node --script scripts/run-v8-kospi-relative-quality-stage12-sector-relative.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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
function partialSpearman(x: number[], y: number[], control: number[]) {
  const rxy = spearman(x, y);
  const rxz = spearman(x, control);
  const ryz = spearman(y, control);
  if (!finite(rxy) || !finite(rxz) || !finite(ryz)) return null;
  const denominator = Math.sqrt((1 - rxz * rxz) * (1 - ryz * ryz));
  return denominator > 0 ? (rxy - rxz * ryz) / denominator : null;
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
function alignedRs(
  bars: DailyPrice[],
  dateIndex: Map<string, number>,
  benchmark: ReturnType<typeof benchmarkSeries>,
  signalDate: string,
  lag: number,
) {
  const marketIndex = benchmark.indexByDate.get(signalDate);
  if (marketIndex === undefined || marketIndex < lag) return null;
  const marketNow = benchmark.bars[marketIndex];
  const marketPast = benchmark.bars[marketIndex - lag];
  if (
    !marketNow ||
    !marketPast ||
    !finite(marketNow.close) ||
    !finite(marketPast.close) ||
    marketPast.close <= 0
  )
    return null;
  const stockNowIndex = dateIndex.get(marketNow.tradeDate);
  const stockPastIndex = dateIndex.get(marketPast.tradeDate);
  if (stockNowIndex === undefined || stockPastIndex === undefined) return null;
  const stockNow = bars[stockNowIndex];
  const stockPast = bars[stockPastIndex];
  if (
    !stockNow ||
    !stockPast ||
    !finite(stockNow.close) ||
    !finite(stockPast.close) ||
    stockPast.close <= 0
  )
    return null;
  return (
    (stockNow.close / stockPast.close - 1) * 100 - (marketNow.close / marketPast.close - 1) * 100
  );
}
function byDate<T extends { date: string }>(rows: T[]) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = map.get(row.date) ?? [];
    bucket.push(row);
    map.set(row.date, bucket);
  }
  return map;
}
function evaluate(
  rows: Observation[],
  feature: Feature,
  target: "indexExcess" | "sectorExcess" = "indexExcess",
) {
  const valid = rows.filter((row) => finite(row.features[feature]) && finite(row[target]));
  const xs = valid.map((row) => row.features[feature] as number);
  const ys = valid.map((row) => row[target] as number);
  const sorted = [...valid].sort(
    (a, b) => (a.features[feature] as number) - (b.features[feature] as number),
  );
  const tailCount = Math.floor(sorted.length * 0.3);
  const low = tailCount >= 5 ? sorted.slice(0, tailCount) : [];
  const high = tailCount >= 5 ? sorted.slice(-tailCount) : [];
  const lowValues = low.map((row) => row[target] as number);
  const highValues = high.map((row) => row[target] as number);
  const dailyIc: number[] = [];
  const dailySpread: number[] = [];
  for (const dateRows of byDate(valid).values()) {
    if (dateRows.length < MIN_DAILY_CROSS_SECTION) continue;
    const dateXs = dateRows.map((row) => row.features[feature] as number);
    const dateYs = dateRows.map((row) => row[target] as number);
    const ic = spearman(dateXs, dateYs);
    if (finite(ic)) dailyIc.push(ic);
    const ordered = [...dateRows].sort(
      (a, b) => (a.features[feature] as number) - (b.features[feature] as number),
    );
    const half = Math.floor(ordered.length / 2);
    if (half >= 2) {
      const lower = ordered.slice(0, half).map((row) => row[target] as number);
      const upper = ordered.slice(-half).map((row) => row[target] as number);
      dailySpread.push(average(upper)! - average(lower)!);
    }
  }
  return {
    observations: valid.length,
    spearman: valid.length >= 5 ? round(spearman(xs, ys)) : null,
    top30Count: high.length,
    bottom30Count: low.length,
    top30AvgPct: round(average(highValues)),
    bottom30AvgPct: round(average(lowValues)),
    topBottomSpreadPct:
      high.length && low.length ? round(average(highValues)! - average(lowValues)!) : null,
    topBottomMedianSpreadPct:
      high.length && low.length ? round(median(highValues)! - median(lowValues)!) : null,
    dailyCrossSections: dailyIc.length,
    meanDailySpearman: round(average(dailyIc)),
    positiveDailyIcRatePct: dailyIc.length
      ? round((dailyIc.filter((v) => v > 0).length / dailyIc.length) * 100)
      : null,
    meanDailyTopBottomSpreadPct: round(average(dailySpread)),
    positiveDailySpreadRatePct: dailySpread.length
      ? round((dailySpread.filter((v) => v > 0).length / dailySpread.length) * 100)
      : null,
  };
}
function diagnostics(rows: Observation[]) {
  const valid = rows.filter(
    (row) =>
      finite(row.features.RS_ACCEL) &&
      finite(row.features.SECTOR_REL_RS_ACCEL) &&
      finite(row.indexExcess),
  );
  if (valid.length < 5) return null;
  const raw = valid.map((row) => row.features.RS_ACCEL as number);
  const sectorRelative = valid.map((row) => row.features.SECTOR_REL_RS_ACCEL as number);
  const excess = valid.map((row) => row.indexExcess);
  return {
    observations: valid.length,
    rawVsSectorRelativeSpearman: round(spearman(raw, sectorRelative)),
    rawVsExcessSpearman: round(spearman(raw, excess)),
    sectorRelativeVsExcessSpearman: round(spearman(sectorRelative, excess)),
    sectorRelativePartialSpearmanGivenRaw: round(partialSpearman(sectorRelative, excess, raw)),
    rawPartialSpearmanGivenSectorRelative: round(partialSpearman(raw, excess, sectorRelative)),
  };
}

export async function runStudy() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const dataset = parseManualMarketData(texts).dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const benchmark = benchmarkSeries(dataset);
  const kospiSeries = context.series.filter((series) => series.market === "KOSPI");

  const seeds: Seed[] = [];
  const signalDates = new Set<string>();
  for (let seriesIndex = 0; seriesIndex < kospiSeries.length; seriesIndex++) {
    const series = kospiSeries[seriesIndex]!;
    const scores = series.baseScores.map((base, index) =>
      adjustedScore10(base, series.sectorPriceLeadership[index] ?? null),
    );
    for (let i = 1; i < series.bars.length; i++) {
      const signal = series.bars[i]!;
      const year = Number(signal.tradeDate.slice(0, 4));
      if (!YEARS.includes(year)) continue;
      const score = scores[i];
      const previousScore = scores[i - 1];
      if (
        !finite(score) ||
        !finite(previousScore) ||
        previousScore >= ONSET_THRESHOLD ||
        score < ONSET_THRESHOLD
      )
        continue;
      const rs20 = alignedRs(series.bars, series.dateIndex, benchmark, signal.tradeDate, 20);
      const rs60 = alignedRs(series.bars, series.dateIndex, benchmark, signal.tradeDate, 60);
      if (!finite(rs20) || !finite(rs60)) continue;
      const rsAccel = rs20 - rs60;
      seeds.push({
        year,
        date: signal.tradeDate,
        symbol: series.symbol,
        sectorCode: series.sectorCode,
        score,
        signalIndex: i,
        seriesIndex,
        rsAccel,
      });
      signalDates.add(signal.tradeDate);
    }
  }

  const sectorRsByDate = new Map<string, Map<string, Array<{ symbol: string; value: number }>>>();
  for (const date of signalDates) {
    const sectorMap = new Map<string, Array<{ symbol: string; value: number }>>();
    for (const series of kospiSeries) {
      const rs20 = alignedRs(series.bars, series.dateIndex, benchmark, date, 20);
      const rs60 = alignedRs(series.bars, series.dateIndex, benchmark, date, 60);
      if (!finite(rs20) || !finite(rs60)) continue;
      const bucket = sectorMap.get(series.sectorCode) ?? [];
      bucket.push({ symbol: series.symbol, value: rs20 - rs60 });
      sectorMap.set(series.sectorCode, bucket);
    }
    sectorRsByDate.set(date, sectorMap);
  }

  const futureSectorReturns = new Map<string, Array<{ symbol: string; ret: number }>>();
  for (const date of signalDates) {
    for (const horizon of HORIZONS) {
      for (const series of kospiSeries) {
        const i = series.dateIndex.get(date);
        if (i === undefined) continue;
        const entry = series.bars[i + 1];
        const exit = series.bars[i + horizon];
        if (
          !entry ||
          !exit ||
          !finite(entry.open) ||
          entry.open <= 0 ||
          !finite(exit.close) ||
          exit.close <= 0
        )
          continue;
        const key = `${date}|${horizon}|${series.sectorCode}`;
        const bucket = futureSectorReturns.get(key) ?? [];
        bucket.push({ symbol: series.symbol, ret: (exit.close / entry.open - 1) * 100 });
        futureSectorReturns.set(key, bucket);
      }
    }
  }

  const observations: Observation[] = [];
  let sectorFeatureAvailable = 0;
  for (const seed of seeds) {
    const series = kospiSeries[seed.seriesIndex]!;
    const peerRs = (sectorRsByDate.get(seed.date)?.get(seed.sectorCode) ?? []).filter(
      (item) => item.symbol !== seed.symbol,
    );
    const sectorRsAccel =
      peerRs.length >= MIN_SECTOR_PEERS ? median(peerRs.map((item) => item.value)) : null;
    const sectorRelRsAccel = finite(sectorRsAccel) ? seed.rsAccel - sectorRsAccel : null;
    if (finite(sectorRelRsAccel)) sectorFeatureAvailable++;
    for (const horizon of HORIZONS) {
      const entry = series.bars[seed.signalIndex + 1];
      const exit = series.bars[seed.signalIndex + horizon];
      if (
        !entry ||
        !exit ||
        !finite(entry.open) ||
        entry.open <= 0 ||
        !finite(exit.close) ||
        exit.close <= 0
      )
        continue;
      const indexReturn = benchmarkReturn(benchmark, entry.tradeDate, exit.tradeDate);
      if (!finite(indexReturn)) continue;
      const ret = (exit.close / entry.open - 1) * 100;
      const peerReturns = (
        futureSectorReturns.get(`${seed.date}|${horizon}|${seed.sectorCode}`) ?? []
      ).filter((item) => item.symbol !== seed.symbol);
      const sectorReturn =
        peerReturns.length >= MIN_SECTOR_PEERS
          ? average(peerReturns.map((item) => item.ret))
          : null;
      observations.push({
        year: seed.year,
        horizon,
        date: seed.date,
        symbol: seed.symbol,
        sectorCode: seed.sectorCode,
        score: seed.score,
        ret,
        indexReturn,
        indexExcess: ret - indexReturn,
        sectorReturn,
        sectorExcess: finite(sectorReturn) ? ret - sectorReturn : null,
        features: {
          RS_ACCEL: seed.rsAccel,
          SECTOR_RS_ACCEL: sectorRsAccel,
          SECTOR_REL_RS_ACCEL: sectorRelRsAccel,
        },
      });
    }
  }

  const foldResults = FOLD_YEARS.flatMap((year) =>
    HORIZONS.flatMap((horizon) => {
      const rows = observations.filter((row) => row.year === year && row.horizon === horizon);
      return FEATURES.map((feature) => ({
        year,
        horizon,
        feature,
        indexExcess: evaluate(rows, feature, "indexExcess"),
        sectorExcess: evaluate(rows, feature, "sectorExcess"),
      }));
    }),
  );
  const yearly20 = COMPLETE_YEARS.flatMap((year) => {
    const rows = observations.filter((row) => row.year === year && row.horizon === 20);
    return FEATURES.map((feature) => ({
      year,
      feature,
      indexExcess: evaluate(rows, feature, "indexExcess"),
      sectorExcess: evaluate(rows, feature, "sectorExcess"),
    }));
  });
  const holdoutRows = observations.filter((row) => row.year === 2026 && row.horizon === 20);
  const holdout2026 = FEATURES.map((feature) => ({
    feature,
    indexExcess: evaluate(holdoutRows, feature, "indexExcess"),
    sectorExcess: evaluate(holdoutRows, feature, "sectorExcess"),
  }));

  const candidateSummary = FEATURES.map((feature) => {
    const fold20 = foldResults.filter((row) => row.feature === feature && row.horizon === 20);
    const annual = yearly20.filter((row) => row.feature === feature);
    const holdout = holdout2026.find((row) => row.feature === feature)!;
    return {
      feature,
      threeFos20: {
        indexMeanSpearman: round(
          average(fold20.map((row) => row.indexExcess.spearman).filter(finite)),
        ),
        indexPositiveSpearmanFolds: fold20.filter(
          (row) => finite(row.indexExcess.spearman) && row.indexExcess.spearman > 0,
        ).length,
        indexMeanSpreadPct: round(
          average(fold20.map((row) => row.indexExcess.topBottomSpreadPct).filter(finite)),
        ),
        indexPositiveSpreadFolds: fold20.filter(
          (row) =>
            finite(row.indexExcess.topBottomSpreadPct) && row.indexExcess.topBottomSpreadPct > 0,
        ).length,
        sectorMeanSpearman: round(
          average(fold20.map((row) => row.sectorExcess.spearman).filter(finite)),
        ),
        sectorMeanSpreadPct: round(
          average(fold20.map((row) => row.sectorExcess.topBottomSpreadPct).filter(finite)),
        ),
      },
      yearly2017to2025: {
        positiveIndexSpearmanYears: annual.filter(
          (row) => finite(row.indexExcess.spearman) && row.indexExcess.spearman > 0,
        ).length,
        meanIndexSpearman: round(
          average(annual.map((row) => row.indexExcess.spearman).filter(finite)),
        ),
        positiveIndexSpreadYears: annual.filter(
          (row) =>
            finite(row.indexExcess.topBottomSpreadPct) && row.indexExcess.topBottomSpreadPct > 0,
        ).length,
        meanIndexSpreadPct: round(
          average(annual.map((row) => row.indexExcess.topBottomSpreadPct).filter(finite)),
        ),
      },
      holdout2026: {
        observations: holdout.indexExcess.observations,
        indexSpearman: holdout.indexExcess.spearman,
        indexSpreadPct: holdout.indexExcess.topBottomSpreadPct,
        sectorSpearman: holdout.sectorExcess.spearman,
        sectorSpreadPct: holdout.sectorExcess.topBottomSpreadPct,
      },
      robustness3Fos: [5, 40].map((horizon) => {
        const rows = foldResults.filter(
          (row) => row.feature === feature && row.horizon === horizon,
        );
        return {
          horizon,
          meanIndexSpearman: round(
            average(rows.map((row) => row.indexExcess.spearman).filter(finite)),
          ),
          positiveIndexSpearmanFolds: rows.filter(
            (row) => finite(row.indexExcess.spearman) && row.indexExcess.spearman > 0,
          ).length,
          meanIndexSpreadPct: round(
            average(rows.map((row) => row.indexExcess.topBottomSpreadPct).filter(finite)),
          ),
          positiveIndexSpreadFolds: rows.filter(
            (row) =>
              finite(row.indexExcess.topBottomSpreadPct) && row.indexExcess.topBottomSpreadPct > 0,
          ).length,
        };
      }),
    };
  });

  const diagnosticSummary = {
    threeFos20: FOLD_YEARS.map((year) => ({
      year,
      ...diagnostics(observations.filter((row) => row.year === year && row.horizon === 20)),
    })),
    completeYears20: COMPLETE_YEARS.map((year) => ({
      year,
      ...diagnostics(observations.filter((row) => row.year === year && row.horizon === 20)),
    })),
    holdout2026: diagnostics(holdoutRows),
  };

  const raw = candidateSummary.find((row) => row.feature === "RS_ACCEL")!;
  const sectorRelative = candidateSummary.find((row) => row.feature === "SECTOR_REL_RS_ACCEL")!;
  const decisionComparison = {
    threeFos20MeanIcDelta: round(
      (sectorRelative.threeFos20.indexMeanSpearman ?? 0) - (raw.threeFos20.indexMeanSpearman ?? 0),
    ),
    threeFos20MeanSpreadDeltaPct: round(
      (sectorRelative.threeFos20.indexMeanSpreadPct ?? 0) -
        (raw.threeFos20.indexMeanSpreadPct ?? 0),
    ),
    positiveYearDelta:
      sectorRelative.yearly2017to2025.positiveIndexSpearmanYears -
      raw.yearly2017to2025.positiveIndexSpearmanYears,
    holdout2026IcDelta: round(
      (sectorRelative.holdout2026.indexSpearman ?? 0) - (raw.holdout2026.indexSpearman ?? 0),
    ),
    holdout2026SpreadDeltaPct: round(
      (sectorRelative.holdout2026.indexSpreadPct ?? 0) - (raw.holdout2026.indexSpreadPct ?? 0),
    ),
    rule: "Prefer sector-relative only if it adds repeatable 3-FOS and 2026 holdout separation rather than merely changing one pooled average; otherwise retain raw RSAccel as the final KOSPI Relative Quality feature.",
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
      kospiSymbols: kospiSeries.length,
      onsetSeeds: seeds.length,
      uniqueSignalDates: signalDates.size,
      sectorFeatureAvailable,
      evaluatedRows: observations.length,
    },
    design: {
      objective:
        "Final test of whether within-sector RSAccel adds useful information beyond raw KOSPI-relative RSAccel inside strict V8 8-point KOSPI onset candidates.",
      completeYears: COMPLETE_YEARS,
      threeFosYears: [...FOLD_YEARS],
      holdoutYear: 2026,
      horizons: [...HORIZONS],
      featureDefinitions: {
        RS_ACCEL: "Stock RS20 minus RS60 versus KOSPI, aligned to identical KOSPI trading dates.",
        SECTOR_RS_ACCEL:
          "Leave-one-out median RSAccel of other KOSPI stocks in the same mapped sector on the signal date; requires at least three peers.",
        SECTOR_REL_RS_ACCEL: "Stock RSAccel minus leave-one-out sector median RSAccel.",
      },
      targets: {
        indexExcess:
          "Future stock return minus KOSPI return over identical NEXT_OPEN to horizon-close dates.",
        sectorExcess:
          "Future stock return minus equal-weight return of other KOSPI stocks in the same mapped sector over the same signal date/horizon; evaluation target only.",
      },
      pointInTime:
        "All feature values use only prices observable on or before the signal close. Future sector returns are used only as evaluation targets.",
      selectionRule: decisionComparison.rule,
    },
    candidateSummary,
    decisionComparison,
    diagnosticSummary,
    holdout2026,
    yearly20,
    foldResults,
    notes: [
      "This is the final feature-selection study; it does not modify the V8 10-point technical score.",
      "The sector feature is leave-one-out to prevent a candidate from mechanically contributing to its own sector benchmark.",
      "No sector-relative weight, threshold, or lookback was optimized after seeing Stage12 results.",
    ],
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    `v8-kospi-relative-quality-stage12-sector-relative-${runId}.json`,
  );
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kospi-relative-quality-stage12-sector-relative/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(
      client,
      `${options.userId}/results/v8-kospi-relative-quality-stage12-sector-relative/latest.json`,
      result,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ outputPath, remotePath, candidateSummary, decisionComparison, diagnosticSummary }, null, 2)}\n`,
  );
}

if (process.argv[1]?.endsWith("run-v8-kospi-relative-quality-stage12-sector-relative.ts"))
  runStudy().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
