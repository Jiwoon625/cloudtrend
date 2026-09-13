import type { MarketDataset } from "./dataset";
import { adjustSectorPenaltyScore } from "./sectorScoreAdjustment";
import { buildPortfolioSignalContext } from "./sectorPenaltyPortfolioSignals";
import type { DailyPrice } from "./types";

export const V8_ENTRY_ONSET_VERSION = "CloudTrend V8 Entry Onset Threshold Validation" as const;
export const V8_ENTRY_ONSET_THRESHOLDS = [60, 65, 70, 75, 80] as const;
export const V8_ENTRY_ONSET_HORIZONS = [5, 10, 20, 30, 40, 60] as const;
export const V8_ENTRY_ONSET_PL_OVERHEAT_THRESHOLD = 80 as const;

export type V8EntrySplit = "ALL" | "DEVELOPMENT" | "VALIDATION" | "OOS";
export type V8EntryMarket = "ALL" | "KOSPI" | "KOSDAQ";
type StockMarket = Exclude<V8EntryMarket, "ALL">;

export interface V8EntryOnsetOptions {
  limit?: number;
  thresholds?: number[];
  horizons?: number[];
  warmupDays?: number;
  roundTripCostBps?: number;
  priceLeadershipOverheatThreshold?: number;
}

export interface V8EntryOnsetMetricRow {
  scope: "SPLIT" | "YEAR";
  split: V8EntrySplit | null;
  year: number | null;
  market: V8EntryMarket;
  threshold: number;
  horizon: number;
  count: number;
  signalDates: number;
  avgSignalsPerDate: number | null;
  overlapCount: number;
  overlapRate: number | null;
  avgPriorScore10: number | null;
  avgOnsetScore10: number | null;
  avgScoreJump10: number | null;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoffRatio: number | null;
  profitFactor: number | null;
  avgExcessReturn: number | null;
  medianExcessReturn: number | null;
  excessWinRate: number | null;
  avgMae: number | null;
  avgMfe: number | null;
  dailyAvgReturnHacMean: number | null;
  dailyAvgReturnHacT: number | null;
  dailyAvgReturnCiLow: number | null;
  dailyAvgReturnCiHigh: number | null;
  dailyAvgExcessHacMean: number | null;
  dailyAvgExcessHacT: number | null;
  dailyAvgExcessCiLow: number | null;
  dailyAvgExcessCiHigh: number | null;
}

export interface V8EntryThresholdComparisonRow {
  scope: "SPLIT" | "YEAR";
  split: V8EntrySplit | null;
  year: number | null;
  market: V8EntryMarket;
  horizon: number;
  eligibleThresholds: number;
  spearmanThresholdAvgReturn: number | null;
  spearmanThresholdAvgExcess: number | null;
  spearmanThresholdMedianExcess: number | null;
  bestAvgReturnThreshold: number | null;
  bestAvgExcessThreshold: number | null;
  bestMedianExcessThreshold: number | null;
  bestProfitFactorThreshold: number | null;
  bestExcessWinRateThreshold: number | null;
}

export interface V8EntryThresholdRobustnessRow {
  split: "ALL" | "OOS";
  market: V8EntryMarket;
  threshold: number;
  horizonsTested: number;
  positiveAvgExcessHorizons: number;
  positiveMedianExcessHorizons: number;
  significantPositiveDailyExcessHorizons: number;
  medianAvgReturn: number | null;
  medianAvgExcessReturn: number | null;
  medianMedianExcessReturn: number | null;
  medianProfitFactor: number | null;
  medianExcessWinRate: number | null;
  medianOverlapRate: number | null;
}

export interface V8EntryOnsetResult {
  version: typeof V8_ENTRY_ONSET_VERSION;
  from: string;
  to: string;
  symbolCount: number;
  thresholds: number[];
  horizons: number[];
  warmupDays: number;
  roundTripCostBps: number;
  priceLeadershipOverheatThreshold: number;
  onsetDefinition: "previous-score-below-threshold-and-current-score-at-or-above-threshold";
  entryExecution: "NEXT_OPEN";
  exitExecution: "HORIZON_CLOSE";
  splitPolicy: {
    method: "chronological-60-20-20";
    developmentFrom: string | null;
    validationFrom: string | null;
    oosFrom: string | null;
  };
  scorePolicy: {
    baseScoreMax: 9.5;
    sectorSlotPoints: 0.5;
    missingSectorPriceLeadership: "no-sector-slot";
    normalSectorPriceLeadership: "+0.5";
    overheatedSectorPriceLeadership: "no-net-sector-slot";
  };
  rows: V8EntryOnsetMetricRow[];
  comparisons: V8EntryThresholdComparisonRow[];
  robustness: V8EntryThresholdRobustnessRow[];
  notes: string[];
}

interface DailyAcc {
  retSum: number;
  retN: number;
  excessSum: number;
  excessN: number;
}

interface MetricAcc {
  count: number;
  dates: Set<string>;
  overlaps: number;
  priorScoreSum: number;
  onsetScoreSum: number;
  scoreJumpSum: number;
  returns: number[];
  returnSum: number;
  positive: number;
  winSum: number;
  winN: number;
  lossSum: number;
  lossN: number;
  profitSum: number;
  lossAbsSum: number;
  excessReturns: number[];
  excessSum: number;
  excessPositive: number;
  maeSum: number;
  maeN: number;
  mfeSum: number;
  mfeN: number;
  daily: Map<string, DailyAcc>;
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

function makeMetricAcc(): MetricAcc {
  return {
    count: 0,
    dates: new Set<string>(),
    overlaps: 0,
    priorScoreSum: 0,
    onsetScoreSum: 0,
    scoreJumpSum: 0,
    returns: [],
    returnSum: 0,
    positive: 0,
    winSum: 0,
    winN: 0,
    lossSum: 0,
    lossN: 0,
    profitSum: 0,
    lossAbsSum: 0,
    excessReturns: [],
    excessSum: 0,
    excessPositive: 0,
    maeSum: 0,
    maeN: 0,
    mfeSum: 0,
    mfeN: 0,
    daily: new Map<string, DailyAcc>(),
  };
}

function addMetric(
  acc: MetricAcc,
  date: string,
  priorScore: number,
  onsetScore: number,
  ret: number,
  excess: number | null,
  mae: number | null,
  mfe: number | null,
  overlap: boolean,
) {
  acc.count++;
  acc.dates.add(date);
  acc.overlaps += overlap ? 1 : 0;
  acc.priorScoreSum += priorScore;
  acc.onsetScoreSum += onsetScore;
  acc.scoreJumpSum += onsetScore - priorScore;
  acc.returns.push(ret);
  acc.returnSum += ret;
  acc.positive += ret > 0 ? 1 : 0;
  if (ret > 0) {
    acc.winSum += ret;
    acc.winN++;
    acc.profitSum += ret;
  } else if (ret < 0) {
    acc.lossSum += ret;
    acc.lossN++;
    acc.lossAbsSum += Math.abs(ret);
  }
  if (finite(excess)) {
    acc.excessReturns.push(excess);
    acc.excessSum += excess;
    acc.excessPositive += excess > 0 ? 1 : 0;
  }
  if (finite(mae)) { acc.maeSum += mae; acc.maeN++; }
  if (finite(mfe)) { acc.mfeSum += mfe; acc.mfeN++; }
  let daily = acc.daily.get(date);
  if (!daily) {
    daily = { retSum: 0, retN: 0, excessSum: 0, excessN: 0 };
    acc.daily.set(date, daily);
  }
  daily.retSum += ret;
  daily.retN++;
  if (finite(excess)) {
    daily.excessSum += excess;
    daily.excessN++;
  }
}

function ranks(values: number[]) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i + 1;
    while (j < indexed.length && indexed[j]!.value === indexed[i]!.value) j++;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) out[indexed[k]!.index] = rank;
    i = j;
  }
  return out;
}

function spearman(xs: number[], ys: number[]) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const rx = ranks(xs), ry = ranks(ys);
  const mx = average(rx)!, my = average(ry)!;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < rx.length; i++) {
    const dx = rx[i]! - mx, dy = ry[i]! - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  const denom = Math.sqrt(vx * vy);
  return denom > 0 ? cov / denom : null;
}

export function neweyWestMeanForOnsetTest(values: number[], lag: number) {
  const xs = values.filter(Number.isFinite);
  const n = xs.length;
  if (!n) return { mean: null, t: null, ciLow: null, ciHigh: null, n: 0 };
  const m = average(xs)!;
  if (n < 2) return { mean: m, t: null, ciLow: null, ciHigh: null, n };
  const centered = xs.map((value) => value - m);
  let lrv = centered.reduce((sum, value) => sum + value * value, 0) / n;
  const maxLag = Math.min(Math.max(0, Math.floor(lag)), n - 1);
  for (let l = 1; l <= maxLag; l++) {
    let gamma = 0;
    for (let t = l; t < n; t++) gamma += centered[t]! * centered[t - l]!;
    gamma /= n;
    lrv += 2 * (1 - l / (maxLag + 1)) * gamma;
  }
  const se = Math.sqrt(Math.max(0, lrv) / n);
  if (!(se > 0)) return { mean: m, t: null, ciLow: m, ciHigh: m, n };
  return { mean: m, t: m / se, ciLow: m - 1.96 * se, ciHigh: m + 1.96 * se, n };
}

export function crossedEntryOnsetForTest(prevScore10: number | null, currentScore10: number | null, threshold: number) {
  if (!finite(prevScore10) || !finite(currentScore10)) return false;
  const p = prevScore10 * 10;
  const c = currentScore10 * 10;
  return p < threshold && c >= threshold;
}

function benchmarkMaps(dataset: MarketDataset) {
  const maps = new Map<StockMarket, Map<string, DailyPrice>>();
  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    const series = dataset.indexSeries.find((item) => item.indexCode === market);
    maps.set(market, new Map((series?.bars ?? []).map((bar) => [bar.tradeDate, bar])));
  }
  return maps;
}

function benchmarkReturn(
  maps: Map<StockMarket, Map<string, DailyPrice>>,
  market: StockMarket,
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
    mae: entryPrice > 0 ? (low / entryPrice - 1) * 100 : null,
    mfe: entryPrice > 0 ? (high / entryPrice - 1) * 100 : null,
  };
}

function buildSplitPolicy(allDates: string[]) {
  const dates = [...new Set(allDates)].sort();
  if (!dates.length) return { developmentFrom: null, validationFrom: null, oosFrom: null };
  const validationIndex = Math.min(dates.length - 1, Math.floor(dates.length * 0.6));
  const oosIndex = Math.min(dates.length - 1, Math.floor(dates.length * 0.8));
  return {
    developmentFrom: dates[0] ?? null,
    validationFrom: dates[validationIndex] ?? null,
    oosFrom: dates[oosIndex] ?? null,
  };
}

function splitForDate(date: string, policy: { validationFrom: string | null; oosFrom: string | null }): Exclude<V8EntrySplit, "ALL"> {
  if (policy.oosFrom && date >= policy.oosFrom) return "OOS";
  if (policy.validationFrom && date >= policy.validationFrom) return "VALIDATION";
  return "DEVELOPMENT";
}

function metricKey(
  scope: "SPLIT" | "YEAR",
  split: V8EntrySplit | null,
  year: number | null,
  market: V8EntryMarket,
  threshold: number,
  horizon: number,
) {
  return `${scope}|${split ?? ""}|${year ?? ""}|${market}|${threshold}|${horizon}`;
}

function finalizeMetric(
  meta: Omit<V8EntryOnsetMetricRow,
    "count" | "signalDates" | "avgSignalsPerDate" | "overlapCount" | "overlapRate" |
    "avgPriorScore10" | "avgOnsetScore10" | "avgScoreJump10" | "avgReturn" | "medianReturn" |
    "winRate" | "avgWin" | "avgLoss" | "payoffRatio" | "profitFactor" | "avgExcessReturn" |
    "medianExcessReturn" | "excessWinRate" | "avgMae" | "avgMfe" | "dailyAvgReturnHacMean" |
    "dailyAvgReturnHacT" | "dailyAvgReturnCiLow" | "dailyAvgReturnCiHigh" | "dailyAvgExcessHacMean" |
    "dailyAvgExcessHacT" | "dailyAvgExcessCiLow" | "dailyAvgExcessCiHigh">,
  acc: MetricAcc,
): V8EntryOnsetMetricRow {
  const dailyRet = [...acc.daily.values()].filter((d) => d.retN > 0).map((d) => d.retSum / d.retN);
  const dailyExcess = [...acc.daily.values()].filter((d) => d.excessN > 0).map((d) => d.excessSum / d.excessN);
  const rawHac = neweyWestMeanForOnsetTest(dailyRet, meta.horizon - 1);
  const excessHac = neweyWestMeanForOnsetTest(dailyExcess, meta.horizon - 1);
  const avgWin = acc.winN ? acc.winSum / acc.winN : null;
  const avgLoss = acc.lossN ? acc.lossSum / acc.lossN : null;
  return {
    ...meta,
    count: acc.count,
    signalDates: acc.dates.size,
    avgSignalsPerDate: acc.dates.size ? round(acc.count / acc.dates.size) : null,
    overlapCount: acc.overlaps,
    overlapRate: acc.count ? round((acc.overlaps / acc.count) * 100) : null,
    avgPriorScore10: acc.count ? round(acc.priorScoreSum / acc.count) : null,
    avgOnsetScore10: acc.count ? round(acc.onsetScoreSum / acc.count) : null,
    avgScoreJump10: acc.count ? round(acc.scoreJumpSum / acc.count) : null,
    avgReturn: acc.count ? round(acc.returnSum / acc.count) : null,
    medianReturn: round(median(acc.returns)),
    winRate: acc.count ? round((acc.positive / acc.count) * 100) : null,
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    payoffRatio: finite(avgWin) && finite(avgLoss) && avgLoss < 0 ? round(avgWin / Math.abs(avgLoss)) : null,
    profitFactor: acc.lossAbsSum > 0 ? round(acc.profitSum / acc.lossAbsSum) : null,
    avgExcessReturn: acc.excessReturns.length ? round(acc.excessSum / acc.excessReturns.length) : null,
    medianExcessReturn: round(median(acc.excessReturns)),
    excessWinRate: acc.excessReturns.length ? round((acc.excessPositive / acc.excessReturns.length) * 100) : null,
    avgMae: acc.maeN ? round(acc.maeSum / acc.maeN) : null,
    avgMfe: acc.mfeN ? round(acc.mfeSum / acc.mfeN) : null,
    dailyAvgReturnHacMean: round(rawHac.mean),
    dailyAvgReturnHacT: round(rawHac.t),
    dailyAvgReturnCiLow: round(rawHac.ciLow),
    dailyAvgReturnCiHigh: round(rawHac.ciHigh),
    dailyAvgExcessHacMean: round(excessHac.mean),
    dailyAvgExcessHacT: round(excessHac.t),
    dailyAvgExcessCiLow: round(excessHac.ciLow),
    dailyAvgExcessCiHigh: round(excessHac.ciHigh),
  };
}

function bestThreshold(rows: V8EntryOnsetMetricRow[], pick: (row: V8EntryOnsetMetricRow) => number | null) {
  let best: V8EntryOnsetMetricRow | null = null;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const value = pick(row);
    if (finite(value) && value > bestValue) { best = row; bestValue = value; }
  }
  return best?.threshold ?? null;
}

function correlation(rows: V8EntryOnsetMetricRow[], pick: (row: V8EntryOnsetMetricRow) => number | null) {
  const pairs = rows.map((row) => ({ x: row.threshold, y: pick(row) })).filter((v): v is { x: number; y: number } => finite(v.y));
  return pairs.length >= 2 ? spearman(pairs.map((v) => v.x), pairs.map((v) => v.y)) : null;
}

function comparisonFromRows(rows: V8EntryOnsetMetricRow[]): V8EntryThresholdComparisonRow | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.threshold - b.threshold);
  const first = sorted[0]!;
  return {
    scope: first.scope,
    split: first.split,
    year: first.year,
    market: first.market,
    horizon: first.horizon,
    eligibleThresholds: sorted.length,
    spearmanThresholdAvgReturn: round(correlation(sorted, (row) => row.avgReturn)),
    spearmanThresholdAvgExcess: round(correlation(sorted, (row) => row.avgExcessReturn)),
    spearmanThresholdMedianExcess: round(correlation(sorted, (row) => row.medianExcessReturn)),
    bestAvgReturnThreshold: bestThreshold(sorted, (row) => row.avgReturn),
    bestAvgExcessThreshold: bestThreshold(sorted, (row) => row.avgExcessReturn),
    bestMedianExcessThreshold: bestThreshold(sorted, (row) => row.medianExcessReturn),
    bestProfitFactorThreshold: bestThreshold(sorted, (row) => row.profitFactor),
    bestExcessWinRateThreshold: bestThreshold(sorted, (row) => row.excessWinRate),
  };
}

function robustnessRows(rows: V8EntryOnsetMetricRow[], thresholds: number[], horizons: number[]) {
  const out: V8EntryThresholdRobustnessRow[] = [];
  for (const split of ["ALL", "OOS"] as const) {
    for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
      for (const threshold of thresholds) {
        const selected = rows.filter((row) => row.scope === "SPLIT" && row.split === split && row.market === market && row.threshold === threshold && horizons.includes(row.horizon));
        if (!selected.length) continue;
        const vals = <K extends keyof V8EntryOnsetMetricRow>(key: K) => selected.map((row) => row[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        out.push({
          split,
          market,
          threshold,
          horizonsTested: selected.length,
          positiveAvgExcessHorizons: selected.filter((row) => finite(row.avgExcessReturn) && row.avgExcessReturn > 0).length,
          positiveMedianExcessHorizons: selected.filter((row) => finite(row.medianExcessReturn) && row.medianExcessReturn > 0).length,
          significantPositiveDailyExcessHorizons: selected.filter((row) => finite(row.dailyAvgExcessCiLow) && row.dailyAvgExcessCiLow > 0).length,
          medianAvgReturn: round(median(vals("avgReturn"))),
          medianAvgExcessReturn: round(median(vals("avgExcessReturn"))),
          medianMedianExcessReturn: round(median(vals("medianExcessReturn"))),
          medianProfitFactor: round(median(vals("profitFactor"))),
          medianExcessWinRate: round(median(vals("excessWinRate"))),
          medianOverlapRate: round(median(vals("overlapRate"))),
        });
      }
    }
  }
  return out;
}

export function buildV8EntryOnsetThresholdValidation(
  dataset: MarketDataset,
  options: V8EntryOnsetOptions = {},
): V8EntryOnsetResult | null {
  const limit = Math.max(1, Math.round(options.limit ?? 613));
  const thresholds = [...new Set((options.thresholds ?? [...V8_ENTRY_ONSET_THRESHOLDS]).map((v) => Math.round(v)).filter((v) => v >= 0 && v <= 100))].sort((a, b) => a - b);
  const horizons = [...new Set((options.horizons ?? [...V8_ENTRY_ONSET_HORIZONS]).map((v) => Math.round(v)).filter((v) => v >= 1 && v <= 252))].sort((a, b) => a - b);
  const warmupDays = Math.max(120, Math.round(options.warmupDays ?? 120));
  const roundTripCostBps = Math.max(0, options.roundTripCostBps ?? 0);
  const priceLeadershipOverheatThreshold = Math.max(0, Math.min(100, options.priceLeadershipOverheatThreshold ?? V8_ENTRY_ONSET_PL_OVERHEAT_THRESHOLD));
  if (!thresholds.length || !horizons.length) return null;

  const context = buildPortfolioSignalContext(dataset, limit);
  if (!context.series.length || !context.allDates.length) return null;
  const policy = buildSplitPolicy(context.allDates);
  const benchmarks = benchmarkMaps(dataset);
  const metrics = new Map<string, { meta: { scope: "SPLIT" | "YEAR"; split: V8EntrySplit | null; year: number | null; market: V8EntryMarket; threshold: number; horizon: number }; acc: MetricAcc }>();

  for (const series of context.series) {
    const market: StockMarket = series.market;
    const adjusted = series.baseScores.map((base, i) => {
      if (!finite(base)) return null;
      return adjustSectorPenaltyScore(base, series.sectorPriceLeadership[i] ?? null, priceLeadershipOverheatThreshold).score;
    });

    for (const threshold of thresholds) {
      let lastOnsetIndex: number | null = null;
      for (let i = warmupDays; i + 1 < series.bars.length; i++) {
        const priorScore = adjusted[i - 1];
        const onsetScore = adjusted[i];
        if (!crossedEntryOnsetForTest(priorScore, onsetScore, threshold)) continue;
        const signal = series.bars[i];
        const entry = series.bars[i + 1];
        if (!signal || !entry || !finite(entry.open) || entry.open <= 0) { lastOnsetIndex = i; continue; }
        const date = signal.tradeDate;
        const split = splitForDate(date, policy);
        const year = Number(date.slice(0, 4));
        for (const horizon of horizons) {
          const exit = series.bars[i + horizon];
          if (!exit || !finite(exit.close) || exit.close <= 0) continue;
          const ret = (exit.close / entry.open - 1) * 100 - roundTripCostBps / 100;
          const benchmark = benchmarkReturn(benchmarks, market, entry.tradeDate, exit.tradeDate);
          const excess = finite(benchmark) ? ret - benchmark : null;
          const ex = excursion(series.bars, i + 1, i + horizon, entry.open);
          const overlap = lastOnsetIndex !== null && i - lastOnsetIndex < horizon;
          const scopes: Array<{ scope: "SPLIT" | "YEAR"; split: V8EntrySplit | null; year: number | null }> = [
            { scope: "SPLIT", split: "ALL", year: null },
            { scope: "SPLIT", split, year: null },
            { scope: "YEAR", split: null, year },
          ];
          for (const marketGroup of ["ALL", market] as const) {
            for (const scope of scopes) {
              const key = metricKey(scope.scope, scope.split, scope.year, marketGroup, threshold, horizon);
              let group = metrics.get(key);
              if (!group) {
                group = { meta: { ...scope, market: marketGroup, threshold, horizon }, acc: makeMetricAcc() };
                metrics.set(key, group);
              }
              addMetric(group.acc, date, priorScore!, onsetScore!, ret, excess, ex.mae, ex.mfe, overlap);
            }
          }
        }
        lastOnsetIndex = i;
      }
    }
  }

  const rows = [...metrics.values()].map(({ meta, acc }) => finalizeMetric(meta, acc));
  rows.sort((a, b) => a.scope.localeCompare(b.scope) || String(a.split ?? a.year ?? "").localeCompare(String(b.split ?? b.year ?? "")) || a.market.localeCompare(b.market) || a.horizon - b.horizon || a.threshold - b.threshold);

  const comparisonGroups = new Map<string, V8EntryOnsetMetricRow[]>();
  for (const row of rows) {
    const key = `${row.scope}|${row.split ?? ""}|${row.year ?? ""}|${row.market}|${row.horizon}`;
    const list = comparisonGroups.get(key) ?? [];
    list.push(row);
    comparisonGroups.set(key, list);
  }
  const comparisons = [...comparisonGroups.values()].map(comparisonFromRows).filter((row): row is V8EntryThresholdComparisonRow => row !== null);
  comparisons.sort((a, b) => a.scope.localeCompare(b.scope) || String(a.split ?? a.year ?? "").localeCompare(String(b.split ?? b.year ?? "")) || a.market.localeCompare(b.market) || a.horizon - b.horizon);

  return {
    version: V8_ENTRY_ONSET_VERSION,
    from: context.allDates[0] ?? dataset.asOfDate,
    to: context.allDates.at(-1) ?? dataset.asOfDate,
    symbolCount: context.series.length,
    thresholds,
    horizons,
    warmupDays,
    roundTripCostBps,
    priceLeadershipOverheatThreshold,
    onsetDefinition: "previous-score-below-threshold-and-current-score-at-or-above-threshold",
    entryExecution: "NEXT_OPEN",
    exitExecution: "HORIZON_CLOSE",
    splitPolicy: { method: "chronological-60-20-20", ...policy },
    scorePolicy: {
      baseScoreMax: 9.5,
      sectorSlotPoints: 0.5,
      missingSectorPriceLeadership: "no-sector-slot",
      normalSectorPriceLeadership: "+0.5",
      overheatedSectorPriceLeadership: "no-net-sector-slot",
    },
    rows,
    comparisons,
    robustness: robustnessRows(rows, thresholds, horizons),
    notes: [
      "Thresholds are isolated as entry timing variables: no score-based exit rule is used in this validation.",
      "Onset requires both previous and current adjusted 10-point scores; missing-to-available transitions are not counted as onset.",
      "Signal is observed at day t close, entry is day t+1 open, and fixed-horizon exit is day t+h close.",
      "Market excess return uses the matching KOSPI/KOSDAQ index from the same entry open to exit close; no benchmark fallback is used.",
      "Overlap rate marks repeated same-symbol threshold onsets occurring before the prior fixed-horizon observation window ends.",
      "HAC inference is applied to daily cross-sectional mean signal outcomes with lag horizon-1 to reduce pseudo-replication from clustered and overlapping observations.",
    ],
  };
}
