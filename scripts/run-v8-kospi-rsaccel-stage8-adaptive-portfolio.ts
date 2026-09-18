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

const STUDY_VERSION = "CloudTrend V8 KOSPI RSAccel Stage8 Adaptive Portfolio" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const COMPLETE_YEARS = Array.from({ length: 9 }, (_, i) => 2017 + i);
const HOLDOUT_YEAR = 2026;
const HORIZONS = [5, 20, 40] as const;
const COST_BPS = [0, 20, 50] as const;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const MA_LOOKBACK = 120;
const RETURN_LOOKBACK = 60;
const TRANSITION_LOOKBACK = 20;
const BULL_RETURN_THRESHOLD = 5;
const BEAR_RETURN_THRESHOLD = -5;
const TRADING_DAYS_PER_YEAR = 252;

type Horizon = (typeof HORIZONS)[number];
type CostBps = (typeof COST_BPS)[number];
type Regime = "BULL" | "NEUTRAL" | "BEAR";
type NeutralSubregime =
  "UP_TRANSITION_20D" | "ABOVE_MA_STABLE" | "DOWN_TRANSITION_20D" | "BELOW_MA_STABLE";
type StrategyId =
  "BASELINE_ONSET8" | "GLOBAL_RSACCEL_POSITIVE" | "GLOBAL_Q4PLUS" | "ADAPTIVE_KOSPI";

interface Options {
  sourceManifest: string;
  sourceCacheDir: string;
  userId: string | null;
  upload: boolean;
}
interface Observation {
  date: string;
  year: number;
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
  symbol: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  grossReturnPct: number;
  benchmarkReturnPct: number;
  grossExcessPct: number;
  signal: Observation;
}
interface DailyPortfolioRow {
  date: string;
  activePositions: number;
  entries: number;
  exits: number;
  grossReturn: number;
  benchmarkReturn: number;
  netReturn: number;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node --script scripts/run-v8-kospi-rsaccel-stage8-adaptive-portfolio.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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
function sampleStd(values: number[]) {
  if (values.length < 2) return null;
  const mean = average(values)!;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1),
  );
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
  return { aboveMa, regime };
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

function adaptivePass(row: Observation, quintiles: Map<string, 1 | 2 | 3 | 4 | 5>) {
  if (!row.onset8) return false;
  if (row.regime !== "NEUTRAL") return true;
  if (row.neutralSubregime === "BELOW_MA_STABLE") return row.rsAccel > 0;
  if (row.neutralSubregime === "UP_TRANSITION_20D")
    return (quintiles.get(`${row.date}|${row.symbol}`) ?? 0) >= 4;
  return true;
}

function strategyPass(
  strategy: StrategyId,
  row: Observation,
  quintiles: Map<string, 1 | 2 | 3 | 4 | 5>,
) {
  if (!row.onset8) return false;
  if (strategy === "BASELINE_ONSET8") return true;
  if (strategy === "GLOBAL_RSACCEL_POSITIVE") return row.rsAccel > 0;
  if (strategy === "GLOBAL_Q4PLUS") return (quintiles.get(`${row.date}|${row.symbol}`) ?? 0) >= 4;
  return adaptivePass(row, quintiles);
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

function buildTrades(
  rows: Observation[],
  strategy: StrategyId,
  horizon: Horizon,
  quintiles: Map<string, 1 | 2 | 3 | 4 | 5>,
  seriesBySymbol: Map<string, { bars: DailyPrice[]; indexByDate: Map<string, number> }>,
  benchmark: ReturnType<typeof benchmarkSeries>,
) {
  const candidates: Trade[] = [];
  for (const signal of rows) {
    if (!strategyPass(strategy, signal, quintiles)) continue;
    const series = seriesBySymbol.get(signal.symbol);
    if (!series) continue;
    const entry = series.bars[signal.signalIndex + 1];
    const exit = series.bars[signal.signalIndex + horizon];
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
      symbol: signal.symbol,
      signalDate: signal.date,
      entryDate: entry.tradeDate,
      exitDate: exit.tradeDate,
      grossReturnPct: gross,
      benchmarkReturnPct: benchmarkPct,
      grossExcessPct: gross - benchmarkPct,
      signal,
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
  return { candidates, accepted };
}

function dailyStockReturn(
  trade: Trade,
  date: string,
  bars: DailyPrice[],
  indexByDate: Map<string, number>,
) {
  const index = indexByDate.get(date);
  if (index === undefined) return 0;
  const bar = bars[index];
  if (!bar || !finite(bar.close) || bar.close <= 0) return 0;
  if (date === trade.entryDate) {
    if (!finite(bar.open) || bar.open <= 0) return 0;
    return bar.close / bar.open - 1;
  }
  const previous = bars[index - 1];
  if (!previous || !finite(previous.close) || previous.close <= 0) return 0;
  return bar.close / previous.close - 1;
}

function dailyBenchmarkLegReturn(
  trade: Trade,
  date: string,
  benchmark: ReturnType<typeof benchmarkSeries>,
) {
  const index = benchmark.indexByDate.get(date);
  if (index === undefined) return 0;
  const bar = benchmark.bars[index];
  if (!bar || !finite(bar.close) || bar.close <= 0) return 0;
  if (date === trade.entryDate) {
    if (!finite(bar.open) || bar.open <= 0) return 0;
    return bar.close / bar.open - 1;
  }
  const previous = benchmark.bars[index - 1];
  if (!previous || !finite(previous.close) || previous.close <= 0) return 0;
  return bar.close / previous.close - 1;
}

function simulateDailyPortfolio(
  trades: Trade[],
  costBps: CostBps,
  benchmark: ReturnType<typeof benchmarkSeries>,
  seriesBySymbol: Map<string, { bars: DailyPrice[]; indexByDate: Map<string, number> }>,
) {
  if (!trades.length) return [] as DailyPortfolioRow[];
  const firstDate = trades.reduce(
    (min, trade) => (trade.entryDate < min ? trade.entryDate : min),
    trades[0]!.entryDate,
  );
  const lastDate = trades.reduce(
    (max, trade) => (trade.exitDate > max ? trade.exitDate : max),
    trades[0]!.exitDate,
  );
  const dates = benchmark.bars
    .map((bar) => bar.tradeDate)
    .filter((date) => date >= firstDate && date <= lastDate);
  const halfCost = costBps / 2 / 10_000;
  const rows: DailyPortfolioRow[] = [];
  for (const date of dates) {
    const active = trades.filter((trade) => date >= trade.entryDate && date <= trade.exitDate);
    const entries = active.filter((trade) => trade.entryDate === date).length;
    const exits = active.filter((trade) => trade.exitDate === date).length;
    if (!active.length) {
      rows.push({
        date,
        activePositions: 0,
        entries: 0,
        exits: 0,
        grossReturn: 0,
        benchmarkReturn: 0,
        netReturn: 0,
      });
      continue;
    }
    const stockReturns = active.map((trade) => {
      const series = seriesBySymbol.get(trade.symbol);
      return series ? dailyStockReturn(trade, date, series.bars, series.indexByDate) : 0;
    });
    const benchmarkReturns = active.map((trade) => dailyBenchmarkLegReturn(trade, date, benchmark));
    const grossReturn = average(stockReturns) ?? 0;
    const benchmarkReturnValue = average(benchmarkReturns) ?? 0;
    const cost = ((entries + exits) / active.length) * halfCost;
    rows.push({
      date,
      activePositions: active.length,
      entries,
      exits,
      grossReturn,
      benchmarkReturn: benchmarkReturnValue,
      netReturn: grossReturn - cost,
    });
  }
  return rows;
}

function compound(returns: number[]) {
  return returns.reduce((equity, value) => equity * (1 + value), 1);
}
function maxDrawdown(returns: number[]) {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, peak > 0 ? equity / peak - 1 : 0);
  }
  return maxDd;
}

function portfolioMetrics(trades: Trade[], dailyRows: DailyPortfolioRow[], costBps: CostBps) {
  const dailyReturns = dailyRows.map((row) => row.netReturn);
  const benchmarkReturns = dailyRows.map((row) => row.benchmarkReturn);
  const activeDays = dailyRows.filter((row) => row.activePositions > 0);
  const years = dailyRows.length / TRADING_DAYS_PER_YEAR;
  const equity = compound(dailyReturns);
  const benchmarkEquity = compound(benchmarkReturns);
  const dailyStd = sampleStd(dailyReturns);
  const annualizedVol = finite(dailyStd) ? dailyStd * Math.sqrt(TRADING_DAYS_PER_YEAR) : null;
  const annualizedMean = (average(dailyReturns) ?? 0) * TRADING_DAYS_PER_YEAR;
  const avgConcurrent = average(activeDays.map((row) => row.activePositions)) ?? 0;
  const tradeReturns = trades.map((trade) => trade.grossReturnPct - costBps / 100);
  const tradeExcess = trades.map((trade) => trade.grossExcessPct - costBps / 100);
  return {
    trades: trades.length,
    avgTradeReturnPct: round(average(tradeReturns)),
    medianTradeReturnPct: round(median(tradeReturns)),
    tradeWinRatePct: trades.length
      ? round((tradeReturns.filter((value) => value > 0).length / trades.length) * 100)
      : null,
    avgTradeExcessPct: round(average(tradeExcess)),
    medianTradeExcessPct: round(median(tradeExcess)),
    tradeExcessWinRatePct: trades.length
      ? round((tradeExcess.filter((value) => value > 0).length / trades.length) * 100)
      : null,
    portfolioTotalReturnPct: round((equity - 1) * 100),
    matchedBenchmarkTotalReturnPct: round((benchmarkEquity - 1) * 100),
    portfolioCagrPct: years > 0 && equity > 0 ? round((equity ** (1 / years) - 1) * 100) : null,
    matchedBenchmarkCagrPct:
      years > 0 && benchmarkEquity > 0 ? round((benchmarkEquity ** (1 / years) - 1) * 100) : null,
    sharpeRf0:
      finite(annualizedVol) && annualizedVol > 0 ? round(annualizedMean / annualizedVol) : null,
    maxDrawdownPct: round(maxDrawdown(dailyReturns) * 100),
    avgConcurrentPositions: round(avgConcurrent),
    maxConcurrentPositions: activeDays.length
      ? Math.max(...activeDays.map((row) => row.activePositions))
      : 0,
    activeDayPct: dailyRows.length ? round((activeDays.length / dailyRows.length) * 100) : null,
  };
}

function signalOutcome(
  row: Observation,
  horizon: Horizon,
  costBps: CostBps,
  seriesBySymbol: Map<string, { bars: DailyPrice[]; indexByDate: Map<string, number> }>,
  benchmark: ReturnType<typeof benchmarkSeries>,
) {
  const series = seriesBySymbol.get(row.symbol);
  if (!series) return null;
  const entry = series.bars[row.signalIndex + 1];
  const exit = series.bars[row.signalIndex + horizon];
  if (
    !entry ||
    !exit ||
    !finite(entry.open) ||
    entry.open <= 0 ||
    !finite(exit.close) ||
    exit.close <= 0
  )
    return null;
  const benchmarkPct = benchmarkReturn(benchmark, entry.tradeDate, exit.tradeDate);
  if (!finite(benchmarkPct)) return null;
  return (exit.close / entry.open - 1) * 100 - benchmarkPct - costBps / 100;
}

function discrimination(
  rows: Observation[],
  quintiles: Map<string, 1 | 2 | 3 | 4 | 5>,
  horizon: Horizon,
  costBps: CostBps,
  seriesBySymbol: Map<string, { bars: DailyPrice[]; indexByDate: Map<string, number> }>,
  benchmark: ReturnType<typeof benchmarkSeries>,
) {
  const onset = rows.filter((row) => row.onset8);
  const selected: number[] = [];
  const rejected: number[] = [];
  for (const row of onset) {
    const outcome = signalOutcome(row, horizon, costBps, seriesBySymbol, benchmark);
    if (!finite(outcome)) continue;
    (adaptivePass(row, quintiles) ? selected : rejected).push(outcome);
  }
  return {
    onsetSignals: selected.length + rejected.length,
    selectedSignals: selected.length,
    rejectedSignals: rejected.length,
    retentionPct:
      selected.length + rejected.length
        ? round((selected.length / (selected.length + rejected.length)) * 100)
        : null,
    selectedAvgExcessPct: round(average(selected)),
    rejectedAvgExcessPct: round(average(rejected)),
    selectedMedianExcessPct: round(median(selected)),
    rejectedMedianExcessPct: round(median(rejected)),
    selectionSpreadPct:
      selected.length && rejected.length ? round(average(selected)! - average(rejected)!) : null,
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
  const seriesBySymbol = new Map<
    string,
    { bars: DailyPrice[]; indexByDate: Map<string, number> }
  >();

  for (const series of kospiSeries) {
    const scores = series.baseScores.map((base, index) =>
      adjustedScore10(base, series.sectorPriceLeadership[index] ?? null),
    );
    const dateIndex = new Map(series.bars.map((bar, index) => [bar.tradeDate, index]));
    seriesBySymbol.set(series.symbol, { bars: series.bars, indexByDate: dateIndex });
    for (let i = 1; i + 1 < series.bars.length; i++) {
      const bar = series.bars[i]!;
      const year = Number(bar.tradeDate.slice(0, 4));
      if (year < 2017 || year > HOLDOUT_YEAR) continue;
      const benchmarkIndex = benchmark.indexByDate.get(bar.tradeDate);
      if (benchmarkIndex === undefined) continue;
      const state = marketStateAt(benchmarkIndex, benchmark);
      if (!state) continue;
      const score = scores[i];
      const previousScore = scores[i - 1];
      if (!finite(score)) continue;
      const rs20 = alignedRelativeStrength(series.bars, dateIndex, bar.tradeDate, benchmark, 20);
      const rs60 = alignedRelativeStrength(series.bars, dateIndex, bar.tradeDate, benchmark, 60);
      if (!finite(rs20) || !finite(rs60)) continue;
      observations.push({
        date: bar.tradeDate,
        year,
        symbol: series.symbol,
        score,
        rs20,
        rs60,
        rsAccel: rs20 - rs60,
        onset8:
          finite(previousScore) && previousScore < ONSET_THRESHOLD && score >= ONSET_THRESHOLD,
        signalIndex: i,
        regime: state.regime,
        neutralSubregime: neutralSubregimeAt(benchmarkIndex, benchmark),
      });
    }
  }

  const quintiles = dailyQuintiles(observations);
  const strategies: StrategyId[] = [
    "BASELINE_ONSET8",
    "GLOBAL_RSACCEL_POSITIVE",
    "GLOBAL_Q4PLUS",
    "ADAPTIVE_KOSPI",
  ];

  const foldResults = FOLD_YEARS.flatMap((fold) => {
    const rows = observations.filter((row) => row.year === fold);
    return HORIZONS.flatMap((horizon) =>
      strategies.flatMap((strategy) => {
        const { candidates, accepted } = buildTrades(
          rows,
          strategy,
          horizon,
          quintiles,
          seriesBySymbol,
          benchmark,
        );
        return COST_BPS.map((costBps) => ({
          fold,
          horizon,
          strategy,
          costBps,
          candidateTrades: candidates.length,
          duplicateSuppressed: candidates.length - accepted.length,
          ...portfolioMetrics(
            accepted,
            simulateDailyPortfolio(accepted, costBps, benchmark, seriesBySymbol),
            costBps,
          ),
        }));
      }),
    );
  });

  const aggregates = HORIZONS.flatMap((horizon) =>
    strategies.flatMap((strategy) =>
      COST_BPS.map((costBps) => {
        const rows = foldResults.filter(
          (row) => row.horizon === horizon && row.strategy === strategy && row.costBps === costBps,
        );
        const baseline = new Map(
          foldResults
            .filter(
              (row) =>
                row.horizon === horizon &&
                row.strategy === "BASELINE_ONSET8" &&
                row.costBps === costBps,
            )
            .map((row) => [row.fold, row]),
        );
        const cagrDeltas = rows
          .map((row) => {
            const base = baseline.get(row.fold);
            return finite(row.portfolioCagrPct) && finite(base?.portfolioCagrPct)
              ? row.portfolioCagrPct - base.portfolioCagrPct
              : null;
          })
          .filter(finite);
        return {
          horizon,
          strategy,
          costBps,
          folds: rows.length,
          totalTrades: rows.reduce((sum, row) => sum + row.trades, 0),
          meanPortfolioCagrPct: round(
            average(rows.map((row) => row.portfolioCagrPct).filter(finite)),
          ),
          meanMatchedBenchmarkCagrPct: round(
            average(rows.map((row) => row.matchedBenchmarkCagrPct).filter(finite)),
          ),
          meanSharpeRf0: round(average(rows.map((row) => row.sharpeRf0).filter(finite))),
          meanMaxDrawdownPct: round(average(rows.map((row) => row.maxDrawdownPct).filter(finite))),
          meanAvgTradeExcessPct: round(
            average(rows.map((row) => row.avgTradeExcessPct).filter(finite)),
          ),
          meanConcurrentPositions: round(
            average(rows.map((row) => row.avgConcurrentPositions).filter(finite)),
          ),
          meanCagrDeltaVsBaselinePct: round(average(cagrDeltas)),
          positiveCagrDeltaFolds: cagrDeltas.filter((value) => value > 0).length,
        };
      }),
    ),
  );

  const yearly20D20bp = COMPLETE_YEARS.flatMap((year) => {
    const rows = observations.filter((row) => row.year === year);
    return strategies.map((strategy) => {
      const { accepted } = buildTrades(rows, strategy, 20, quintiles, seriesBySymbol, benchmark);
      const metrics = portfolioMetrics(
        accepted,
        simulateDailyPortfolio(accepted, 20, benchmark, seriesBySymbol),
        20,
      );
      return { year, strategy, ...metrics };
    });
  });

  const yearlyRobustness = strategies.map((strategy) => {
    const rows = yearly20D20bp.filter((row) => row.strategy === strategy);
    const baseline = new Map(
      yearly20D20bp
        .filter((row) => row.strategy === "BASELINE_ONSET8")
        .map((row) => [row.year, row]),
    );
    const deltas = rows
      .map((row) => {
        const base = baseline.get(row.year);
        return finite(row.portfolioCagrPct) && finite(base?.portfolioCagrPct)
          ? row.portfolioCagrPct - base.portfolioCagrPct
          : null;
      })
      .filter(finite);
    return {
      strategy,
      years: rows.length,
      totalTrades: rows.reduce((sum, row) => sum + row.trades, 0),
      meanYearCagrPct: round(average(rows.map((row) => row.portfolioCagrPct).filter(finite))),
      medianYearCagrPct: round(median(rows.map((row) => row.portfolioCagrPct).filter(finite))),
      meanYearSharpe: round(average(rows.map((row) => row.sharpeRf0).filter(finite))),
      meanYearMddPct: round(average(rows.map((row) => row.maxDrawdownPct).filter(finite))),
      positiveCagrDeltaYears:
        strategy === "BASELINE_ONSET8" ? null : deltas.filter((value) => value > 0).length,
      meanCagrDeltaVsBaselinePct: strategy === "BASELINE_ONSET8" ? 0 : round(average(deltas)),
      medianCagrDeltaVsBaselinePct: strategy === "BASELINE_ONSET8" ? 0 : round(median(deltas)),
    };
  });

  const holdoutRows = observations.filter((row) => row.year === HOLDOUT_YEAR);
  const holdout2026 = HORIZONS.flatMap((horizon) =>
    strategies.map((strategy) => {
      const { accepted } = buildTrades(
        holdoutRows,
        strategy,
        horizon,
        quintiles,
        seriesBySymbol,
        benchmark,
      );
      return {
        year: HOLDOUT_YEAR,
        horizon,
        strategy,
        costBps: 20,
        ...portfolioMetrics(
          accepted,
          simulateDailyPortfolio(accepted, 20, benchmark, seriesBySymbol),
          20,
        ),
      };
    }),
  );

  const foldDiscrimination = FOLD_YEARS.map((fold) => ({
    fold,
    ...discrimination(
      observations.filter((row) => row.year === fold),
      quintiles,
      20,
      20,
      seriesBySymbol,
      benchmark,
    ),
  }));
  const completeYearDiscrimination = COMPLETE_YEARS.map((year) => ({
    year,
    ...discrimination(
      observations.filter((row) => row.year === year),
      quintiles,
      20,
      20,
      seriesBySymbol,
      benchmark,
    ),
  }));
  const holdoutDiscrimination = discrimination(
    holdoutRows,
    quintiles,
    20,
    20,
    seriesBySymbol,
    benchmark,
  );

  const stateActivation = ["BULL", "NEUTRAL", "BEAR"].flatMap((regime) => {
    const stateRows = observations.filter((row) => row.regime === regime && row.onset8);
    const bySubregime =
      regime === "NEUTRAL"
        ? ["UP_TRANSITION_20D", "ABOVE_MA_STABLE", "DOWN_TRANSITION_20D", "BELOW_MA_STABLE"]
        : [null];
    return bySubregime.map((subregime) => {
      const rows = subregime
        ? stateRows.filter((row) => row.neutralSubregime === subregime)
        : stateRows;
      const passed = rows.filter((row) => adaptivePass(row, quintiles));
      return {
        regime,
        neutralSubregime: subregime,
        onsetSignals: rows.length,
        adaptiveSelected: passed.length,
        retentionPct: rows.length ? round((passed.length / rows.length) * 100) : null,
      };
    });
  });

  const primarySummary = strategies.map((strategy) => {
    const aggregate = aggregates.find(
      (row) => row.horizon === 20 && row.strategy === strategy && row.costBps === 20,
    );
    const holdout = holdout2026.find((row) => row.horizon === 20 && row.strategy === strategy);
    return {
      strategy,
      threeFosTrades: aggregate?.totalTrades ?? 0,
      threeFosMeanCagrPct: aggregate?.meanPortfolioCagrPct ?? null,
      threeFosCagrDeltaVsBaselinePct: aggregate?.meanCagrDeltaVsBaselinePct ?? null,
      threeFosPositiveCagrDeltaFolds: aggregate?.positiveCagrDeltaFolds ?? 0,
      threeFosMeanSharpe: aggregate?.meanSharpeRf0 ?? null,
      threeFosMeanMddPct: aggregate?.meanMaxDrawdownPct ?? null,
      threeFosMeanTradeExcessPct: aggregate?.meanAvgTradeExcessPct ?? null,
      holdout2026Trades: holdout?.trades ?? 0,
      holdout2026CagrPct: holdout?.portfolioCagrPct ?? null,
      holdout2026Sharpe: holdout?.sharpeRf0 ?? null,
      holdout2026MddPct: holdout?.maxDrawdownPct ?? null,
      holdout2026TradeExcessPct: holdout?.avgTradeExcessPct ?? null,
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
      developmentYears: COMPLETE_YEARS,
      temporalHoldoutYear: HOLDOUT_YEAR,
      foldsForContinuity: FOLD_YEARS,
      horizons: HORIZONS,
      roundTripCostBps: COST_BPS,
      entry: "next trading-day open",
      exit: "fixed horizon close",
      duplicateRule:
        "ignore a new signal while the same symbol is already held through that entry date",
      adaptiveRule: {
        bull: "keep every strict V8 8-point onset",
        neutralAboveMaStable: "keep every strict V8 8-point onset",
        neutralDownTransition20D: "keep every strict V8 8-point onset",
        neutralBelowMaStable: "require RSAccel > 0",
        neutralUpTransition20D: "require market-wide daily RSAccel Q4 or Q5",
        bear: "keep every strict V8 8-point onset",
      },
      note: "Stage8 tests an entry-quality overlay. It does not alter the underlying V8 10-point technical score.",
    },
    primarySummary,
    stateActivation,
    foldDiscrimination,
    completeYearDiscrimination,
    holdoutDiscrimination,
    yearlyRobustness,
    yearly20D20bp,
    holdout2026,
    aggregates,
    folds: foldResults,
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    `v8-kospi-rsaccel-stage8-adaptive-portfolio-${runId}.json`,
  );
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kospi-rsaccel-stage8-adaptive-portfolio/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(
      client,
      `${options.userId}/results/v8-kospi-rsaccel-stage8-adaptive-portfolio/latest.json`,
      result,
    );
  }

  process.stdout.write(
    `${JSON.stringify({ outputPath, remotePath, primarySummary, holdoutDiscrimination }, null, 2)}\n`,
  );
}

if (process.argv[1]?.endsWith("run-v8-kospi-rsaccel-stage8-adaptive-portfolio.ts"))
  runStudy().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
