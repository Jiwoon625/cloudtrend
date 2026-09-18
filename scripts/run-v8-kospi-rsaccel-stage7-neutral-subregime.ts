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

const STUDY_VERSION = "CloudTrend V8 KOSPI RSAccel Stage7 Neutral Subregime" as const;
const YEARS = Array.from({ length: 10 }, (_, i) => 2017 + i);
const COMPLETE_YEARS = Array.from({ length: 9 }, (_, i) => 2017 + i);
const HORIZON = 20;
const COST_BPS = 20;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const MA_LOOKBACK = 120;
const RETURN_LOOKBACK = 60;
const TRANSITION_LOOKBACK = 20;
const BULL_RETURN_THRESHOLD = 5;
const BEAR_RETURN_THRESHOLD = -5;

type Regime = "BULL" | "NEUTRAL" | "BEAR";
type NeutralSubregime =
  "UP_TRANSITION_20D" | "ABOVE_MA_STABLE" | "DOWN_TRANSITION_20D" | "BELOW_MA_STABLE";
type StrategyId = "BASELINE_ONSET8" | "FILTER_POSITIVE" | "FILTER_Q4PLUS";

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
  onset8: boolean;
  signalIndex: number;
  regime: Regime;
  neutralSubregime: NeutralSubregime | null;
}
interface Trade {
  year: number;
  regime: Regime;
  neutralSubregime: NeutralSubregime | null;
  strategy: StrategyId;
  symbol: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  grossReturnPct: number;
  benchmarkReturnPct: number;
  netReturnPct: number;
  netExcessPct: number;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node scripts/run-v8-kospi-rsaccel-stage7-neutral-subregime.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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
const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
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

function adjustedScore10(baseScore9p5: number | null, sectorPriceLeadership: number | null) {
  if (!finite(baseScore9p5)) return null;
  const available = finite(sectorPriceLeadership);
  const overheated = available && sectorPriceLeadership >= SECTOR_OVERHEAT_THRESHOLD;
  return Math.round((baseScore9p5 + (available && !overheated ? SECTOR_SLOT : 0)) * 100) / 100;
}

function smaAt(bars: { close: number }[], index: number, lookback: number) {
  if (index < lookback - 1) return null;
  const window = bars.slice(index - lookback + 1, index + 1);
  if (window.length !== lookback || window.some((bar) => !finite(bar.close))) return null;
  return window.reduce((sum, bar) => sum + bar.close, 0) / lookback;
}

function marketStateAt(index: number, benchmark: ReturnType<typeof benchmarkSeries>) {
  if (index < Math.max(MA_LOOKBACK - 1, RETURN_LOOKBACK)) return null;
  const current = benchmark.bars[index];
  const past = benchmark.bars[index - RETURN_LOOKBACK];
  if (!current || !past || !finite(current.close) || !finite(past.close) || past.close <= 0)
    return null;
  const ma120 = smaAt(benchmark.bars, index, MA_LOOKBACK);
  if (!finite(ma120)) return null;
  const return60 = (current.close / past.close - 1) * 100;
  const aboveMa = current.close > ma120;
  let regime: Regime = "NEUTRAL";
  if (aboveMa && return60 > BULL_RETURN_THRESHOLD) regime = "BULL";
  else if (!aboveMa && return60 < BEAR_RETURN_THRESHOLD) regime = "BEAR";
  return { ma120, return60, aboveMa, regime };
}

function neutralSubregimeAt(index: number, benchmark: ReturnType<typeof benchmarkSeries>) {
  const current = marketStateAt(index, benchmark);
  if (!current || current.regime !== "NEUTRAL") return null;
  const previousIndex = index - TRANSITION_LOOKBACK;
  if (previousIndex < MA_LOOKBACK - 1) return null;
  const previous = benchmark.bars[previousIndex];
  const previousMa = smaAt(benchmark.bars, previousIndex, MA_LOOKBACK);
  if (!previous || !finite(previous.close) || !finite(previousMa)) return null;
  const previousAbove = previous.close > previousMa;
  if (current.aboveMa && !previousAbove) return "UP_TRANSITION_20D" as const;
  if (!current.aboveMa && previousAbove) return "DOWN_TRANSITION_20D" as const;
  return current.aboveMa ? ("ABOVE_MA_STABLE" as const) : ("BELOW_MA_STABLE" as const);
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
  const previousBenchmark = benchmark.bars[benchmarkIndex - lag];
  const currentBenchmark = benchmark.bars[benchmarkIndex];
  if (
    !previousBenchmark ||
    !currentBenchmark ||
    !finite(previousBenchmark.close) ||
    !finite(currentBenchmark.close) ||
    previousBenchmark.close <= 0
  )
    return null;
  const currentIndex = dateIndex.get(signalDate);
  const previousIndex = dateIndex.get(previousBenchmark.tradeDate);
  if (currentIndex === undefined || previousIndex === undefined) return null;
  const currentStock = bars[currentIndex];
  const previousStock = bars[previousIndex];
  if (
    !currentStock ||
    !previousStock ||
    !finite(currentStock.close) ||
    !finite(previousStock.close) ||
    previousStock.close <= 0
  )
    return null;
  return (
    (currentStock.close / previousStock.close - 1) * 100 -
    (currentBenchmark.close / previousBenchmark.close - 1) * 100
  );
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

function dailyQuintiles(rows: Observation[]) {
  const byDate = new Map<string, Observation[]>();
  for (const row of rows) {
    const bucket = byDate.get(row.date) ?? [];
    bucket.push(row);
    byDate.set(row.date, bucket);
  }
  const quintiles = new Map<string, 1 | 2 | 3 | 4 | 5>();
  for (const [date, dateRows] of byDate) {
    if (dateRows.length < 5) continue;
    const rowRanks = ranks(dateRows.map((row) => row.rsAccel));
    for (let i = 0; i < dateRows.length; i++) {
      const quintile = Math.min(
        5,
        Math.max(1, Math.floor(((rowRanks[i]! - 1) * 5) / dateRows.length) + 1),
      ) as 1 | 2 | 3 | 4 | 5;
      quintiles.set(`${date}|${dateRows[i]!.symbol}`, quintile);
    }
  }
  return quintiles;
}

function select(
  strategy: StrategyId,
  rows: Observation[],
  quintiles: Map<string, 1 | 2 | 3 | 4 | 5>,
) {
  if (strategy === "BASELINE_ONSET8") return rows.filter((row) => row.onset8);
  if (strategy === "FILTER_POSITIVE") return rows.filter((row) => row.onset8 && row.rsAccel > 0);
  return rows.filter((row) => row.onset8 && (quintiles.get(`${row.date}|${row.symbol}`) ?? 0) >= 4);
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

function buildTradesForYear(
  year: number,
  strategy: StrategyId,
  rows: Observation[],
  quintiles: Map<string, 1 | 2 | 3 | 4 | 5>,
  seriesBySymbol: Map<string, { bars: DailyPrice[] }>,
  benchmark: ReturnType<typeof benchmarkSeries>,
) {
  const candidates: Trade[] = [];
  for (const signal of select(strategy, rows, quintiles)) {
    const series = seriesBySymbol.get(signal.symbol);
    if (!series) continue;
    const entry = series.bars[signal.signalIndex + 1];
    const exit = series.bars[signal.signalIndex + HORIZON];
    if (
      !entry ||
      !exit ||
      !finite(entry.open) ||
      entry.open <= 0 ||
      !finite(exit.close) ||
      exit.close <= 0
    )
      continue;
    const benchmarkPct = benchmarkReturn(benchmark, entry.tradeDate, exit.tradeDate);
    if (!finite(benchmarkPct)) continue;
    const gross = (exit.close / entry.open - 1) * 100;
    candidates.push({
      year,
      regime: signal.regime,
      neutralSubregime: signal.neutralSubregime,
      strategy,
      symbol: signal.symbol,
      signalDate: signal.date,
      entryDate: entry.tradeDate,
      exitDate: exit.tradeDate,
      grossReturnPct: gross,
      benchmarkReturnPct: benchmarkPct,
      netReturnPct: gross - COST_BPS / 100,
      netExcessPct: gross - benchmarkPct - COST_BPS / 100,
    });
  }
  candidates.sort(
    (a, b) => a.entryDate.localeCompare(b.entryDate) || a.symbol.localeCompare(b.symbol),
  );
  const accepted: Trade[] = [];
  const heldUntil = new Map<string, string>();
  for (const trade of candidates) {
    const previousExit = heldUntil.get(trade.symbol);
    if (previousExit && trade.entryDate <= previousExit) continue;
    accepted.push(trade);
    heldUntil.set(trade.symbol, trade.exitDate);
  }
  return accepted;
}

function summarize(trades: Trade[]) {
  const returns = trades.map((trade) => trade.netReturnPct);
  const excess = trades.map((trade) => trade.netExcessPct);
  return {
    trades: trades.length,
    avgReturnPct: round(average(returns)),
    medianReturnPct: round(median(returns)),
    winRatePct: trades.length
      ? round((returns.filter((value) => value > 0).length / trades.length) * 100)
      : null,
    avgExcessPct: round(average(excess)),
    medianExcessPct: round(median(excess)),
    excessWinRatePct: trades.length
      ? round((excess.filter((value) => value > 0).length / trades.length) * 100)
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
  const kospi = context.series.filter((series) => series.market === "KOSPI");
  const observations: Observation[] = [];
  const seriesBySymbol = new Map<string, { bars: DailyPrice[] }>();

  for (const series of kospi) {
    const scores = series.baseScores.map((base, index) =>
      adjustedScore10(base, series.sectorPriceLeadership[index] ?? null),
    );
    const dateIndex = new Map(series.bars.map((bar, index) => [bar.tradeDate, index]));
    seriesBySymbol.set(series.symbol, { bars: series.bars });
    for (let i = 1; i + HORIZON < series.bars.length; i++) {
      const bar = series.bars[i]!;
      const year = Number(bar.tradeDate.slice(0, 4));
      if (!YEARS.includes(year)) continue;
      const benchmarkIndex = benchmark.indexByDate.get(bar.tradeDate);
      if (benchmarkIndex === undefined) continue;
      const marketState = marketStateAt(benchmarkIndex, benchmark);
      if (!marketState) continue;
      const score = scores[i];
      const previousScore = scores[i - 1];
      if (!finite(score)) continue;
      const rs20 = alignedRelativeStrength(series.bars, dateIndex, bar.tradeDate, benchmark, 20);
      const rs60 = alignedRelativeStrength(series.bars, dateIndex, bar.tradeDate, benchmark, 60);
      if (!finite(rs20) || !finite(rs60)) continue;
      observations.push({
        date: bar.tradeDate,
        symbol: series.symbol,
        score,
        rs20,
        rs60,
        rsAccel: rs20 - rs60,
        onset8:
          finite(previousScore) && previousScore < ONSET_THRESHOLD && score >= ONSET_THRESHOLD,
        signalIndex: i,
        regime: marketState.regime,
        neutralSubregime:
          marketState.regime === "NEUTRAL" ? neutralSubregimeAt(benchmarkIndex, benchmark) : null,
      });
    }
  }

  const quintiles = dailyQuintiles(observations);
  const strategies: StrategyId[] = ["BASELINE_ONSET8", "FILTER_POSITIVE", "FILTER_Q4PLUS"];
  const subregimes: NeutralSubregime[] = [
    "UP_TRANSITION_20D",
    "ABOVE_MA_STABLE",
    "DOWN_TRANSITION_20D",
    "BELOW_MA_STABLE",
  ];
  const tradesByYearStrategy = new Map<string, Trade[]>();
  for (const year of YEARS) {
    const yearRows = observations.filter((row) => Number(row.date.slice(0, 4)) === year);
    for (const strategy of strategies) {
      tradesByYearStrategy.set(
        `${year}|${strategy}`,
        buildTradesForYear(year, strategy, yearRows, quintiles, seriesBySymbol, benchmark),
      );
    }
  }

  const yearly = YEARS.flatMap((year) =>
    subregimes.flatMap((subregime) =>
      strategies.map((strategy) => {
        const trades = (tradesByYearStrategy.get(`${year}|${strategy}`) ?? []).filter(
          (trade) => trade.regime === "NEUTRAL" && trade.neutralSubregime === subregime,
        );
        return { year, subregime, strategy, ...summarize(trades) };
      }),
    ),
  );

  const buildRobustness = (years: number[]) =>
    subregimes.flatMap((subregime) =>
      strategies.map((strategy) => {
        const rows = yearly.filter(
          (row) =>
            years.includes(row.year) &&
            row.subregime === subregime &&
            row.strategy === strategy &&
            row.trades > 0,
        );
        const baselineByYear = new Map(
          yearly
            .filter(
              (row) =>
                years.includes(row.year) &&
                row.subregime === subregime &&
                row.strategy === "BASELINE_ONSET8" &&
                row.trades > 0,
            )
            .map((row) => [row.year, row.avgExcessPct]),
        );
        const deltas = rows
          .filter((row) => finite(row.avgExcessPct) && finite(baselineByYear.get(row.year)))
          .map((row) => row.avgExcessPct! - baselineByYear.get(row.year)!);
        const pooledTrades = years.flatMap((year) =>
          (tradesByYearStrategy.get(`${year}|${strategy}`) ?? []).filter(
            (trade) => trade.regime === "NEUTRAL" && trade.neutralSubregime === subregime,
          ),
        );
        const tradeCounts = rows.map((row) => row.trades);
        return {
          subregime,
          strategy,
          yearsWithTrades: rows.length,
          totalTrades: pooledTrades.length,
          minYearTrades: tradeCounts.length ? Math.min(...tradeCounts) : 0,
          medianYearTrades: round(median(tradeCounts)),
          meanYearAvgExcessPct: round(average(rows.map((row) => row.avgExcessPct).filter(finite))),
          medianYearAvgExcessPct: round(median(rows.map((row) => row.avgExcessPct).filter(finite))),
          pooledAvgExcessPct: round(average(pooledTrades.map((trade) => trade.netExcessPct))),
          positiveExcessYears: rows.filter(
            (row) => finite(row.avgExcessPct) && row.avgExcessPct! > 0,
          ).length,
          positiveDeltaYears:
            strategy === "BASELINE_ONSET8" ? null : deltas.filter((value) => value > 0).length,
          meanDeltaVsBaselinePct: strategy === "BASELINE_ONSET8" ? 0 : round(average(deltas)),
          medianDeltaVsBaselinePct: strategy === "BASELINE_ONSET8" ? 0 : round(median(deltas)),
        };
      }),
    );

  const neutralOnsetCounts = subregimes.map((subregime) => ({
    subregime,
    onsetSignals: observations.filter(
      (row) => row.regime === "NEUTRAL" && row.neutralSubregime === subregime && row.onset8,
    ).length,
    years: [
      ...new Set(
        observations
          .filter(
            (row) => row.regime === "NEUTRAL" && row.neutralSubregime === subregime && row.onset8,
          )
          .map((row) => Number(row.date.slice(0, 4))),
      ),
    ].sort((a, b) => a - b),
  }));

  const result = {
    studyVersion: STUDY_VERSION,
    generatedAt: new Date().toISOString(),
    methodology: {
      market: "KOSPI",
      horizon: HORIZON,
      roundTripCostBps: COST_BPS,
      entry: "NEXT_OPEN",
      exit: "signal index + 20 trading bars close",
      duplicateHoldingRule:
        "same symbol already held => later signal ignored, across all market regimes",
      baseRegime: "NEUTRAL = not (close>MA120 & KOSPI60D>+5%) and not (close<MA120 & KOSPI60D<-5%)",
      neutralSubregimes: {
        UP_TRANSITION_20D:
          "neutral, current KOSPI close>MA120 and 20 trading days ago close<=its MA120",
        ABOVE_MA_STABLE: "neutral, current and 20 trading days ago both above their MA120",
        DOWN_TRANSITION_20D:
          "neutral, current KOSPI close<=MA120 and 20 trading days ago close>its MA120",
        BELOW_MA_STABLE: "neutral, current and 20 trading days ago both below/equal their MA120",
      },
      rsAccel: "RS20 - RS60; both are stock return minus same-date KOSPI return",
      q4Plus: "daily all-KOSPI RSAccel quintile Q4 or Q5",
      primaryYears: COMPLETE_YEARS,
      partialYear: 2026,
    },
    source: {
      cacheKey: manifest.cacheKey,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      kospiSymbols: kospi.length,
      benchmarkBars: benchmark.bars.length,
    },
    neutralOnsetCounts,
    robustnessCompleteYears: buildRobustness(COMPLETE_YEARS),
    robustnessIncluding2026: buildRobustness(YEARS),
    yearly,
  };

  await mkdir("analysis-runs", { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const outputPath = path.join(
    "analysis-runs",
    `v8-kospi-rsaccel-stage7-neutral-subregime-${stamp}.json`,
  );
  await writeFile(outputPath, JSON.stringify(result, null, 2));
  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kospi-rsaccel-stage7-neutral-subregime/${stamp}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(
      client,
      `${options.userId}/results/v8-kospi-rsaccel-stage7-neutral-subregime/latest.json`,
      result,
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        outputPath: path.resolve(outputPath),
        remotePath,
        neutralOnsetCounts,
        robustnessCompleteYears: result.robustnessCompleteYears,
      },
      null,
      2,
    )}\n`,
  );
}

void main();
