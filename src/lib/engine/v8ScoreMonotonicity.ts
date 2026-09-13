import type { MarketDataset } from "./dataset";
import { adjustSectorPenaltyScore } from "./sectorScoreAdjustment";
import { buildPortfolioSignalContext } from "./sectorPenaltyPortfolioSignals";
import type { DailyPrice } from "./types";

export const V8_SCORE_MONOTONICITY_VERSION = "CloudTrend V8 10-Point Score Monotonicity" as const;
export const V8_SCORE_MONOTONICITY_HORIZONS = [5, 10, 20, 30, 40, 60] as const;
export const V8_SCORE_PL_OVERHEAT_THRESHOLD = 80 as const;

export type V8ScoreSplit = "ALL" | "DEVELOPMENT" | "VALIDATION" | "OOS";
export type V8ScoreMarket = "ALL" | "KOSPI" | "KOSDAQ";

type StockMarket = Exclude<V8ScoreMarket, "ALL">;

export interface V8ScoreMonotonicityOptions {
  limit?: number;
  horizons?: number[];
  warmupDays?: number;
  roundTripCostBps?: number;
  priceLeadershipOverheatThreshold?: number;
  minBucketN?: number;
  minBucketDates?: number;
  minDailyCrossSectionN?: number;
}

export interface V8ScoreBucketMetricRow {
  scope: "SPLIT" | "YEAR";
  split: V8ScoreSplit | null;
  year: number | null;
  market: V8ScoreMarket;
  horizon: number;
  score10: number;
  count: number;
  signalDates: number;
  avgSignalsPerDate: number | null;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  profitFactor: number | null;
  avgExcessReturn: number | null;
  medianExcessReturn: number | null;
  excessWinRate: number | null;
  sectorPriceLeadershipAvailableRate: number | null;
  sectorOverheatRate: number | null;
}

export interface V8ScoreMonotonicitySummaryRow {
  scope: "SPLIT" | "YEAR";
  split: V8ScoreSplit | null;
  year: number | null;
  market: V8ScoreMarket;
  horizon: number;
  eligibleBuckets: number;
  lowestEligibleScore: number | null;
  highestEligibleScore: number | null;
  spearmanAvgReturn: number | null;
  spearmanMedianReturn: number | null;
  spearmanAvgExcess: number | null;
  spearmanMedianExcess: number | null;
  adjacentAvgReturnUpRate: number | null;
  adjacentMedianReturnUpRate: number | null;
  adjacentAvgExcessUpRate: number | null;
  adjacentMedianExcessUpRate: number | null;
  endpointAvgReturnSpread: number | null;
  endpointMedianReturnSpread: number | null;
  endpointAvgExcessSpread: number | null;
  endpointMedianExcessSpread: number | null;
  bestAvgExcessScore: number | null;
  bestMedianExcessScore: number | null;
  dailyRawSlopeMean: number | null;
  dailyRawSlopeHacT: number | null;
  dailyRawSlopeCiLow: number | null;
  dailyRawSlopeCiHigh: number | null;
  dailyRawSlopeDates: number;
  dailyExcessSlopeMean: number | null;
  dailyExcessSlopeHacT: number | null;
  dailyExcessSlopeCiLow: number | null;
  dailyExcessSlopeCiHigh: number | null;
  dailyExcessSlopeDates: number;
}

export interface V8ScoreMonotonicityResult {
  version: typeof V8_SCORE_MONOTONICITY_VERSION;
  from: string;
  to: string;
  symbolCount: number;
  scoreMax: 10;
  horizons: number[];
  warmupDays: number;
  roundTripCostBps: number;
  priceLeadershipOverheatThreshold: number;
  bucketRule: "exact-observed-score";
  splitPolicy: {
    method: "chronological-60-20-20";
    developmentFrom: string | null;
    validationFrom: string | null;
    oosFrom: string | null;
  };
  eligibility: {
    minBucketN: number;
    minBucketDates: number;
    minDailyCrossSectionN: number;
  };
  scorePolicy: {
    baseScoreMax: 9.5;
    sectorSlotPoints: 0.5;
    missingSectorPriceLeadership: "no-sector-slot";
    normalSectorPriceLeadership: "+0.5";
    overheatedSectorPriceLeadership: "no-net-sector-slot";
  };
  rows: V8ScoreBucketMetricRow[];
  monotonicity: V8ScoreMonotonicitySummaryRow[];
  notes: string[];
}

interface MetricAcc {
  count: number;
  sumReturn: number;
  positiveReturn: number;
  profitSum: number;
  lossAbsSum: number;
  returns: number[];
  excessCount: number;
  sumExcess: number;
  positiveExcess: number;
  excessReturns: number[];
  dates: Set<string>;
  sectorAvailable: number;
  sectorOverheated: number;
}

interface RegressionAcc {
  n: number;
  sx: number;
  sy: number;
  sxx: number;
  sxy: number;
}

interface DailySlopeAcc {
  raw: RegressionAcc;
  excess: RegressionAcc;
}

interface DailySlopeRow {
  date: string;
  market: V8ScoreMarket;
  rawSlope: number | null;
  excessSlope: number | null;
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
    sumReturn: 0,
    positiveReturn: 0,
    profitSum: 0,
    lossAbsSum: 0,
    returns: [],
    excessCount: 0,
    sumExcess: 0,
    positiveExcess: 0,
    excessReturns: [],
    dates: new Set<string>(),
    sectorAvailable: 0,
    sectorOverheated: 0,
  };
}

function addMetric(
  acc: MetricAcc,
  date: string,
  ret: number,
  excess: number | null,
  sectorAvailable: boolean,
  sectorOverheated: boolean,
) {
  acc.count++;
  acc.sumReturn += ret;
  acc.positiveReturn += ret > 0 ? 1 : 0;
  if (ret > 0) acc.profitSum += ret;
  else if (ret < 0) acc.lossAbsSum += Math.abs(ret);
  acc.returns.push(ret);
  acc.dates.add(date);
  acc.sectorAvailable += sectorAvailable ? 1 : 0;
  acc.sectorOverheated += sectorOverheated ? 1 : 0;
  if (finite(excess)) {
    acc.excessCount++;
    acc.sumExcess += excess;
    acc.positiveExcess += excess > 0 ? 1 : 0;
    acc.excessReturns.push(excess);
  }
}

function makeRegressionAcc(): RegressionAcc {
  return { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0 };
}

function addRegression(acc: RegressionAcc, x: number, y: number) {
  acc.n++;
  acc.sx += x;
  acc.sy += y;
  acc.sxx += x * x;
  acc.sxy += x * y;
}

function regressionSlope(acc: RegressionAcc, minimumN: number) {
  if (acc.n < minimumN) return null;
  const denom = acc.sxx - (acc.sx * acc.sx) / acc.n;
  if (!finite(denom) || Math.abs(denom) < 1e-12) return null;
  const numer = acc.sxy - (acc.sx * acc.sy) / acc.n;
  return numer / denom;
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

export function spearmanRankCorrelationForTest(xs: number[], ys: number[]) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = average(rx)!;
  const my = average(ry)!;
  let covariance = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < rx.length; i++) {
    const dx = rx[i]! - mx;
    const dy = ry[i]! - my;
    covariance += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  const denom = Math.sqrt(vx * vy);
  return denom > 0 ? covariance / denom : null;
}

export function neweyWestMeanForTest(values: number[], lag: number) {
  const xs = values.filter(Number.isFinite);
  const n = xs.length;
  if (!n) return { mean: null, t: null, ciLow: null, ciHigh: null, n: 0 };
  const meanValue = average(xs)!;
  if (n < 2) return { mean: meanValue, t: null, ciLow: null, ciHigh: null, n };
  const centered = xs.map((value) => value - meanValue);
  let longRunVariance = centered.reduce((sum, value) => sum + value * value, 0) / n;
  const maxLag = Math.min(Math.max(0, Math.floor(lag)), n - 1);
  for (let l = 1; l <= maxLag; l++) {
    let gamma = 0;
    for (let t = l; t < n; t++) gamma += centered[t]! * centered[t - l]!;
    gamma /= n;
    const weight = 1 - l / (maxLag + 1);
    longRunVariance += 2 * weight * gamma;
  }
  const varianceOfMean = Math.max(0, longRunVariance) / n;
  const se = Math.sqrt(varianceOfMean);
  if (!(se > 0)) return { mean: meanValue, t: null, ciLow: meanValue, ciHigh: meanValue, n };
  const t = meanValue / se;
  return {
    mean: meanValue,
    t,
    ciLow: meanValue - 1.96 * se,
    ciHigh: meanValue + 1.96 * se,
    n,
  };
}

function adjacentUpRate(values: Array<number | null>) {
  let validPairs = 0;
  let upPairs = 0;
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const cur = values[i];
    if (!finite(prev) || !finite(cur)) continue;
    validPairs++;
    if (cur >= prev) upPairs++;
  }
  return validPairs ? (upPairs / validPairs) * 100 : null;
}

function metricKey(
  scope: "SPLIT" | "YEAR",
  split: V8ScoreSplit | null,
  year: number | null,
  market: V8ScoreMarket,
  score: number,
) {
  return `${scope}|${split ?? ""}|${year ?? ""}|${market}|${score.toFixed(2)}`;
}

function slopeKey(date: string, market: V8ScoreMarket) {
  return `${date}|${market}`;
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
  if (!entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exit.close) || exit.close <= 0)
    return null;
  return (exit.close / entry.open - 1) * 100;
}

function buildSplitPolicy(allDates: string[]) {
  const dates = [...new Set(allDates)].sort();
  if (!dates.length)
    return { developmentFrom: null, validationFrom: null, oosFrom: null };
  const validationIndex = Math.min(dates.length - 1, Math.floor(dates.length * 0.6));
  const oosIndex = Math.min(dates.length - 1, Math.floor(dates.length * 0.8));
  return {
    developmentFrom: dates[0] ?? null,
    validationFrom: dates[validationIndex] ?? null,
    oosFrom: dates[oosIndex] ?? null,
  };
}

function splitForDate(
  date: string,
  policy: { validationFrom: string | null; oosFrom: string | null },
): Exclude<V8ScoreSplit, "ALL"> {
  if (policy.oosFrom && date >= policy.oosFrom) return "OOS";
  if (policy.validationFrom && date >= policy.validationFrom) return "VALIDATION";
  return "DEVELOPMENT";
}

function scopeMatchesDate(
  date: string,
  scope: "SPLIT" | "YEAR",
  split: V8ScoreSplit | null,
  year: number | null,
  policy: { validationFrom: string | null; oosFrom: string | null },
) {
  if (scope === "YEAR") return Number(date.slice(0, 4)) === year;
  if (split === "ALL") return true;
  return splitForDate(date, policy) === split;
}

function finalizeMetricRow(
  key: { scope: "SPLIT" | "YEAR"; split: V8ScoreSplit | null; year: number | null; market: V8ScoreMarket; horizon: number; score10: number },
  acc: MetricAcc,
): V8ScoreBucketMetricRow {
  return {
    ...key,
    count: acc.count,
    signalDates: acc.dates.size,
    avgSignalsPerDate: acc.dates.size ? round(acc.count / acc.dates.size) : null,
    avgReturn: acc.count ? round(acc.sumReturn / acc.count) : null,
    medianReturn: round(median(acc.returns)),
    winRate: acc.count ? round((acc.positiveReturn / acc.count) * 100) : null,
    profitFactor: acc.lossAbsSum > 0 ? round(acc.profitSum / acc.lossAbsSum) : acc.profitSum > 0 ? null : 0,
    avgExcessReturn: acc.excessCount ? round(acc.sumExcess / acc.excessCount) : null,
    medianExcessReturn: round(median(acc.excessReturns)),
    excessWinRate: acc.excessCount ? round((acc.positiveExcess / acc.excessCount) * 100) : null,
    sectorPriceLeadershipAvailableRate: acc.count ? round((acc.sectorAvailable / acc.count) * 100) : null,
    sectorOverheatRate: acc.count ? round((acc.sectorOverheated / acc.count) * 100) : null,
  };
}

function bestScore(rows: V8ScoreBucketMetricRow[], pick: (row: V8ScoreBucketMetricRow) => number | null) {
  let best: V8ScoreBucketMetricRow | null = null;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const value = pick(row);
    if (finite(value) && value > bestValue) {
      best = row;
      bestValue = value;
    }
  }
  return best?.score10 ?? null;
}

function endpointSpread(rows: V8ScoreBucketMetricRow[], pick: (row: V8ScoreBucketMetricRow) => number | null) {
  if (rows.length < 2) return null;
  const low = pick(rows[0]!);
  const high = pick(rows[rows.length - 1]!);
  return finite(low) && finite(high) ? high - low : null;
}

function summaryFromRows(
  rows: V8ScoreBucketMetricRow[],
  slopes: DailySlopeRow[],
  scope: "SPLIT" | "YEAR",
  split: V8ScoreSplit | null,
  year: number | null,
  market: V8ScoreMarket,
  horizon: number,
  minBucketN: number,
  minBucketDates: number,
  policy: { validationFrom: string | null; oosFrom: string | null },
): V8ScoreMonotonicitySummaryRow {
  const eligible = rows
    .filter((row) => row.count >= minBucketN && row.signalDates >= minBucketDates)
    .sort((a, b) => a.score10 - b.score10);
  const scores = eligible.map((row) => row.score10);
  const rawAvg = eligible.map((row) => row.avgReturn);
  const rawMedian = eligible.map((row) => row.medianReturn);
  const excessAvg = eligible.map((row) => row.avgExcessReturn);
  const excessMedian = eligible.map((row) => row.medianExcessReturn);
  const corr = (values: Array<number | null>) => {
    const pairs = scores.map((score, i) => ({ score, value: values[i] })).filter((item): item is { score: number; value: number } => finite(item.value));
    return pairs.length >= 2 ? spearmanRankCorrelationForTest(pairs.map((item) => item.score), pairs.map((item) => item.value)) : null;
  };
  const matchingSlopes = slopes.filter(
    (row) => row.market === market && scopeMatchesDate(row.date, scope, split, year, policy),
  );
  const rawHac = neweyWestMeanForTest(matchingSlopes.map((row) => row.rawSlope).filter(finite), horizon - 1);
  const excessHac = neweyWestMeanForTest(matchingSlopes.map((row) => row.excessSlope).filter(finite), horizon - 1);
  return {
    scope,
    split,
    year,
    market,
    horizon,
    eligibleBuckets: eligible.length,
    lowestEligibleScore: eligible[0]?.score10 ?? null,
    highestEligibleScore: eligible.at(-1)?.score10 ?? null,
    spearmanAvgReturn: round(corr(rawAvg)),
    spearmanMedianReturn: round(corr(rawMedian)),
    spearmanAvgExcess: round(corr(excessAvg)),
    spearmanMedianExcess: round(corr(excessMedian)),
    adjacentAvgReturnUpRate: round(adjacentUpRate(rawAvg)),
    adjacentMedianReturnUpRate: round(adjacentUpRate(rawMedian)),
    adjacentAvgExcessUpRate: round(adjacentUpRate(excessAvg)),
    adjacentMedianExcessUpRate: round(adjacentUpRate(excessMedian)),
    endpointAvgReturnSpread: round(endpointSpread(eligible, (row) => row.avgReturn)),
    endpointMedianReturnSpread: round(endpointSpread(eligible, (row) => row.medianReturn)),
    endpointAvgExcessSpread: round(endpointSpread(eligible, (row) => row.avgExcessReturn)),
    endpointMedianExcessSpread: round(endpointSpread(eligible, (row) => row.medianExcessReturn)),
    bestAvgExcessScore: bestScore(eligible, (row) => row.avgExcessReturn),
    bestMedianExcessScore: bestScore(eligible, (row) => row.medianExcessReturn),
    dailyRawSlopeMean: round(rawHac.mean),
    dailyRawSlopeHacT: round(rawHac.t),
    dailyRawSlopeCiLow: round(rawHac.ciLow),
    dailyRawSlopeCiHigh: round(rawHac.ciHigh),
    dailyRawSlopeDates: rawHac.n,
    dailyExcessSlopeMean: round(excessHac.mean),
    dailyExcessSlopeHacT: round(excessHac.t),
    dailyExcessSlopeCiLow: round(excessHac.ciLow),
    dailyExcessSlopeCiHigh: round(excessHac.ciHigh),
    dailyExcessSlopeDates: excessHac.n,
  };
}

export function buildV8ScoreMonotonicity(
  dataset: MarketDataset,
  options: V8ScoreMonotonicityOptions = {},
): V8ScoreMonotonicityResult | null {
  const limit = Math.max(1, Math.round(options.limit ?? 613));
  const horizons = [...new Set((options.horizons ?? [...V8_SCORE_MONOTONICITY_HORIZONS]).map((value) => Math.round(value)).filter((value) => value >= 1 && value <= 252))].sort((a, b) => a - b);
  const warmupDays = Math.max(120, Math.round(options.warmupDays ?? 120));
  const roundTripCostBps = Math.max(0, options.roundTripCostBps ?? 0);
  const priceLeadershipOverheatThreshold = Math.max(0, Math.min(100, options.priceLeadershipOverheatThreshold ?? V8_SCORE_PL_OVERHEAT_THRESHOLD));
  const minBucketN = Math.max(1, Math.round(options.minBucketN ?? 100));
  const minBucketDates = Math.max(1, Math.round(options.minBucketDates ?? 20));
  const minDailyCrossSectionN = Math.max(5, Math.round(options.minDailyCrossSectionN ?? 30));
  if (!horizons.length) return null;

  const context = buildPortfolioSignalContext(dataset, limit);
  if (!context.series.length || !context.allDates.length) return null;
  const policy = buildSplitPolicy(context.allDates);
  const benchmarks = benchmarkMaps(dataset);
  const rows: V8ScoreBucketMetricRow[] = [];
  const monotonicity: V8ScoreMonotonicitySummaryRow[] = [];
  const years = [...new Set(context.allDates.map((date) => Number(date.slice(0, 4))).filter(Number.isFinite))].sort((a, b) => a - b);

  for (const horizon of horizons) {
    const metrics = new Map<string, { meta: { scope: "SPLIT" | "YEAR"; split: V8ScoreSplit | null; year: number | null; market: V8ScoreMarket; horizon: number; score10: number }; acc: MetricAcc }>();
    const daily = new Map<string, DailySlopeAcc>();

    for (const series of context.series) {
      const market: StockMarket = series.market;
      for (let i = warmupDays; i + horizon < series.bars.length; i++) {
        const baseScore = series.baseScores[i];
        if (!finite(baseScore)) continue;
        const sectorPl = series.sectorPriceLeadership[i] ?? null;
        const adjustment = adjustSectorPenaltyScore(baseScore, sectorPl, priceLeadershipOverheatThreshold);
        const score10 = adjustment.score;
        const entry = series.bars[i + 1];
        const exit = series.bars[i + horizon];
        const signal = series.bars[i];
        if (!signal || !entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exit.close) || exit.close <= 0) continue;
        const ret = (exit.close / entry.open - 1) * 100 - roundTripCostBps / 100;
        const benchmark = benchmarkReturn(benchmarks, market, entry.tradeDate, exit.tradeDate);
        const excess = finite(benchmark) ? ret - benchmark : null;
        const date = signal.tradeDate;
        const split = splitForDate(date, policy);
        const year = Number(date.slice(0, 4));
        const scopes: Array<{ scope: "SPLIT" | "YEAR"; split: V8ScoreSplit | null; year: number | null }> = [
          { scope: "SPLIT", split: "ALL", year: null },
          { scope: "SPLIT", split, year: null },
          { scope: "YEAR", split: null, year },
        ];
        for (const marketGroup of ["ALL", market] as const) {
          for (const scope of scopes) {
            const key = metricKey(scope.scope, scope.split, scope.year, marketGroup, score10);
            let group = metrics.get(key);
            if (!group) {
              group = { meta: { ...scope, market: marketGroup, horizon, score10 }, acc: makeMetricAcc() };
              metrics.set(key, group);
            }
            addMetric(group.acc, date, ret, excess, adjustment.sectorScoreAvailable, adjustment.overheated === true);
          }
          const dk = slopeKey(date, marketGroup);
          let slope = daily.get(dk);
          if (!slope) {
            slope = { raw: makeRegressionAcc(), excess: makeRegressionAcc() };
            daily.set(dk, slope);
          }
          addRegression(slope.raw, score10, ret);
          if (finite(excess)) addRegression(slope.excess, score10, excess);
        }
      }
    }

    const horizonRows = [...metrics.values()].map(({ meta, acc }) => finalizeMetricRow(meta, acc));
    horizonRows.sort((a, b) => a.scope.localeCompare(b.scope) || String(a.split ?? a.year ?? "").localeCompare(String(b.split ?? b.year ?? "")) || a.market.localeCompare(b.market) || a.score10 - b.score10);
    rows.push(...horizonRows);

    const dailySlopes: DailySlopeRow[] = [...daily.entries()].map(([key, value]) => {
      const splitAt = key.lastIndexOf("|");
      return {
        date: key.slice(0, splitAt),
        market: key.slice(splitAt + 1) as V8ScoreMarket,
        rawSlope: regressionSlope(value.raw, minDailyCrossSectionN),
        excessSlope: regressionSlope(value.excess, minDailyCrossSectionN),
      };
    });

    for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
      for (const split of ["ALL", "DEVELOPMENT", "VALIDATION", "OOS"] as const) {
        const bucketRows = horizonRows.filter((row) => row.scope === "SPLIT" && row.split === split && row.market === market);
        monotonicity.push(summaryFromRows(bucketRows, dailySlopes, "SPLIT", split, null, market, horizon, minBucketN, minBucketDates, policy));
      }
      for (const year of years) {
        const bucketRows = horizonRows.filter((row) => row.scope === "YEAR" && row.year === year && row.market === market);
        monotonicity.push(summaryFromRows(bucketRows, dailySlopes, "YEAR", null, year, market, horizon, minBucketN, minBucketDates, policy));
      }
    }
  }

  const scoredDates = context.allDates.filter((date) => date >= (policy.developmentFrom ?? date));
  return {
    version: V8_SCORE_MONOTONICITY_VERSION,
    from: scoredDates[0] ?? context.allDates[0] ?? dataset.asOfDate,
    to: scoredDates.at(-1) ?? context.allDates.at(-1) ?? dataset.asOfDate,
    symbolCount: context.series.length,
    scoreMax: 10,
    horizons,
    warmupDays,
    roundTripCostBps,
    priceLeadershipOverheatThreshold,
    bucketRule: "exact-observed-score",
    splitPolicy: { method: "chronological-60-20-20", ...policy },
    eligibility: { minBucketN, minBucketDates, minDailyCrossSectionN },
    scorePolicy: {
      baseScoreMax: 9.5,
      sectorSlotPoints: 0.5,
      missingSectorPriceLeadership: "no-sector-slot",
      normalSectorPriceLeadership: "+0.5",
      overheatedSectorPriceLeadership: "no-net-sector-slot",
    },
    rows,
    monotonicity,
    notes: [
      "점수는 각 신호일 종가까지의 정보로 계산하고, 다음 거래일 시가에 진입하여 t+h 종가에 청산한다.",
      "10점 점수는 9.5점 Vf 원점수와 섹터 Price Leadership 0.5점 슬롯을 결합한다. PL 미관측 또는 PL>=과열 기준이면 순가점이 없고, 정상 PL 관측 시 +0.5점이다.",
      "시장초과수익은 종목 시장(KOSPI/KOSDAQ)의 같은 진입일 시가~청산일 종가 지수수익률을 차감하며 benchmark fallback은 사용하지 않는다.",
      "단조성 표의 Spearman은 최소 표본/날짜 기준을 충족한 실제 관측 점수 버킷의 성과와 점수 간 순위상관이다.",
      "통계 추론은 매 거래일 횡단면에서 미래수익률~10점 점수의 단순 OLS slope를 구한 뒤 horizon-1 lag Newey-West HAC로 평균 slope의 95% 신뢰구간을 계산한다.",
      "YEAR 표는 국면 안정성 진단용이며 최종 가중치/진입 임계치 선정은 후속 V8 단계에서 별도로 수행한다.",
    ],
  };
}
