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

const STUDY_VERSION = "CloudTrend V8 KOSPI RSAccel Stage4 Portfolio 3-FOS" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const HORIZONS = [5, 20, 40] as const;
const COST_BPS = [0, 20, 50] as const;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const TRADING_DAYS_PER_YEAR = 252;

type FoldYear = (typeof FOLD_YEARS)[number];
type Horizon = (typeof HORIZONS)[number];
type CostBps = (typeof COST_BPS)[number];
type StrategyId =
  "BASELINE_ONSET8" | "FILTER_POSITIVE" | "RANK_TOP50" | "RANK_TOP33" | "FILTER_Q4PLUS";

interface Options {
  sourceManifest: string;
  sourceCacheDir: string;
  userId: string | null;
  upload: boolean;
}

interface SignalObservation {
  signalDate: string;
  symbol: string;
  score: number;
  rs20: number;
  rs60: number;
  rsAccel: number;
  onset8: boolean;
  signalIndex: number;
}

interface Trade {
  symbol: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  grossReturnPct: number;
  benchmarkReturnPct: number;
  grossExcessPct: number;
  rsAccel: number;
  score: number;
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
      "  npx vite-node --script scripts/run-v8-kospi-rsaccel-stage4-portfolio-3fos.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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

function sampleStd(values: number[]) {
  if (values.length < 2) return null;
  const mean = average(values)!;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
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
  ) {
    return null;
  }
  return (exit.close / entry.open - 1) * 100;
}

function bySignalDate(rows: SignalObservation[]) {
  const out = new Map<string, SignalObservation[]>();
  for (const row of rows) {
    const bucket = out.get(row.signalDate) ?? [];
    bucket.push(row);
    out.set(row.signalDate, bucket);
  }
  return out;
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

function dailyMarketQuintiles(rows: SignalObservation[]) {
  const result = new Map<string, 1 | 2 | 3 | 4 | 5>();
  for (const [date, dateRows] of bySignalDate(rows)) {
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

function selectTopFractionOnset(rows: SignalObservation[], fraction: number) {
  const selected: SignalObservation[] = [];
  for (const dateRows of bySignalDate(rows.filter((row) => row.onset8)).values()) {
    const sorted = [...dateRows].sort((a, b) => b.rsAccel - a.rsAccel);
    const count = Math.max(1, Math.ceil(sorted.length * fraction));
    selected.push(...sorted.slice(0, count));
  }
  return selected;
}

function selectStrategy(
  strategy: StrategyId,
  rows: SignalObservation[],
  qMap: Map<string, 1 | 2 | 3 | 4 | 5>,
) {
  if (strategy === "BASELINE_ONSET8") return rows.filter((row) => row.onset8);
  if (strategy === "FILTER_POSITIVE") {
    return rows.filter((row) => row.onset8 && row.rsAccel > 0);
  }
  if (strategy === "RANK_TOP50") return selectTopFractionOnset(rows, 0.5);
  if (strategy === "RANK_TOP33") return selectTopFractionOnset(rows, 1 / 3);
  return rows.filter((row) => {
    if (!row.onset8) return false;
    const q = qMap.get(`${row.signalDate}|${row.symbol}`);
    return q !== undefined && q >= 4;
  });
}

function buildTrades(
  selectedSignals: SignalObservation[],
  horizon: Horizon,
  seriesBySymbol: Map<
    string,
    {
      bars: DailyPrice[];
    }
  >,
  benchmark: ReturnType<typeof benchmarkSeries>,
) {
  const candidates: Trade[] = [];
  for (const signal of selectedSignals) {
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
    ) {
      continue;
    }
    const benchmarkRet = benchmarkReturn(benchmark, entry.tradeDate, exit.tradeDate);
    if (!finite(benchmarkRet)) continue;
    const grossReturnPct = (exit.close / entry.open - 1) * 100;
    candidates.push({
      symbol: signal.symbol,
      signalDate: signal.signalDate,
      entryDate: entry.tradeDate,
      exitDate: exit.tradeDate,
      entryPrice: entry.open,
      exitPrice: exit.close,
      grossReturnPct,
      benchmarkReturnPct: benchmarkRet,
      grossExcessPct: grossReturnPct - benchmarkRet,
      rsAccel: signal.rsAccel,
      score: signal.score,
    });
  }

  candidates.sort((a, b) => {
    const dateCompare = a.entryDate.localeCompare(b.entryDate);
    if (dateCompare !== 0) return dateCompare;
    const symbolCompare = a.symbol.localeCompare(b.symbol);
    if (symbolCompare !== 0) return symbolCompare;
    return b.rsAccel - a.rsAccel;
  });

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
  seriesBySymbol: Map<
    string,
    {
      bars: DailyPrice[];
      indexByDate: Map<string, number>;
    }
  >,
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
    const entryCost = (entries / active.length) * halfCost;
    const exitCost = (exits / active.length) * halfCost;
    rows.push({
      date,
      activePositions: active.length,
      entries,
      exits,
      grossReturn,
      benchmarkReturn: benchmarkReturnValue,
      netReturn: grossReturn - entryCost - exitCost,
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
    const dd = peak > 0 ? equity / peak - 1 : 0;
    maxDd = Math.min(maxDd, dd);
  }
  return maxDd;
}

function monthlyHitRate(rows: DailyPortfolioRow[]) {
  const months = new Map<string, { strategy: number[]; benchmark: number[] }>();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    const bucket = months.get(month) ?? { strategy: [], benchmark: [] };
    bucket.strategy.push(row.netReturn);
    bucket.benchmark.push(row.benchmarkReturn);
    months.set(month, bucket);
  }
  const comparisons = [...months.values()].map((month) => ({
    strategy: compound(month.strategy) - 1,
    benchmark: compound(month.benchmark) - 1,
  }));
  return comparisons.length
    ? (comparisons.filter((row) => row.strategy > row.benchmark).length / comparisons.length) * 100
    : null;
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
  const netTradeReturns = trades.map((trade) => trade.grossReturnPct - costBps / 100);
  const netTradeExcess = trades.map((trade) => trade.grossExcessPct - costBps / 100);

  return {
    trades: trades.length,
    avgTradeReturnPct: round(average(netTradeReturns)),
    medianTradeReturnPct: round(median(netTradeReturns)),
    tradeWinRatePct: trades.length
      ? round((netTradeReturns.filter((value) => value > 0).length / trades.length) * 100)
      : null,
    avgTradeExcessPct: round(average(netTradeExcess)),
    tradeExcessWinRatePct: trades.length
      ? round((netTradeExcess.filter((value) => value > 0).length / trades.length) * 100)
      : null,
    portfolioTotalReturnPct: round((equity - 1) * 100),
    matchedBenchmarkTotalReturnPct: round((benchmarkEquity - 1) * 100),
    portfolioCagrPct: years > 0 && equity > 0 ? round((equity ** (1 / years) - 1) * 100) : null,
    matchedBenchmarkCagrPct:
      years > 0 && benchmarkEquity > 0 ? round((benchmarkEquity ** (1 / years) - 1) * 100) : null,
    annualizedVolPct: finite(annualizedVol) ? round(annualizedVol * 100) : null,
    sharpeRf0:
      finite(annualizedVol) && annualizedVol > 0 ? round(annualizedMean / annualizedVol) : null,
    maxDrawdownPct: round(maxDrawdown(dailyReturns) * 100),
    activeDayPct: dailyRows.length ? round((activeDays.length / dailyRows.length) * 100) : null,
    avgConcurrentPositions: round(avgConcurrent),
    maxConcurrentPositions: activeDays.length
      ? Math.max(...activeDays.map((row) => row.activePositions))
      : 0,
    monthlyBeatBenchmarkRatePct: round(monthlyHitRate(dailyRows)),
    annualizedRoundTripsPerSlot:
      years > 0 && avgConcurrent > 0 ? round(trades.length / avgConcurrent / years) : null,
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

  const observationsByFold = new Map<FoldYear, SignalObservation[]>();
  for (const fold of FOLD_YEARS) observationsByFold.set(fold, []);

  const seriesBySymbol = new Map<
    string,
    {
      bars: DailyPrice[];
      indexByDate: Map<string, number>;
    }
  >();

  for (const series of kospiSeries) {
    const scores = series.baseScores.map((base, index) =>
      adjustedScore10(base, series.sectorPriceLeadership[index] ?? null),
    );
    const dateIndex = new Map(series.bars.map((bar, index) => [bar.tradeDate, index]));
    seriesBySymbol.set(series.symbol, { bars: series.bars, indexByDate: dateIndex });

    for (let i = 1; i + 1 < series.bars.length; i++) {
      const signalBar = series.bars[i]!;
      const foldValue = Number(signalBar.tradeDate.slice(0, 4));
      if (!FOLD_YEARS.includes(foldValue as FoldYear)) continue;
      const fold = foldValue as FoldYear;
      const score = scores[i];
      const previousScore = scores[i - 1];
      if (!finite(score)) continue;

      const rs20 = alignedRelativeStrength(
        series.bars,
        dateIndex,
        signalBar.tradeDate,
        benchmark,
        20,
      );
      const rs60 = alignedRelativeStrength(
        series.bars,
        dateIndex,
        signalBar.tradeDate,
        benchmark,
        60,
      );
      if (!finite(rs20) || !finite(rs60)) continue;
      observationsByFold.get(fold)!.push({
        signalDate: signalBar.tradeDate,
        symbol: series.symbol,
        score,
        rs20,
        rs60,
        rsAccel: rs20 - rs60,
        onset8:
          finite(previousScore) && previousScore < ONSET_THRESHOLD && score >= ONSET_THRESHOLD,
        signalIndex: i,
      });
    }
  }

  const strategies: StrategyId[] = [
    "BASELINE_ONSET8",
    "FILTER_POSITIVE",
    "RANK_TOP50",
    "RANK_TOP33",
    "FILTER_Q4PLUS",
  ];

  const foldResults = FOLD_YEARS.flatMap((fold) => {
    const rows = observationsByFold.get(fold) ?? [];
    const qMap = dailyMarketQuintiles(rows);
    return HORIZONS.flatMap((horizon) =>
      strategies.flatMap((strategy) => {
        const selected = selectStrategy(strategy, rows, qMap);
        const { candidates, accepted } = buildTrades(selected, horizon, seriesBySymbol, benchmark);
        return COST_BPS.map((costBps) => {
          const daily = simulateDailyPortfolio(accepted, costBps, benchmark, seriesBySymbol);
          return {
            fold,
            horizon,
            strategy,
            costBps,
            rawSelectedSignals: selected.length,
            candidateTrades: candidates.length,
            duplicateSuppressed: candidates.length - accepted.length,
            ...portfolioMetrics(accepted, daily, costBps),
          };
        });
      }),
    );
  });

  const aggregates = HORIZONS.flatMap((horizon) =>
    strategies.flatMap((strategy) =>
      COST_BPS.map((costBps) => {
        const rows = foldResults.filter(
          (row) => row.horizon === horizon && row.strategy === strategy && row.costBps === costBps,
        );
        const baselineRows = foldResults.filter(
          (row) =>
            row.horizon === horizon &&
            row.strategy === "BASELINE_ONSET8" &&
            row.costBps === costBps,
        );
        const baselineByFold = new Map(baselineRows.map((row) => [row.fold, row]));
        const cagrDeltas = rows
          .map((row) => {
            const baseline = baselineByFold.get(row.fold);
            return finite(row.portfolioCagrPct) && finite(baseline?.portfolioCagrPct)
              ? row.portfolioCagrPct - baseline.portfolioCagrPct
              : null;
          })
          .filter(finite);
        const excessTradeDeltas = rows
          .map((row) => {
            const baseline = baselineByFold.get(row.fold);
            return finite(row.avgTradeExcessPct) && finite(baseline?.avgTradeExcessPct)
              ? row.avgTradeExcessPct - baseline.avgTradeExcessPct
              : null;
          })
          .filter(finite);
        return {
          horizon,
          strategy,
          costBps,
          folds: rows.length,
          totalTrades: rows.reduce((sum, row) => sum + row.trades, 0),
          totalDuplicateSuppressed: rows.reduce((sum, row) => sum + row.duplicateSuppressed, 0),
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
          meanActiveDayPct: round(average(rows.map((row) => row.activeDayPct).filter(finite))),
          meanConcurrentPositions: round(
            average(rows.map((row) => row.avgConcurrentPositions).filter(finite)),
          ),
          meanMonthlyBeatBenchmarkRatePct: round(
            average(rows.map((row) => row.monthlyBeatBenchmarkRatePct).filter(finite)),
          ),
          meanAnnualizedRoundTripsPerSlot: round(
            average(rows.map((row) => row.annualizedRoundTripsPerSlot).filter(finite)),
          ),
          meanCagrDeltaVsBaselinePct: round(average(cagrDeltas)),
          positiveCagrDeltaFolds: cagrDeltas.filter((value) => value > 0).length,
          meanTradeExcessDeltaVsBaselinePct: round(average(excessTradeDeltas)),
          positiveTradeExcessDeltaFolds: excessTradeDeltas.filter((value) => value > 0).length,
        };
      }),
    ),
  );

  const stage4Summary = strategies.map((strategy) => {
    const primary = aggregates.find(
      (row) => row.horizon === 20 && row.strategy === strategy && row.costBps === 20,
    );
    const cost50 = aggregates.find(
      (row) => row.horizon === 20 && row.strategy === strategy && row.costBps === 50,
    );
    return {
      strategy,
      trades20D: primary?.totalTrades ?? 0,
      cagr20D20bp: primary?.meanPortfolioCagrPct ?? null,
      cagrDeltaVsBaseline20D20bp: primary?.meanCagrDeltaVsBaselinePct ?? null,
      positiveCagrFolds20D20bp: primary?.positiveCagrDeltaFolds ?? 0,
      tradeExcess20D20bp: primary?.meanAvgTradeExcessPct ?? null,
      tradeExcessDelta20D20bp: primary?.meanTradeExcessDeltaVsBaselinePct ?? null,
      sharpe20D20bp: primary?.meanSharpeRf0 ?? null,
      mdd20D20bp: primary?.meanMaxDrawdownPct ?? null,
      avgConcurrent20D20bp: primary?.meanConcurrentPositions ?? null,
      turnoverProxy20D20bp: primary?.meanAnnualizedRoundTripsPerSlot ?? null,
      cagr20D50bp: cost50?.meanPortfolioCagrPct ?? null,
      cagrDeltaVsBaseline20D50bp: cost50?.meanCagrDeltaVsBaselinePct ?? null,
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
      roundTripCostBps: COST_BPS,
      entry: "next trading-day open",
      exit: "fixed horizon close",
      duplicateRule:
        "ignore a new signal while the same symbol is already held through that entry date",
      portfolio:
        "daily equal weight across active trades; cash return is zero when no trade is active",
      matchedBenchmark:
        "KOSPI return over the same active capital windows; entry-day benchmark return uses open-to-close",
      transactionCost:
        "round-trip cost split equally between entry and exit and deducted from active portfolio return",
      turnoverProxy:
        "accepted round trips divided by average concurrent positions and elapsed trading years",
      strategies: {
        BASELINE_ONSET8: "all strict V8 8-point upward onset signals",
        FILTER_POSITIVE: "8-point onset with RSAccel > 0",
        RANK_TOP50: "top 50% RSAccel among same-day 8-point onset candidates",
        RANK_TOP33: "top one-third RSAccel among same-day 8-point onset candidates",
        FILTER_Q4PLUS: "8-point onset whose market-wide daily RSAccel quintile is Q4 or Q5",
      },
    },
    stage4Summary,
    aggregates,
    folds: foldResults,
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `v8-kospi-rsaccel-stage4-portfolio-3fos-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kospi-rsaccel-stage4-portfolio-3fos/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(
      client,
      `${options.userId}/results/v8-kospi-rsaccel-stage4-portfolio-3fos/latest.json`,
      result,
    );
  }

  process.stdout.write(`${JSON.stringify({ outputPath, remotePath, stage4Summary }, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("run-v8-kospi-rsaccel-stage4-portfolio-3fos.ts"))
  runStudy().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
