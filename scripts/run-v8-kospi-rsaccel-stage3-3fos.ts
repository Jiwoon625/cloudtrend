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

const STUDY_VERSION = "CloudTrend V8 KOSPI RSAccel Stage3 3-FOS" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const HORIZONS = [5, 20, 40] as const;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const BONUS_POINTS = 0.5;
const MIN_RANK_IC_CROSS_SECTION = 5;

type FoldYear = (typeof FOLD_YEARS)[number];
type Horizon = (typeof HORIZONS)[number];
type VariantId =
  | "BASELINE_ONSET8"
  | "RANK_TOP50"
  | "RANK_TOP33"
  | "RANK_TOP20"
  | "FILTER_POSITIVE"
  | "FILTER_Q4PLUS"
  | "FILTER_Q5"
  | "BONUS_Q4PLUS"
  | "BONUS_Q5";

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
  prevScore: number | null;
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

interface VariantMetrics extends MetricSummary {
  variant: VariantId;
  deltaAvgExcessVsBaseline: number | null;
  deltaMedianExcessVsBaseline: number | null;
  retentionVsBaselinePct: number | null;
  overlapWithBaseline: number;
  newlyPromoted: number;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node --script scripts/run-v8-kospi-rsaccel-stage3-3fos.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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
    if (arg === "--source-manifest") {
      options.sourceManifest = argv[++i] ?? usage("--source-manifest 값이 없습니다.");
    } else if (arg === "--source-cache-dir") {
      options.sourceCacheDir = argv[++i] ?? usage("--source-cache-dir 값이 없습니다.");
    } else if (arg === "--supabase-user-id") {
      options.userId = argv[++i] ?? usage("--supabase-user-id 값이 없습니다.");
    } else if (arg === "--upload") {
      options.upload = true;
    } else {
      usage(`지원하지 않는 인자입니다: ${arg}`);
    }
  }
  if (!options.sourceManifest || !options.sourceCacheDir) {
    usage("source manifest와 cache dir가 필요합니다.");
  }
  if (options.upload && !/^[0-9a-f-]{36}$/i.test(options.userId ?? "")) {
    usage("업로드에는 유효한 Supabase user id가 필요합니다.");
  }
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

function benchmarkReturn(map: Map<string, DailyPrice>, entryDate: string, exitDate: string) {
  const entry = map.get(entryDate);
  const exit = map.get(exitDate);
  if (
    !entry ||
    !exit ||
    !finite(entry.open) ||
    entry.open <= 0 ||
    !finite(exit.close) ||
    exit.close <= 0
  ) {
    return null;
  }
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
  if (
    !pastBenchmark ||
    !currentBenchmark ||
    !finite(pastBenchmark.close) ||
    !finite(currentBenchmark.close) ||
    pastBenchmark.close <= 0
  ) {
    return null;
  }

  const currentStockIndex = dateIndex.get(signalDate);
  const pastStockIndex = dateIndex.get(pastBenchmark.tradeDate);
  if (currentStockIndex === undefined || pastStockIndex === undefined) return null;
  const currentStock = bars[currentStockIndex];
  const pastStock = bars[pastStockIndex];
  if (
    !currentStock ||
    !pastStock ||
    !finite(currentStock.close) ||
    !finite(pastStock.close) ||
    pastStock.close <= 0
  ) {
    return null;
  }

  const stockReturn = (currentStock.close / pastStock.close - 1) * 100;
  const marketReturn = (currentBenchmark.close / pastBenchmark.close - 1) * 100;
  return stockReturn - marketReturn;
}

function summarize(rows: Observation[]): MetricSummary {
  const returns = rows.map((row) => row.ret);
  const excess = rows.map((row) => row.excess);
  return {
    count: rows.length,
    avgReturn: round(average(returns)),
    medianReturn: round(median(returns)),
    winRate: rows.length
      ? round((returns.filter((value) => value > 0).length / rows.length) * 100)
      : null,
    avgExcessReturn: round(average(excess)),
    medianExcessReturn: round(median(excess)),
    excessWinRate: rows.length
      ? round((excess.filter((value) => value > 0).length / rows.length) * 100)
      : null,
  };
}

function ranks(values: number[]) {
  const indexed = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
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

function dailyMarketQuintiles(rows: Observation[]) {
  const result = new Map<string, 1 | 2 | 3 | 4 | 5>();
  for (const [date, dateRows] of byDate(rows)) {
    if (dateRows.length < 5) continue;
    const rsRanks = ranks(dateRows.map((row) => row.rsAccel));
    for (let i = 0; i < dateRows.length; i++) {
      const rank = rsRanks[i]!;
      const quintile = Math.min(
        5,
        Math.max(1, Math.floor(((rank - 1) * 5) / dateRows.length) + 1),
      ) as 1 | 2 | 3 | 4 | 5;
      result.set(`${date}|${dateRows[i]!.symbol}`, quintile);
    }
  }
  return result;
}

function dailyOnsetRankIc(rows: Observation[]) {
  const values: number[] = [];
  for (const dateRows of byDate(rows.filter((row) => row.onset8)).values()) {
    if (dateRows.length < MIN_RANK_IC_CROSS_SECTION) continue;
    const ic = spearman(
      dateRows.map((row) => row.rsAccel),
      dateRows.map((row) => row.excess),
    );
    if (finite(ic)) values.push(ic);
  }
  return {
    dates: values.length,
    mean: round(average(values)),
    median: round(median(values)),
    positiveRate: values.length
      ? round((values.filter((value) => value > 0).length / values.length) * 100)
      : null,
  };
}

function selectTopFractionOnset(rows: Observation[], fraction: number) {
  const selected: Observation[] = [];
  for (const dateRows of byDate(rows.filter((row) => row.onset8)).values()) {
    const sorted = [...dateRows].sort((a, b) => b.rsAccel - a.rsAccel);
    const count = Math.max(1, Math.ceil(sorted.length * fraction));
    selected.push(...sorted.slice(0, count));
  }
  return selected;
}

function subsetBaselineByMarketRule(
  rows: Observation[],
  qMap: Map<string, 1 | 2 | 3 | 4 | 5>,
  rule: "POSITIVE" | "Q4PLUS" | "Q5",
) {
  return rows.filter((row) => {
    if (!row.onset8) return false;
    if (rule === "POSITIVE") return row.rsAccel > 0;
    const q = qMap.get(`${row.date}|${row.symbol}`);
    if (!q) return false;
    return rule === "Q4PLUS" ? q >= 4 : q === 5;
  });
}

function bonusQualified(
  row: Observation,
  qMap: Map<string, 1 | 2 | 3 | 4 | 5>,
  rule: "Q4PLUS" | "Q5",
) {
  const q = qMap.get(`${row.date}|${row.symbol}`);
  if (!q) return false;
  return rule === "Q4PLUS" ? q >= 4 : q === 5;
}

function buildBonusOnsets(
  rows: Observation[],
  qMap: Map<string, 1 | 2 | 3 | 4 | 5>,
  rule: "Q4PLUS" | "Q5",
) {
  const bySymbol = new Map<string, Observation[]>();
  for (const row of rows) {
    const bucket = bySymbol.get(row.symbol) ?? [];
    bucket.push(row);
    bySymbol.set(row.symbol, bucket);
  }

  const selected: Observation[] = [];
  for (const symbolRows of bySymbol.values()) {
    symbolRows.sort((a, b) => a.date.localeCompare(b.date));
    let prevAdjusted: number | null = null;
    for (const row of symbolRows) {
      const bonus = bonusQualified(row, qMap, rule) ? BONUS_POINTS : 0;
      const adjusted = Math.min(10, row.score + bonus);
      if (finite(prevAdjusted) && prevAdjusted < ONSET_THRESHOLD && adjusted >= ONSET_THRESHOLD) {
        selected.push(row);
      }
      prevAdjusted = adjusted;
    }
  }
  return selected;
}

function rowKey(row: Observation) {
  return `${row.date}|${row.symbol}`;
}

function variantMetrics(
  variant: VariantId,
  selected: Observation[],
  baseline: Observation[],
): VariantMetrics {
  const summary = summarize(selected);
  const baselineSummary = summarize(baseline);
  const baselineKeys = new Set(baseline.map(rowKey));
  const overlapWithBaseline = selected.filter((row) => baselineKeys.has(rowKey(row))).length;
  const newlyPromoted = selected.length - overlapWithBaseline;
  return {
    variant,
    ...summary,
    deltaAvgExcessVsBaseline:
      finite(summary.avgExcessReturn) && finite(baselineSummary.avgExcessReturn)
        ? round(summary.avgExcessReturn - baselineSummary.avgExcessReturn)
        : null,
    deltaMedianExcessVsBaseline:
      finite(summary.medianExcessReturn) && finite(baselineSummary.medianExcessReturn)
        ? round(summary.medianExcessReturn - baselineSummary.medianExcessReturn)
        : null,
    retentionVsBaselinePct: baseline.length
      ? round((selected.length / baseline.length) * 100)
      : null,
    overlapWithBaseline,
    newlyPromoted,
  };
}

export async function runStudy() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const parsed = parseManualMarketData(texts);
  const dataset = parsed.dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const benchmark = benchmarkSeries(dataset);

  const observations = new Map<string, Observation[]>();
  for (const fold of FOLD_YEARS) {
    for (const horizon of HORIZONS) observations.set(`${fold}|${horizon}`, []);
  }

  const kospiSeries = context.series.filter((series) => series.market === "KOSPI");
  for (const series of kospiSeries) {
    const scores = series.baseScores.map((base, index) =>
      adjustedScore10(base, series.sectorPriceLeadership[index] ?? null),
    );
    const dateIndex = new Map(series.bars.map((bar, index) => [bar.tradeDate, index]));

    for (let i = 1; i + 1 < series.bars.length; i++) {
      const signal = series.bars[i]!;
      const fold = Number(signal.tradeDate.slice(0, 4));
      if (!FOLD_YEARS.includes(fold as FoldYear)) continue;
      const score = scores[i];
      if (!finite(score)) continue;

      const rs20 = alignedRelativeStrength(series.bars, dateIndex, signal.tradeDate, benchmark, 20);
      const rs60 = alignedRelativeStrength(series.bars, dateIndex, signal.tradeDate, benchmark, 60);
      if (!finite(rs20) || !finite(rs60)) continue;
      const rsAccel = rs20 - rs60;

      const entry = series.bars[i + 1];
      if (!entry || !finite(entry.open) || entry.open <= 0) continue;
      const prevScore = scores[i - 1];
      const onset8 = finite(prevScore) && prevScore < ONSET_THRESHOLD && score >= ONSET_THRESHOLD;

      for (const horizon of HORIZONS) {
        const exit = series.bars[i + horizon];
        if (!exit || !finite(exit.close) || exit.close <= 0) continue;
        const benchmarkRet = benchmarkReturn(benchmark.byDate, entry.tradeDate, exit.tradeDate);
        if (!finite(benchmarkRet)) continue;
        const ret = (exit.close / entry.open - 1) * 100;
        observations.get(`${fold}|${horizon}`)!.push({
          date: signal.tradeDate,
          symbol: series.symbol,
          score,
          prevScore: finite(prevScore) ? prevScore : null,
          rs20,
          rs60,
          rsAccel,
          ret,
          excess: ret - benchmarkRet,
          onset8,
        });
      }
    }
  }

  const foldResults = FOLD_YEARS.flatMap((fold) =>
    HORIZONS.map((horizon) => {
      const rows = observations.get(`${fold}|${horizon}`) ?? [];
      const baseline = rows.filter((row) => row.onset8);
      const qMap = dailyMarketQuintiles(rows);
      const variants: VariantMetrics[] = [
        variantMetrics("BASELINE_ONSET8", baseline, baseline),
        variantMetrics("RANK_TOP50", selectTopFractionOnset(rows, 0.5), baseline),
        variantMetrics("RANK_TOP33", selectTopFractionOnset(rows, 1 / 3), baseline),
        variantMetrics("RANK_TOP20", selectTopFractionOnset(rows, 0.2), baseline),
        variantMetrics(
          "FILTER_POSITIVE",
          subsetBaselineByMarketRule(rows, qMap, "POSITIVE"),
          baseline,
        ),
        variantMetrics("FILTER_Q4PLUS", subsetBaselineByMarketRule(rows, qMap, "Q4PLUS"), baseline),
        variantMetrics("FILTER_Q5", subsetBaselineByMarketRule(rows, qMap, "Q5"), baseline),
        variantMetrics("BONUS_Q4PLUS", buildBonusOnsets(rows, qMap, "Q4PLUS"), baseline),
        variantMetrics("BONUS_Q5", buildBonusOnsets(rows, qMap, "Q5"), baseline),
      ];
      return {
        fold,
        horizon,
        onsetRankIc: dailyOnsetRankIc(rows),
        variants,
      };
    }),
  );

  const variantIds = [...new Set(foldResults.flatMap((row) => row.variants.map((v) => v.variant)))];
  const aggregates = HORIZONS.flatMap((horizon) =>
    variantIds.map((variant) => {
      const rows = foldResults
        .filter((row) => row.horizon === horizon)
        .map((row) => row.variants.find((item) => item.variant === variant)!)
        .filter(Boolean);
      return {
        horizon,
        variant,
        foldsWithData: rows.filter((row) => row.count > 0).length,
        totalSignals: rows.reduce((sum, row) => sum + row.count, 0),
        equalWeightAvgReturn: round(average(rows.map((row) => row.avgReturn).filter(finite))),
        equalWeightMedianReturn: round(average(rows.map((row) => row.medianReturn).filter(finite))),
        equalWeightWinRate: round(average(rows.map((row) => row.winRate).filter(finite))),
        equalWeightAvgExcessReturn: round(
          average(rows.map((row) => row.avgExcessReturn).filter(finite)),
        ),
        equalWeightMedianExcessReturn: round(
          average(rows.map((row) => row.medianExcessReturn).filter(finite)),
        ),
        equalWeightExcessWinRate: round(
          average(rows.map((row) => row.excessWinRate).filter(finite)),
        ),
        equalWeightDeltaAvgExcessVsBaseline: round(
          average(rows.map((row) => row.deltaAvgExcessVsBaseline).filter(finite)),
        ),
        equalWeightDeltaMedianExcessVsBaseline: round(
          average(rows.map((row) => row.deltaMedianExcessVsBaseline).filter(finite)),
        ),
        positiveDeltaAvgExcessFolds: rows.filter(
          (row) => finite(row.deltaAvgExcessVsBaseline) && row.deltaAvgExcessVsBaseline > 0,
        ).length,
        averageRetentionVsBaselinePct: round(
          average(rows.map((row) => row.retentionVsBaselinePct).filter(finite)),
        ),
        overlapWithBaseline: rows.reduce((sum, row) => sum + row.overlapWithBaseline, 0),
        newlyPromoted: rows.reduce((sum, row) => sum + row.newlyPromoted, 0),
      };
    }),
  );

  const rankIcAggregates = HORIZONS.map((horizon) => {
    const rows = foldResults.filter((row) => row.horizon === horizon);
    return {
      horizon,
      meanOnsetRankIc: round(average(rows.map((row) => row.onsetRankIc.mean).filter(finite))),
      meanPositiveRate: round(
        average(rows.map((row) => row.onsetRankIc.positiveRate).filter(finite)),
      ),
      totalDates: rows.reduce((sum, row) => sum + row.onsetRankIc.dates, 0),
    };
  });

  const stage3Summary = variantIds.map((variant) => {
    const rows = aggregates.filter((row) => row.variant === variant && row.horizon !== 5);
    const h20 = aggregates.find((row) => row.variant === variant && row.horizon === 20);
    return {
      variant,
      avgDeltaExcess20D: h20?.equalWeightDeltaAvgExcessVsBaseline ?? null,
      medianDeltaExcess20D: h20?.equalWeightDeltaMedianExcessVsBaseline ?? null,
      positiveFolds20D: h20?.positiveDeltaAvgExcessFolds ?? 0,
      totalSignals20D: h20?.totalSignals ?? 0,
      averageRetention20D: h20?.averageRetentionVsBaselinePct ?? null,
      newlyPromoted20D: h20?.newlyPromoted ?? 0,
      meanDeltaAcross20D40D: round(
        average(rows.map((row) => row.equalWeightDeltaAvgExcessVsBaseline).filter(finite)),
      ),
    };
  });

  const now = new Date();
  const runId = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const result = {
    studyVersion: STUDY_VERSION,
    generatedAt: now.toISOString(),
    dataset: {
      datasetVersion: dataset.datasetVersion,
      asOfDate: dataset.asOfDate,
      sourceCacheKey: manifest.cacheKey,
      sourceFileCount: manifest.fileCount,
      sourceTotalBytes: manifest.totalBytes,
      contextSymbols: context.series.length,
      kospiSymbols: kospiSeries.length,
      kospiBenchmarkBars: benchmark.bars.length,
    },
    methodology: {
      folds: FOLD_YEARS,
      horizons: HORIZONS,
      signal: "strict V8 score 8-point upward onset",
      entry: "next trading-day open",
      exit: "horizon close",
      target: "stock return minus KOSPI return over identical entry/exit dates",
      rs20: "stock 20 KOSPI-trading-day close return minus KOSPI return",
      rs60: "stock 60 KOSPI-trading-day close return minus KOSPI return",
      rsAccel: "RS20 - RS60",
      rank: "rank only existing 8-point onset candidates by RSAccel each date",
      filter: "retain existing onset signals by RSAccel > 0 or market-wide daily RSAccel quintile",
      bonus:
        "+0.5 point when market-wide RSAccel is Q4+ or Q5, capped at 10; recompute 8-point onset",
    },
    rankIcAggregates,
    aggregates,
    stage3Summary,
    folds: foldResults,
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `v8-kospi-rsaccel-stage3-3fos-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kospi-rsaccel-stage3-3fos/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(
      client,
      `${options.userId}/results/v8-kospi-rsaccel-stage3-3fos/latest.json`,
      result,
    );
  }

  process.stdout.write(
    `${JSON.stringify({ outputPath, remotePath, rankIcAggregates, stage3Summary }, null, 2)}\n`,
  );
}

if (process.argv[1]?.endsWith("run-v8-kospi-rsaccel-stage3-3fos.ts"))
  runStudy().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
