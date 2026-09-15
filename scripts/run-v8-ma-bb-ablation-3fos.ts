import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildPortfolioSignalContext } from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { DailyPrice } from "../src/lib/engine/types";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8-10 MA/BB Ablation 3-FOS" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const HORIZONS = [20, 30, 40] as const;
const ENTRY_THRESHOLD_10 = 8;
const LIMIT = 613;
const ROUND_TRIP_COST_BPS = 0;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const BASE_MA_WEIGHT = 1;
const BASE_BB_WEIGHT = 1.5;
const OTHER_BASE_WEIGHT = 7;

type FoldYear = (typeof FOLD_YEARS)[number];
type Horizon = (typeof HORIZONS)[number];
type Market = "ALL" | "KOSPI" | "KOSDAQ";

interface Variant {
  id: string;
  label: string;
  maWeight: number;
  bbWeight: number;
}

const VARIANTS: Variant[] = [
  { id: "BASELINE", label: "Baseline · MA 1.0 · BB 1.5", maWeight: 1, bbWeight: 1.5 },
  { id: "NO_MA", label: "MA 제거 · MA 0 · BB 1.5", maWeight: 0, bbWeight: 1.5 },
  { id: "NO_BB", label: "BB 제거 · MA 1.0 · BB 0", maWeight: 1, bbWeight: 0 },
  { id: "NO_MA_BB", label: "MA+BB 제거 · MA 0 · BB 0", maWeight: 0, bbWeight: 0 },
];

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

interface DailyAcc {
  returnSum: number;
  returnN: number;
  excessSum: number;
  excessN: number;
}

interface MetricAcc {
  returns: number[];
  excessReturns: number[];
  positive: number;
  excessPositive: number;
  profitSum: number;
  lossAbsSum: number;
  mae: number[];
  mfe: number[];
  dates: Set<string>;
  daily: Map<string, DailyAcc>;
}

interface FoldMetricRow {
  variant: string;
  fold: FoldYear;
  market: Market;
  horizon: Horizon;
  count: number;
  signalDates: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  profitFactor: number | null;
  avgExcessReturn: number | null;
  medianExcessReturn: number | null;
  excessWinRate: number | null;
  avgMae: number | null;
  avgMfe: number | null;
  dailyAvgExcessHacMean: number | null;
  dailyAvgExcessHacT: number | null;
  dailyAvgExcessCiLow: number | null;
  dailyAvgExcessCiHigh: number | null;
}

interface AggregateRow {
  variant: string;
  market: Market;
  horizon: Horizon;
  foldsWithSignals: number;
  foldsPositiveAvgExcess: number;
  totalSignals: number;
  equalWeightAvgReturn: number | null;
  equalWeightMedianReturn: number | null;
  equalWeightProfitFactor: number | null;
  equalWeightAvgExcess: number | null;
  equalWeightMedianExcess: number | null;
  equalWeightExcessWinRate: number | null;
  worstFoldAvgExcess: number | null;
  bestFoldAvgExcess: number | null;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node scripts/run-v8-ma-bb-ablation-3fos.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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
  process.stderr.write(`V8-10 source cache verified: ${manifest.fileCount} files / ${(manifest.totalBytes / 1_000_000).toFixed(1)} MB\n`);
  return { texts, manifest };
}

function prefix(values: number[]) {
  const sums = new Array<number>(values.length + 1).fill(0);
  const squares = new Array<number>(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    sums[i + 1] = sums[i]! + value;
    squares[i + 1] = squares[i]! + value * value;
  }
  return { sums, squares };
}

function windowMean(sums: number[], endIndex: number, period: number) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  return (sums[endIndex + 1]! - sums[start]!) / period;
}

function featureFlags(bars: DailyPrice[]) {
  const closes = bars.map((bar) => bar.close);
  const { sums, squares } = prefix(closes);
  const maAligned = new Array<boolean | null>(bars.length).fill(null);
  const bbBreakout = new Array<boolean | null>(bars.length).fill(null);

  for (let i = 0; i < bars.length; i++) {
    const ma20 = windowMean(sums, i, 20);
    const ma60 = windowMean(sums, i, 60);
    const ma120 = windowMean(sums, i, 120);
    if (ma20 !== null && ma60 !== null && ma120 !== null)
      maAligned[i] = ma20 > ma60 && ma60 > ma120;

    if (i >= 19 && ma20 !== null) {
      const start = i - 19;
      const meanSq = (squares[i + 1]! - squares[start]!) / 20;
      const variance = Math.max(0, meanSq - ma20 * ma20);
      const upper = ma20 + 2 * Math.sqrt(variance);
      bbBreakout[i] = closes[i]! > upper;
    }
  }
  return { maAligned, bbBreakout };
}

function variantMax(variant: Variant) {
  return OTHER_BASE_WEIGHT + variant.maWeight + variant.bbWeight + SECTOR_SLOT;
}

function adjustedNormalizedScore(
  baselineBase9p5: number | null,
  maAligned: boolean | null,
  bbBreakout: boolean | null,
  sectorPriceLeadership: number | null,
  variant: Variant,
) {
  if (!finite(baselineBase9p5) || maAligned === null || bbBreakout === null) return null;
  let base = baselineBase9p5;
  if (maAligned) base -= BASE_MA_WEIGHT;
  if (bbBreakout) base -= BASE_BB_WEIGHT;
  if (maAligned) base += variant.maWeight;
  if (bbBreakout) base += variant.bbWeight;

  const sectorAvailable = finite(sectorPriceLeadership);
  const sectorOverheated = sectorAvailable && sectorPriceLeadership >= SECTOR_OVERHEAT_THRESHOLD;
  const sectorContribution = sectorAvailable && !sectorOverheated ? SECTOR_SLOT : 0;
  const rawAdjusted = Math.round((base + sectorContribution) * 100) / 100;
  return (rawAdjusted / variantMax(variant)) * 10;
}

function crossed80(previous: number | null, current: number | null) {
  return finite(previous) && finite(current) && previous < ENTRY_THRESHOLD_10 && current >= ENTRY_THRESHOLD_10;
}

function benchmarkMaps(dataset: MarketDataset) {
  const out = new Map<"KOSPI" | "KOSDAQ", Map<string, DailyPrice>>();
  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    const series = dataset.indexSeries.find((item) => item.indexCode === market);
    out.set(market, new Map((series?.bars ?? []).map((bar) => [bar.tradeDate, bar])));
  }
  return out;
}

function benchmarkReturn(
  maps: ReturnType<typeof benchmarkMaps>,
  market: "KOSPI" | "KOSDAQ",
  entryDate: string,
  exitDate: string,
) {
  const entry = maps.get(market)?.get(entryDate);
  const exit = maps.get(market)?.get(exitDate);
  if (!entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exit.close) || exit.close <= 0) return null;
  return (exit.close / entry.open - 1) * 100;
}

function excursion(bars: DailyPrice[], entryIndex: number, exitIndex: number, entryPrice: number) {
  let low = entryPrice;
  let high = entryPrice;
  for (let i = entryIndex; i <= exitIndex; i++) {
    const bar = bars[i];
    if (!bar) break;
    if (finite(bar.low) && bar.low > 0) low = Math.min(low, bar.low);
    if (finite(bar.high) && bar.high > 0) high = Math.max(high, bar.high);
  }
  return {
    mae: (low / entryPrice - 1) * 100,
    mfe: (high / entryPrice - 1) * 100,
  };
}

function neweyWestMean(values: number[], lag: number) {
  const xs = values.filter(Number.isFinite);
  const n = xs.length;
  if (!n) return { mean: null, t: null, ciLow: null, ciHigh: null };
  const mean = average(xs)!;
  if (n < 2) return { mean, t: null, ciLow: null, ciHigh: null };
  const centered = xs.map((value) => value - mean);
  let lrv = centered.reduce((sum, value) => sum + value * value, 0) / n;
  const maxLag = Math.min(Math.max(0, Math.floor(lag)), n - 1);
  for (let l = 1; l <= maxLag; l++) {
    let gamma = 0;
    for (let t = l; t < n; t++) gamma += centered[t]! * centered[t - l]!;
    gamma /= n;
    lrv += 2 * (1 - l / (maxLag + 1)) * gamma;
  }
  const se = Math.sqrt(Math.max(0, lrv) / n);
  if (!(se > 0)) return { mean, t: null, ciLow: mean, ciHigh: mean };
  return { mean, t: mean / se, ciLow: mean - 1.96 * se, ciHigh: mean + 1.96 * se };
}

function makeAcc(): MetricAcc {
  return {
    returns: [],
    excessReturns: [],
    positive: 0,
    excessPositive: 0,
    profitSum: 0,
    lossAbsSum: 0,
    mae: [],
    mfe: [],
    dates: new Set<string>(),
    daily: new Map<string, DailyAcc>(),
  };
}

function addTrade(acc: MetricAcc, date: string, ret: number, excess: number | null, mae: number, mfe: number) {
  acc.returns.push(ret);
  acc.positive += ret > 0 ? 1 : 0;
  if (ret > 0) acc.profitSum += ret;
  else if (ret < 0) acc.lossAbsSum += Math.abs(ret);
  if (finite(excess)) {
    acc.excessReturns.push(excess);
    acc.excessPositive += excess > 0 ? 1 : 0;
  }
  acc.mae.push(mae);
  acc.mfe.push(mfe);
  acc.dates.add(date);
  const daily = acc.daily.get(date) ?? { returnSum: 0, returnN: 0, excessSum: 0, excessN: 0 };
  daily.returnSum += ret;
  daily.returnN += 1;
  if (finite(excess)) {
    daily.excessSum += excess;
    daily.excessN += 1;
  }
  acc.daily.set(date, daily);
}

function metricKey(variant: string, fold: FoldYear, market: Market, horizon: Horizon) {
  return `${variant}|${fold}|${market}|${horizon}`;
}

function finalizeMetric(variant: string, fold: FoldYear, market: Market, horizon: Horizon, acc: MetricAcc): FoldMetricRow {
  const dailyExcess = [...acc.daily.values()]
    .filter((row) => row.excessN > 0)
    .map((row) => row.excessSum / row.excessN);
  const hac = neweyWestMean(dailyExcess, horizon - 1);
  return {
    variant,
    fold,
    market,
    horizon,
    count: acc.returns.length,
    signalDates: acc.dates.size,
    avgReturn: round(average(acc.returns)),
    medianReturn: round(median(acc.returns)),
    winRate: acc.returns.length ? round((acc.positive / acc.returns.length) * 100) : null,
    profitFactor: acc.lossAbsSum > 0 ? round(acc.profitSum / acc.lossAbsSum) : null,
    avgExcessReturn: round(average(acc.excessReturns)),
    medianExcessReturn: round(median(acc.excessReturns)),
    excessWinRate: acc.excessReturns.length ? round((acc.excessPositive / acc.excessReturns.length) * 100) : null,
    avgMae: round(average(acc.mae)),
    avgMfe: round(average(acc.mfe)),
    dailyAvgExcessHacMean: round(hac.mean),
    dailyAvgExcessHacT: round(hac.t),
    dailyAvgExcessCiLow: round(hac.ciLow),
    dailyAvgExcessCiHigh: round(hac.ciHigh),
  };
}

function aggregateRows(rows: FoldMetricRow[]): AggregateRow[] {
  const result: AggregateRow[] = [];
  for (const variant of VARIANTS) {
    for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
      for (const horizon of HORIZONS) {
        const selected = rows.filter((row) => row.variant === variant.id && row.market === market && row.horizon === horizon && row.count > 0);
        const validExcess = selected.map((row) => row.avgExcessReturn).filter(finite);
        result.push({
          variant: variant.id,
          market,
          horizon,
          foldsWithSignals: selected.length,
          foldsPositiveAvgExcess: selected.filter((row) => finite(row.avgExcessReturn) && row.avgExcessReturn > 0).length,
          totalSignals: selected.reduce((sum, row) => sum + row.count, 0),
          equalWeightAvgReturn: round(average(selected.map((row) => row.avgReturn).filter(finite))),
          equalWeightMedianReturn: round(average(selected.map((row) => row.medianReturn).filter(finite))),
          equalWeightProfitFactor: round(average(selected.map((row) => row.profitFactor).filter(finite))),
          equalWeightAvgExcess: round(average(validExcess)),
          equalWeightMedianExcess: round(average(selected.map((row) => row.medianExcessReturn).filter(finite))),
          equalWeightExcessWinRate: round(average(selected.map((row) => row.excessWinRate).filter(finite))),
          worstFoldAvgExcess: validExcess.length ? round(Math.min(...validExcess)) : null,
          bestFoldAvgExcess: validExcess.length ? round(Math.max(...validExcess)) : null,
        });
      }
    }
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const parsed = parseManualMarketData(texts);
  const dataset = parsed.dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const benchmarks = benchmarkMaps(dataset);
  const metrics = new Map<string, MetricAcc>();

  for (const series of context.series) {
    const flags = featureFlags(series.bars);
    for (const variant of VARIANTS) {
      const scores = series.baseScores.map((base, index) =>
        adjustedNormalizedScore(
          base,
          flags.maAligned[index] ?? null,
          flags.bbBreakout[index] ?? null,
          series.sectorPriceLeadership[index] ?? null,
          variant,
        ),
      );
      for (let i = 120; i + 1 < series.bars.length; i++) {
        if (!crossed80(scores[i - 1] ?? null, scores[i] ?? null)) continue;
        const signal = series.bars[i]!;
        const year = Number(signal.tradeDate.slice(0, 4));
        if (!FOLD_YEARS.includes(year as FoldYear)) continue;
        const fold = year as FoldYear;
        const entry = series.bars[i + 1];
        if (!entry || !finite(entry.open) || entry.open <= 0) continue;
        for (const horizon of HORIZONS) {
          const exit = series.bars[i + horizon];
          if (!exit || !finite(exit.close) || exit.close <= 0) continue;
          const ret = (exit.close / entry.open - 1) * 100 - ROUND_TRIP_COST_BPS / 100;
          const benchmark = benchmarkReturn(benchmarks, series.market, entry.tradeDate, exit.tradeDate);
          const excess = finite(benchmark) ? ret - benchmark : null;
          const ex = excursion(series.bars, i + 1, i + horizon, entry.open);
          for (const market of ["ALL", series.market] as const) {
            const key = metricKey(variant.id, fold, market, horizon);
            const acc = metrics.get(key) ?? makeAcc();
            addTrade(acc, signal.tradeDate, ret, excess, ex.mae, ex.mfe);
            metrics.set(key, acc);
          }
        }
      }
    }
  }

  const foldRows: FoldMetricRow[] = [];
  for (const variant of VARIANTS) {
    for (const fold of FOLD_YEARS) {
      for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
        for (const horizon of HORIZONS) {
          const acc = metrics.get(metricKey(variant.id, fold, market, horizon)) ?? makeAcc();
          foldRows.push(finalizeMetric(variant.id, fold, market, horizon, acc));
        }
      }
    }
  }
  const aggregates = aggregateRows(foldRows);
  const baseline = aggregates.find((row) => row.variant === "BASELINE" && row.market === "KOSDAQ" && row.horizon === 30);
  const primaryComparison = aggregates
    .filter((row) => row.market === "KOSDAQ" && row.horizon === 30)
    .map((row) => ({
      ...row,
      deltaAvgExcessVsBaseline:
        finite(row.equalWeightAvgExcess) && finite(baseline?.equalWeightAvgExcess)
          ? round(row.equalWeightAvgExcess - baseline.equalWeightAvgExcess)
          : null,
      deltaMedianExcessVsBaseline:
        finite(row.equalWeightMedianExcess) && finite(baseline?.equalWeightMedianExcess)
          ? round(row.equalWeightMedianExcess - baseline.equalWeightMedianExcess)
          : null,
      deltaProfitFactorVsBaseline:
        finite(row.equalWeightProfitFactor) && finite(baseline?.equalWeightProfitFactor)
          ? round(row.equalWeightProfitFactor - baseline.equalWeightProfitFactor)
          : null,
    }));

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
      symbolCount: context.symbolCount,
    },
    design: {
      folds: [...FOLD_YEARS],
      horizons: [...HORIZONS],
      primaryMarket: "KOSDAQ",
      primaryHorizon: 30,
      onsetThresholdPercent: 80,
      entryExecution: "NEXT_OPEN",
      exitExecution: "HORIZON_CLOSE",
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      sectorSlotPoints: SECTOR_SLOT,
      sectorOverheatThreshold: SECTOR_OVERHEAT_THRESHOLD,
      normalization: "Each variant is divided by its own attainable max (including 0.5 sector slot) and rescaled to 10 points before the same 80% onset test.",
      fixedOtherWeights: {
        ICH_ABOVE_CLOUD: 1,
        ICH_TENKAN_KIJUN: 1,
        VOLUME_SURGE: 0.5,
        NEAR_52W_HIGH: 2.5,
        FOREIGN_NET_POSITIVE: 2,
      },
    },
    variants: VARIANTS.map((variant) => ({ ...variant, rawMaxIncludingSectorSlot: variantMax(variant) })),
    primaryComparison,
    aggregateRows: aggregates,
    foldRows,
    notes: [
      "Baseline uses the current 9.5-point Vf feature score plus the 0.5-point sector slot, with sector PL>=80 receiving no net sector slot, matching the strict V8 onset research convention.",
      "Only MA_ALIGNED and BB_BREAKOUT weights change. All other feature definitions, source data, sector-price-leadership values, execution timing, and benchmark logic are held fixed.",
      "Ablated variants are rescaled to a 10-point display scale before applying 80 Onset, preventing a mechanical threshold disadvantage from a lower raw maximum.",
      "Primary model-selection evidence is equal-weighted across the 2018, 2022, and 2025 folds rather than pooled by the largest fold.",
    ],
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `v8-10-ma-bb-ablation-3fos-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-10-ma-bb-ablation-3fos/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(client, `${options.userId}/results/v8-10-ma-bb-ablation-3fos/latest.json`, {
      version: STUDY_VERSION,
      createdAt,
      runId,
      resultPath: remotePath,
      primaryComparison,
    });
  }

  process.stdout.write(`${JSON.stringify({ outputPath, remotePath, primaryComparison }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
