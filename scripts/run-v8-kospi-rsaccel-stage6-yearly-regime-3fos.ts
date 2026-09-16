import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildPortfolioSignalContext } from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { DailyPrice } from "../src/lib/engine/types";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8 KOSPI RSAccel Stage6 Yearly Regime Robustness v2" as const;
const YEARS = Array.from({ length: 11 }, (_, index) => 2016 + index);
const COMPLETE_YEARS = YEARS.filter((year) => year <= 2025);
const HORIZON = 20;
const COST_BPS = 20;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const MA_LOOKBACK = 120;
const RETURN_LOOKBACK = 60;
const BULL_RETURN_THRESHOLD = 5;
const BEAR_RETURN_THRESHOLD = -5;

type Regime = "BULL" | "NEUTRAL" | "BEAR";
type StrategyId = "BASELINE_ONSET8" | "FILTER_POSITIVE" | "FILTER_Q4PLUS";

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
  onset8: boolean;
  signalIndex: number;
  regime: Regime;
}
interface Trade {
  year: number;
  regime: Regime;
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
interface YearlyRow {
  year: number;
  regime: Regime;
  strategy: StrategyId;
  trades: number;
  avgReturnPct: number | null;
  medianReturnPct: number | null;
  winRatePct: number | null;
  avgExcessPct: number | null;
  medianExcessPct: number | null;
  excessWinRatePct: number | null;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node scripts/run-v8-kospi-rsaccel-stage6-yearly-regime-3fos.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--source-manifest") {
      options.sourceManifest = argv[++index] ?? usage("--source-manifest 값이 없습니다.");
    } else if (arg === "--source-cache-dir") {
      options.sourceCacheDir = argv[++index] ?? usage("--source-cache-dir 값이 없습니다.");
    } else if (arg === "--supabase-user-id") {
      options.userId = argv[++index] ?? usage("--supabase-user-id 값이 없습니다.");
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
  ) {
    throw new Error("지원하지 않거나 손상된 source cache manifest입니다.");
  }
  const texts: string[] = [];
  for (const file of manifest.files) {
    const bytes = new Uint8Array(await readFile(path.join(cacheDir, file.cacheFile)));
    const fileHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== file.bytes || fileHash !== file.fileHash) {
      throw new Error(`source cache 무결성 검증 실패: ${file.fileName}`);
    }
    texts.push(decodeSourceBytes(bytes));
  }
  process.stderr.write(
    `KOSPI RSAccel stage6 source cache verified: ${manifest.fileCount} files / ${(manifest.totalBytes / 1_000_000).toFixed(1)} MB\n`,
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

function adjustedScore10(baseScore9p5: number | null, sectorPriceLeadership: number | null) {
  if (!finite(baseScore9p5)) return null;
  const available = finite(sectorPriceLeadership);
  const overheated = available && sectorPriceLeadership >= SECTOR_OVERHEAT_THRESHOLD;
  return Math.round((baseScore9p5 + (available && !overheated ? SECTOR_SLOT : 0)) * 100) / 100;
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
  return (
    (currentStock.close / pastStock.close - 1) * 100 -
    (currentBenchmark.close / pastBenchmark.close - 1) * 100
  );
}

function regimeAt(date: string, benchmark: ReturnType<typeof benchmarkSeries>): Regime | null {
  const index = benchmark.indexByDate.get(date);
  if (index === undefined || index < Math.max(MA_LOOKBACK - 1, RETURN_LOOKBACK)) return null;
  const current = benchmark.bars[index];
  const past = benchmark.bars[index - RETURN_LOOKBACK];
  if (
    !current ||
    !past ||
    !finite(current.close) ||
    !finite(past.close) ||
    past.close <= 0
  ) {
    return null;
  }
  const maBars = benchmark.bars.slice(index - MA_LOOKBACK + 1, index + 1);
  if (maBars.length !== MA_LOOKBACK || maBars.some((bar) => !finite(bar.close))) return null;
  const movingAverage = maBars.reduce((sum, bar) => sum + bar.close, 0) / MA_LOOKBACK;
  const return60 = (current.close / past.close - 1) * 100;
  if (current.close > movingAverage && return60 > BULL_RETURN_THRESHOLD) return "BULL";
  if (current.close < movingAverage && return60 < BEAR_RETURN_THRESHOLD) return "BEAR";
  return "NEUTRAL";
}

function ranks(values: number[]) {
  const indexed = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  let index = 0;
  while (index < indexed.length) {
    let next = index + 1;
    while (next < indexed.length && indexed[next]!.value === indexed[index]!.value) next++;
    const averageRank = (index + 1 + next) / 2;
    for (let cursor = index; cursor < next; cursor++) {
      result[indexed[cursor]!.index] = averageRank;
    }
    index = next;
  }
  return result;
}

function dailyQuintiles(rows: Observation[]) {
  const byDate = new Map<string, Observation[]>();
  for (const row of rows) {
    const bucket = byDate.get(row.date) ?? [];
    bucket.push(row);
    byDate.set(row.date, bucket);
  }
  const result = new Map<string, 1 | 2 | 3 | 4 | 5>();
  for (const [date, dateRows] of byDate) {
    if (dateRows.length < 5) continue;
    const rsRanks = ranks(dateRows.map((row) => row.rsAccel));
    for (let index = 0; index < dateRows.length; index++) {
      const quintile = Math.min(
        5,
        Math.max(1, Math.floor(((rsRanks[index]! - 1) * 5) / dateRows.length) + 1),
      ) as 1 | 2 | 3 | 4 | 5;
      result.set(`${date}|${dateRows[index]!.symbol}`, quintile);
    }
  }
  return result;
}

function selectStrategy(
  strategy: StrategyId,
  rows: Observation[],
  quintiles: Map<string, 1 | 2 | 3 | 4 | 5>,
) {
  if (strategy === "BASELINE_ONSET8") return rows.filter((row) => row.onset8);
  if (strategy === "FILTER_POSITIVE") {
    return rows.filter((row) => row.onset8 && row.rsAccel > 0);
  }
  return rows.filter(
    (row) => row.onset8 && (quintiles.get(`${row.date}|${row.symbol}`) ?? 0) >= 4,
  );
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

function buildYearTrades(
  year: number,
  strategy: StrategyId,
  rows: Observation[],
  quintiles: Map<string, 1 | 2 | 3 | 4 | 5>,
  seriesBySymbol: Map<string, { bars: DailyPrice[] }>,
  benchmark: ReturnType<typeof benchmarkSeries>,
) {
  const candidates: Trade[] = [];
  for (const signal of selectStrategy(strategy, rows, quintiles)) {
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
    ) {
      continue;
    }
    const benchmarkRet = benchmarkReturn(benchmark, entry.tradeDate, exit.tradeDate);
    if (!finite(benchmarkRet)) continue;
    const grossReturnPct = (exit.close / entry.open - 1) * 100;
    candidates.push({
      year,
      regime: signal.regime,
      strategy,
      symbol: signal.symbol,
      signalDate: signal.date,
      entryDate: entry.tradeDate,
      exitDate: exit.tradeDate,
      grossReturnPct,
      benchmarkReturnPct: benchmarkRet,
      netReturnPct: grossReturnPct - COST_BPS / 100,
      netExcessPct: grossReturnPct - benchmarkRet - COST_BPS / 100,
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

function robustnessSummary(
  yearly: YearlyRow[],
  regimes: Regime[],
  strategies: StrategyId[],
  includedYears: number[],
) {
  return regimes.flatMap((regime) =>
    strategies.map((strategy) => {
      const rows = yearly.filter(
        (row) =>
          includedYears.includes(row.year) &&
          row.regime === regime &&
          row.strategy === strategy &&
          row.trades > 0,
      );
      const baselineByYear = new Map(
        yearly
          .filter(
            (row) =>
              includedYears.includes(row.year) &&
              row.regime === regime &&
              row.strategy === "BASELINE_ONSET8" &&
              row.trades > 0,
          )
          .map((row) => [row.year, row.avgExcessPct]),
      );
      const deltas = rows
        .filter(
          (row) => finite(row.avgExcessPct) && finite(baselineByYear.get(row.year)),
        )
        .map((row) => row.avgExcessPct! - baselineByYear.get(row.year)!);
      const totalTrades = rows.reduce((sum, row) => sum + row.trades, 0);
      const pooledAvgExcessPct = totalTrades
        ? rows.reduce((sum, row) => sum + (row.avgExcessPct ?? 0) * row.trades, 0) /
          totalTrades
        : null;
      const tradeCounts = rows.map((row) => row.trades);
      return {
        regime,
        strategy,
        yearsWithTrades: rows.length,
        totalTrades,
        minYearTrades: tradeCounts.length ? Math.min(...tradeCounts) : 0,
        medianYearTrades: round(median(tradeCounts)),
        meanYearAvgExcessPct: round(
          average(rows.map((row) => row.avgExcessPct).filter(finite)),
        ),
        medianYearAvgExcessPct: round(
          median(rows.map((row) => row.avgExcessPct).filter(finite)),
        ),
        pooledAvgExcessPct: round(pooledAvgExcessPct),
        positiveExcessYears: rows.filter(
          (row) => finite(row.avgExcessPct) && row.avgExcessPct > 0,
        ).length,
        positiveDeltaYears:
          strategy === "BASELINE_ONSET8" ? null : deltas.filter((value) => value > 0).length,
        meanDeltaVsBaselinePct:
          strategy === "BASELINE_ONSET8" ? 0 : round(average(deltas)),
        medianDeltaVsBaselinePct:
          strategy === "BASELINE_ONSET8" ? 0 : round(median(deltas)),
      };
    }),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(
    options.sourceManifest,
    options.sourceCacheDir,
  );
  const parsed = parseManualMarketData(texts);
  const dataset = parsed.dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const benchmark = benchmarkSeries(dataset);
  const kospiSeries = context.series.filter((series) => series.market === "KOSPI");

  const observations: Observation[] = [];
  const seriesBySymbol = new Map<string, { bars: DailyPrice[] }>();
  for (const series of kospiSeries) {
    const scores = series.baseScores.map((base, index) =>
      adjustedScore10(base, series.sectorPriceLeadership[index] ?? null),
    );
    const dateIndex = new Map(series.bars.map((bar, index) => [bar.tradeDate, index]));
    seriesBySymbol.set(series.symbol, { bars: series.bars });
    for (let index = 1; index + HORIZON < series.bars.length; index++) {
      const bar = series.bars[index]!;
      const year = Number(bar.tradeDate.slice(0, 4));
      if (!YEARS.includes(year)) continue;
      const score = scores[index];
      const previousScore = scores[index - 1];
      if (!finite(score)) continue;
      const rs20 = alignedRelativeStrength(
        series.bars,
        dateIndex,
        bar.tradeDate,
        benchmark,
        20,
      );
      const rs60 = alignedRelativeStrength(
        series.bars,
        dateIndex,
        bar.tradeDate,
        benchmark,
        60,
      );
      const regime = regimeAt(bar.tradeDate, benchmark);
      if (!finite(rs20) || !finite(rs60) || !regime) continue;
      observations.push({
        date: bar.tradeDate,
        symbol: series.symbol,
        score,
        rs20,
        rs60,
        rsAccel: rs20 - rs60,
        onset8:
          finite(previousScore) &&
          previousScore < ONSET_THRESHOLD &&
          score >= ONSET_THRESHOLD,
        signalIndex: index,
        regime,
      });
    }
  }

  const quintiles = dailyQuintiles(observations);
  const strategies: StrategyId[] = [
    "BASELINE_ONSET8",
    "FILTER_POSITIVE",
    "FILTER_Q4PLUS",
  ];
  const regimes: Regime[] = ["BULL", "NEUTRAL", "BEAR"];
  const yearly: YearlyRow[] = [];

  for (const year of YEARS) {
    const yearRows = observations.filter((row) => Number(row.date.slice(0, 4)) === year);
    for (const strategy of strategies) {
      // 중복보유 억제는 국면을 나누기 전에 연도 전체 신호에 적용한다.
      // 따라서 Bull→Neutral 등 국면 전환 중 기존 보유가 새 신호를 차단하는 실제 운용 상태가 보존된다.
      const accepted = buildYearTrades(
        year,
        strategy,
        yearRows,
        quintiles,
        seriesBySymbol,
        benchmark,
      );
      for (const regime of regimes) {
        yearly.push({
          year,
          regime,
          strategy,
          ...summarize(accepted.filter((trade) => trade.regime === regime)),
        });
      }
    }
  }

  const regimeCounts = regimes.map((regime) => ({
    regime,
    onsetSignals: observations.filter((row) => row.onset8 && row.regime === regime).length,
    years: [
      ...new Set(
        observations
          .filter((row) => row.onset8 && row.regime === regime)
          .map((row) => Number(row.date.slice(0, 4))),
      ),
    ].sort((a, b) => a - b),
  }));

  const result = {
    studyVersion: STUDY_VERSION,
    createdAt: new Date().toISOString(),
    datasetVersion: dataset.version,
    asOfDate: dataset.asOfDate,
    source: {
      cacheKey: manifest.cacheKey,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
    },
    methodology: {
      years: YEARS,
      completeYearSummary: COMPLETE_YEARS,
      horizon: HORIZON,
      costBps: COST_BPS,
      entry: "NEXT_OPEN",
      exit: "HORIZON_CLOSE",
      duplicateHoldingRule:
        "Within each calendar year and strategy, ignore a new same-symbol entry while already held; apply before regime grouping.",
      regime: {
        bull: "KOSPI close > MA120 and trailing 60D return > +5%",
        bear: "KOSPI close < MA120 and trailing 60D return < -5%",
        neutral: "otherwise",
      },
      strategies,
    },
    regimeCounts,
    yearly,
    robustnessAllAvailableYears: robustnessSummary(yearly, regimes, strategies, YEARS),
    robustnessCompleteYears: robustnessSummary(yearly, regimes, strategies, COMPLETE_YEARS),
  };

  await mkdir("analysis-runs", { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const outputPath = path.resolve(
    `analysis-runs/v8-kospi-rsaccel-stage6-yearly-regime-${stamp}.json`,
  );
  await writeFile(outputPath, JSON.stringify(result, null, 2));

  let remotePath: string | null = null;
  if (options.upload && options.userId) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kospi-rsaccel-stage6-yearly-regime/${stamp}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(
      client,
      `${options.userId}/results/v8-kospi-rsaccel-stage6-yearly-regime/latest.json`,
      result,
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        outputPath,
        remotePath,
        regimeCounts,
        robustnessCompleteYears: result.robustnessCompleteYears,
      },
      null,
      2,
    ) + "\n",
  );
}

void main();
