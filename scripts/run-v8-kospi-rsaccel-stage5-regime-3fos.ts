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

const STUDY_VERSION = "CloudTrend V8 KOSPI RSAccel Stage5 Regime 3-FOS" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const HORIZONS = [5, 20, 40] as const;
const COST_BPS = [0, 20, 50] as const;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const REGIME_MA_DAYS = 120;
const REGIME_RETURN_DAYS = 60;
const REGIME_RETURN_THRESHOLD = 5;

type FoldYear = (typeof FOLD_YEARS)[number];
type Horizon = (typeof HORIZONS)[number];
type CostBps = (typeof COST_BPS)[number];
type Regime = "BULL" | "NEUTRAL" | "BEAR";
type StrategyId = "BASELINE_ONSET8" | "FILTER_POSITIVE" | "RANK_TOP33" | "FILTER_Q4PLUS";

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
  regime: Regime;
}

interface Trade {
  symbol: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  grossReturnPct: number;
  benchmarkReturnPct: number;
  grossExcessPct: number;
  rsAccel: number;
  score: number;
  regime: Regime;
}

interface TradeMetrics {
  trades: number;
  avgReturnPct: number | null;
  medianReturnPct: number | null;
  winRatePct: number | null;
  avgExcessPct: number | null;
  medianExcessPct: number | null;
  excessWinRatePct: number | null;
  avgBenchmarkReturnPct: number | null;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node scripts/run-v8-kospi-rsaccel-stage5-regime-3fos.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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
  if (!pastBenchmark || !currentBenchmark || pastBenchmark.close <= 0) return null;

  const currentStockIndex = dateIndex.get(signalDate);
  const pastStockIndex = dateIndex.get(pastBenchmark.tradeDate);
  if (currentStockIndex === undefined || pastStockIndex === undefined) return null;
  const currentStock = bars[currentStockIndex];
  const pastStock = bars[pastStockIndex];
  if (!currentStock || !pastStock || pastStock.close <= 0) return null;

  const stockReturn = (currentStock.close / pastStock.close - 1) * 100;
  const marketReturn = (currentBenchmark.close / pastBenchmark.close - 1) * 100;
  return stockReturn - marketReturn;
}

function marketRegime(
  signalDate: string,
  benchmark: ReturnType<typeof benchmarkSeries>,
): Regime | null {
  const index = benchmark.indexByDate.get(signalDate);
  if (index === undefined || index < REGIME_MA_DAYS - 1 || index < REGIME_RETURN_DAYS) return null;
  const current = benchmark.bars[index];
  const past60 = benchmark.bars[index - REGIME_RETURN_DAYS];
  if (!current || !past60 || current.close <= 0 || past60.close <= 0) return null;

  const window = benchmark.bars.slice(index - REGIME_MA_DAYS + 1, index + 1);
  if (window.length !== REGIME_MA_DAYS) return null;
  const ma120 = average(window.map((bar) => bar.close));
  if (!finite(ma120) || ma120 <= 0) return null;
  const return60 = (current.close / past60.close - 1) * 100;

  if (current.close > ma120 && return60 > REGIME_RETURN_THRESHOLD) return "BULL";
  if (current.close < ma120 && return60 < -REGIME_RETURN_THRESHOLD) return "BEAR";
  return "NEUTRAL";
}

function benchmarkReturn(
  benchmark: ReturnType<typeof benchmarkSeries>,
  entryDate: string,
  exitDate: string,
) {
  const entry = benchmark.byDate.get(entryDate);
  const exit = benchmark.byDate.get(exitDate);
  if (!entry || !exit || entry.open <= 0 || exit.close <= 0) return null;
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
  if (strategy === "FILTER_POSITIVE") return rows.filter((row) => row.onset8 && row.rsAccel > 0);
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
  seriesBySymbol: Map<string, { bars: DailyPrice[] }>,
  benchmark: ReturnType<typeof benchmarkSeries>,
) {
  const candidates: Trade[] = [];
  for (const signal of selectedSignals) {
    const series = seriesBySymbol.get(signal.symbol);
    if (!series) continue;
    const entry = series.bars[signal.signalIndex + 1];
    const exit = series.bars[signal.signalIndex + horizon];
    if (!entry || !exit || entry.open <= 0 || exit.close <= 0) continue;
    const benchmarkRet = benchmarkReturn(benchmark, entry.tradeDate, exit.tradeDate);
    if (!finite(benchmarkRet)) continue;
    const grossReturnPct = (exit.close / entry.open - 1) * 100;
    candidates.push({
      symbol: signal.symbol,
      signalDate: signal.signalDate,
      entryDate: entry.tradeDate,
      exitDate: exit.tradeDate,
      grossReturnPct,
      benchmarkReturnPct: benchmarkRet,
      grossExcessPct: grossReturnPct - benchmarkRet,
      rsAccel: signal.rsAccel,
      score: signal.score,
      regime: signal.regime,
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
  return accepted;
}

function summarizeTrades(trades: Trade[], costBps: CostBps): TradeMetrics {
  const costPct = costBps / 100;
  const returns = trades.map((trade) => trade.grossReturnPct - costPct);
  const excess = trades.map((trade) => trade.grossExcessPct - costPct);
  const benchmarkReturns = trades.map((trade) => trade.benchmarkReturnPct);
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
    avgBenchmarkReturnPct: round(average(benchmarkReturns)),
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
  const seriesBySymbol = new Map<string, { bars: DailyPrice[] }>();

  for (const series of kospiSeries) {
    const scores = series.baseScores.map((base, index) =>
      adjustedScore10(base, series.sectorPriceLeadership[index] ?? null),
    );
    const dateIndex = new Map(series.bars.map((bar, index) => [bar.tradeDate, index]));
    seriesBySymbol.set(series.symbol, { bars: series.bars });

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
      const regime = marketRegime(signalBar.tradeDate, benchmark);
      if (!finite(rs20) || !finite(rs60) || !regime) continue;

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
        regime,
      });
    }
  }

  const strategies: StrategyId[] = [
    "BASELINE_ONSET8",
    "FILTER_POSITIVE",
    "RANK_TOP33",
    "FILTER_Q4PLUS",
  ];
  const regimes: Regime[] = ["BULL", "NEUTRAL", "BEAR"];

  const foldResults = FOLD_YEARS.flatMap((fold) => {
    const rows = observationsByFold.get(fold) ?? [];
    const qMap = dailyMarketQuintiles(rows);
    return HORIZONS.flatMap((horizon) =>
      strategies.flatMap((strategy) => {
        const accepted = buildTrades(
          selectStrategy(strategy, rows, qMap),
          horizon,
          seriesBySymbol,
          benchmark,
        );
        return COST_BPS.flatMap((costBps) =>
          regimes.map((regime) => ({
            fold,
            horizon,
            strategy,
            costBps,
            regime,
            metrics: summarizeTrades(
              accepted.filter((trade) => trade.regime === regime),
              costBps,
            ),
          })),
        );
      }),
    );
  });

  const aggregates = HORIZONS.flatMap((horizon) =>
    COST_BPS.flatMap((costBps) =>
      regimes.flatMap((regime) =>
        strategies.map((strategy) => {
          const rows = foldResults.filter(
            (row) =>
              row.horizon === horizon &&
              row.costBps === costBps &&
              row.regime === regime &&
              row.strategy === strategy,
          );
          const baselineRows = foldResults.filter(
            (row) =>
              row.horizon === horizon &&
              row.costBps === costBps &&
              row.regime === regime &&
              row.strategy === "BASELINE_ONSET8",
          );
          const deltas = rows.map((row) => {
            const baseline = baselineRows.find((item) => item.fold === row.fold);
            return finite(row.metrics.avgExcessPct) && finite(baseline?.metrics.avgExcessPct)
              ? row.metrics.avgExcessPct - baseline.metrics.avgExcessPct
              : null;
          });
          return {
            horizon,
            costBps,
            regime,
            strategy,
            totalTrades: rows.reduce((sum, row) => sum + row.metrics.trades, 0),
            foldAvgReturnPct: round(
              average(rows.map((row) => row.metrics.avgReturnPct).filter(finite)),
            ),
            foldAvgExcessPct: round(
              average(rows.map((row) => row.metrics.avgExcessPct).filter(finite)),
            ),
            foldMedianExcessPct: round(
              average(rows.map((row) => row.metrics.medianExcessPct).filter(finite)),
            ),
            foldAvgExcessWinRatePct: round(
              average(rows.map((row) => row.metrics.excessWinRatePct).filter(finite)),
            ),
            foldAvgBenchmarkReturnPct: round(
              average(rows.map((row) => row.metrics.avgBenchmarkReturnPct).filter(finite)),
            ),
            foldAvgDeltaExcessVsBaselinePct: round(average(deltas.filter(finite))),
            positiveDeltaFolds: deltas.filter((value) => finite(value) && value > 0).length,
            foldsWithTrades: rows.filter((row) => row.metrics.trades > 0).length,
          };
        }),
      ),
    ),
  );

  const primarySummary = aggregates
    .filter((row) => row.horizon === 20 && row.costBps === 20)
    .sort((a, b) => {
      const regimeOrder = regimes.indexOf(a.regime) - regimes.indexOf(b.regime);
      if (regimeOrder !== 0) return regimeOrder;
      return strategies.indexOf(a.strategy) - strategies.indexOf(b.strategy);
    });

  const regimeSignalCounts = regimes.map((regime) => ({
    regime,
    onsetSignals: FOLD_YEARS.reduce(
      (sum, fold) =>
        sum +
        (observationsByFold.get(fold) ?? []).filter((row) => row.onset8 && row.regime === regime)
          .length,
      0,
    ),
  }));

  const now = new Date();
  const runId = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const result = {
    studyVersion: STUDY_VERSION,
    generatedAt: now.toISOString(),
    dataset: {
      datasetVersion: dataset.version,
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
      costsBpsRoundTrip: COST_BPS,
      entry: "next trading-day open",
      exit: "horizon close",
      duplicateRule: "ignore a new signal while the same symbol is already held",
      regimeDefinition: {
        bull: "KOSPI close > 120D simple moving average AND trailing 60D KOSPI return > +5%",
        bear: "KOSPI close < 120D simple moving average AND trailing 60D KOSPI return < -5%",
        neutral: "otherwise",
        timing: "signal-date close only; entry occurs next trading-day open",
      },
      strategies: {
        BASELINE_ONSET8: "strict V8 score upward onset through 8",
        FILTER_POSITIVE: "8-point onset with RSAccel > 0",
        RANK_TOP33: "top third RSAccel among same-day 8-point onset candidates",
        FILTER_Q4PLUS: "8-point onset in market-wide daily RSAccel Q4 or Q5",
      },
    },
    regimeSignalCounts,
    primarySummary,
    aggregates,
    folds: foldResults,
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `v8-kospi-rsaccel-stage5-regime-3fos-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kospi-rsaccel-stage5-regime-3fos/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(
      client,
      `${options.userId}/results/v8-kospi-rsaccel-stage5-regime-3fos/latest.json`,
      result,
    );
  }

  process.stdout.write(
    `${JSON.stringify({ outputPath, remotePath, regimeSignalCounts, primarySummary }, null, 2)}\n`,
  );
}

if (process.argv[1]?.endsWith("run-v8-kospi-rsaccel-stage5-regime-3fos.ts"))
  runStudy().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
