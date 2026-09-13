import { computeIndicators } from "./indicators";
import { DEFAULT_SCORING_CONFIG, technicalFlagsV3 } from "./scoring";
import { VF_FEATURE_WEIGHTS } from "./vfConfig";
import type { MarketDataset } from "./dataset";
import type { DailyPrice, IndexSeries, Instrument } from "./types";

export const V8_VF_FEATURE_VALIDATION_VERSION = "CloudTrend V8 Vf Feature Validation" as const;
export const V8_VF_FEATURE_HORIZONS = [5, 10, 20, 30, 40, 60] as const;
export const V8_VF_FEATURE_IDS = [
  "ICH_ABOVE_CLOUD",
  "ICH_TENKAN_KIJUN",
  "BB_BREAKOUT",
  "MA_ALIGNED",
  "VOLUME_SURGE",
  "NEAR_52W_HIGH",
  "FOREIGN_NET_POSITIVE",
] as const;

export type VfFeatureId = (typeof V8_VF_FEATURE_IDS)[number];
export type VfFeatureSignalKind = "STATE" | "ONSET";
export type VfFeatureSplit = "ALL" | "DEVELOPMENT" | "VALIDATION" | "OOS";
export type VfFeatureMarket = "ALL" | "KOSPI" | "KOSDAQ";

type StockMarket = Exclude<VfFeatureMarket, "ALL">;
type EncodedState = -1 | 0 | 1;

const FEATURE_LABELS: Record<VfFeatureId, string> = {
  ICH_ABOVE_CLOUD: "일목 구름 상단 위",
  ICH_TENKAN_KIJUN: "전환선 > 기준선",
  BB_BREAKOUT: "볼린저 상단 돌파",
  MA_ALIGNED: "MA20 > MA60 > MA120 정배열",
  VOLUME_SURGE: "고가 마감 거래량",
  NEAR_52W_HIGH: "52주 신고가 대비 10% 이내",
  FOREIGN_NET_POSITIVE: "20D 외국인 누적 순매수 > 0",
};

const FEATURE_WEIGHTS: Record<VfFeatureId, number> = {
  ICH_ABOVE_CLOUD: VF_FEATURE_WEIGHTS.ICH_ABOVE_CLOUD,
  ICH_TENKAN_KIJUN: VF_FEATURE_WEIGHTS.ICH_TENKAN_KIJUN,
  BB_BREAKOUT: VF_FEATURE_WEIGHTS.BB_BREAKOUT,
  MA_ALIGNED: VF_FEATURE_WEIGHTS.MA_ALIGNED,
  VOLUME_SURGE: VF_FEATURE_WEIGHTS.VOLUME_SURGE,
  NEAR_52W_HIGH: VF_FEATURE_WEIGHTS.NEAR_52W_HIGH,
  FOREIGN_NET_POSITIVE: VF_FEATURE_WEIGHTS.FOREIGN_NET_POSITIVE,
};

export interface V8VfFeatureValidationOptions {
  limit?: number;
  horizons?: number[];
  warmupDays?: number;
  roundTripCostBps?: number;
}

export interface V8VfFeatureAvailabilityRow {
  feature: VfFeatureId;
  label: string;
  weight: number;
  availableDays: number;
  trueDays: number;
  falseDays: number;
  onsetDays: number;
  missingDays: number;
  trueRate: number | null;
  firstAvailableDate: string | null;
  lastAvailableDate: string | null;
}

export interface V8VfFeatureMetricRow {
  scope: "SPLIT" | "YEAR";
  split: VfFeatureSplit | null;
  year: number | null;
  market: VfFeatureMarket;
  feature: VfFeatureId;
  label: string;
  weight: number;
  signalKind: VfFeatureSignalKind;
  horizon: number;
  hacLag: number;
  signalCount: number;
  signalDates: number;
  avgSignalsPerDate: number | null;
  controlCount: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoff: number | null;
  profitFactor: number | null;
  avgExcessReturn: number | null;
  medianExcessReturn: number | null;
  excessWinRate: number | null;
  avgMae: number | null;
  avgMfe: number | null;
  controlAvgReturn: number | null;
  controlWinRate: number | null;
  controlAvgExcessReturn: number | null;
  controlExcessWinRate: number | null;
  rawReturnEdge: number | null;
  rawExcessEdge: number | null;
  dailyReturnEdgeMean: number | null;
  dailyReturnEdgeHacT: number | null;
  dailyReturnEdgeCiLow: number | null;
  dailyReturnEdgeCiHigh: number | null;
  dailyReturnEdgeDates: number;
  dailyExcessEdgeMean: number | null;
  dailyExcessEdgeHacT: number | null;
  dailyExcessEdgeCiLow: number | null;
  dailyExcessEdgeCiHigh: number | null;
  dailyExcessEdgeDates: number;
}

export interface V8VfFeatureRobustnessRow {
  feature: VfFeatureId;
  label: string;
  signalKind: VfFeatureSignalKind;
  allPositiveExcessHorizons: number;
  allSignificantPositiveExcessHorizons: number;
  oosPositiveExcessHorizons: number;
  oosSignificantPositiveExcessHorizons: number;
  allMedianDailyExcessEdge: number | null;
  oosMedianDailyExcessEdge: number | null;
  horizonsTested: number;
}

export interface V8VfFeatureValidationResult {
  version: typeof V8_VF_FEATURE_VALIDATION_VERSION;
  from: string;
  to: string;
  symbolCount: number;
  horizons: number[];
  warmupDays: number;
  roundTripCostBps: number;
  splitPolicy: {
    method: "chronological-60-20-20";
    developmentFrom: string | null;
    validationFrom: string | null;
    oosFrom: string | null;
  };
  featureDefinitions: Array<{ feature: VfFeatureId; label: string; weight: number }>;
  availability: V8VfFeatureAvailabilityRow[];
  rows: V8VfFeatureMetricRow[];
  robustness: V8VfFeatureRobustnessRow[];
  inference: {
    unit: "daily-cross-sectional-signal-minus-control";
    estimator: "Newey-West-HAC";
    lagRule: "horizon-1";
    confidenceLevel: 0.95;
    controlDefinition: "same-feature available and false";
  };
  notes: string[];
}

export interface PreparedVfFeatureSeries {
  symbol: string;
  name: string;
  market: StockMarket;
  bars: DailyPrice[];
  states: Record<VfFeatureId, Int8Array>;
}

interface OutcomeSeries {
  ret: Float64Array;
  excess: Float64Array;
  mae: Float64Array;
  mfe: Float64Array;
}

interface RunningMetric {
  count: number;
  sum: number;
  positive: number;
  winSum: number;
  winCount: number;
  lossSum: number;
  lossCount: number;
  excessCount: number;
  excessSum: number;
  excessPositive: number;
  maeCount: number;
  maeSum: number;
  mfeCount: number;
  mfeSum: number;
  returns: number[];
  excessReturns: number[];
}

interface DailyBucket {
  signalRetSum: number;
  signalRetCount: number;
  controlRetSum: number;
  controlRetCount: number;
  signalExcessSum: number;
  signalExcessCount: number;
  controlExcessSum: number;
  controlExcessCount: number;
}

interface MetricGroup {
  scope: "SPLIT" | "YEAR";
  split: VfFeatureSplit | null;
  year: number | null;
  market: VfFeatureMarket;
  signal: RunningMetric;
  control: RunningMetric;
  daily: Map<string, DailyBucket>;
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  const lo = Math.floor(mid);
  const hi = Math.ceil(mid);
  return (sorted[lo]! + sorted[hi]!) / 2;
}

function emptyRunning(): RunningMetric {
  return {
    count: 0,
    sum: 0,
    positive: 0,
    winSum: 0,
    winCount: 0,
    lossSum: 0,
    lossCount: 0,
    excessCount: 0,
    excessSum: 0,
    excessPositive: 0,
    maeCount: 0,
    maeSum: 0,
    mfeCount: 0,
    mfeSum: 0,
    returns: [],
    excessReturns: [],
  };
}

function emptyDaily(): DailyBucket {
  return {
    signalRetSum: 0,
    signalRetCount: 0,
    controlRetSum: 0,
    controlRetCount: 0,
    signalExcessSum: 0,
    signalExcessCount: 0,
    controlExcessSum: 0,
    controlExcessCount: 0,
  };
}

function addRunning(
  metric: RunningMetric,
  ret: number,
  excess: number | null,
  mae: number | null,
  mfe: number | null,
  keepDistribution: boolean,
) {
  metric.count++;
  metric.sum += ret;
  if (ret > 0) {
    metric.positive++;
    metric.winCount++;
    metric.winSum += ret;
  } else if (ret < 0) {
    metric.lossCount++;
    metric.lossSum += ret;
  }
  if (keepDistribution) metric.returns.push(ret);
  if (excess !== null) {
    metric.excessCount++;
    metric.excessSum += excess;
    if (excess > 0) metric.excessPositive++;
    if (keepDistribution) metric.excessReturns.push(excess);
  }
  if (mae !== null) {
    metric.maeCount++;
    metric.maeSum += mae;
  }
  if (mfe !== null) {
    metric.mfeCount++;
    metric.mfeSum += mfe;
  }
}

function pct(numerator: number, denominator: number) {
  return denominator ? (numerator / denominator) * 100 : null;
}

function mean(metric: RunningMetric) {
  return metric.count ? metric.sum / metric.count : null;
}

function excessMean(metric: RunningMetric) {
  return metric.excessCount ? metric.excessSum / metric.excessCount : null;
}

function subtract(a: number | null, b: number | null) {
  return a !== null && b !== null ? a - b : null;
}

export function neweyWestMean(values: number[], lag: number) {
  if (!values.length) {
    return { count: 0, mean: null, standardError: null, t: null, ciLow: null, ciHigh: null };
  }
  const n = values.length;
  const meanValue = values.reduce((sum, value) => sum + value, 0) / n;
  const centered = values.map((value) => value - meanValue);
  let longRunVariance = centered.reduce((sum, value) => sum + value * value, 0) / n;
  const maxLag = Math.min(Math.max(0, Math.floor(lag)), n - 1);
  for (let k = 1; k <= maxLag; k++) {
    let covariance = 0;
    for (let t = k; t < n; t++) covariance += centered[t]! * centered[t - k]!;
    covariance /= n;
    const bartlett = 1 - k / (maxLag + 1);
    longRunVariance += 2 * bartlett * covariance;
  }
  const varianceOfMean = Math.max(0, longRunVariance / n);
  const standardError = Math.sqrt(varianceOfMean);
  const t = standardError > 1e-12 ? meanValue / standardError : null;
  const margin = 1.96 * standardError;
  return {
    count: n,
    mean: meanValue,
    standardError,
    t,
    ciLow: meanValue - margin,
    ciHigh: meanValue + margin,
  };
}

function featureStates(snapshot: ReturnType<typeof computeIndicators>): Record<VfFeatureId, EncodedState> {
  const flags = technicalFlagsV3(snapshot, DEFAULT_SCORING_CONFIG);
  const nearHigh =
    snapshot.distanceFrom52wHigh === null
      ? null
      : snapshot.distanceFrom52wHigh >= DEFAULT_SCORING_CONFIG.priority.nearHighThresholdPercent;
  const foreign = snapshot.foreignNet20d === null ? null : snapshot.foreignNet20d > 0;
  const encode = (value: boolean | null): EncodedState => (value === null ? -1 : value ? 1 : 0);
  return {
    ICH_ABOVE_CLOUD: encode(flags.cloudAbove),
    ICH_TENKAN_KIJUN: encode(flags.tenkanAboveKijun),
    BB_BREAKOUT: encode(flags.bbBreakout),
    MA_ALIGNED: encode(flags.maAligned),
    VOLUME_SURGE: encode(flags.highCloseVolume),
    NEAR_52W_HIGH: encode(nearHigh),
    FOREIGN_NET_POSITIVE: encode(foreign),
  };
}

function makeStateArrays(length: number): Record<VfFeatureId, Int8Array> {
  return Object.fromEntries(
    V8_VF_FEATURE_IDS.map((feature) => {
      const values = new Int8Array(length);
      values.fill(-1);
      return [feature, values];
    }),
  ) as Record<VfFeatureId, Int8Array>;
}

export function prepareV8VfFeatureSeries(
  dataset: MarketDataset,
  limit = 613,
  warmupDays = 120,
): PreparedVfFeatureSeries[] {
  const stocks = dataset.instruments
    .filter((instrument) => instrument.instrumentType === "STOCK")
    .sort(
      (a, b) =>
        (dataset.bars[b.symbol]?.at(-1)?.tradingValue ?? 0) -
        (dataset.bars[a.symbol]?.at(-1)?.tradingValue ?? 0),
    )
    .slice(0, Math.max(1, Math.round(limit)));

  return stocks
    .map((instrument: Instrument): PreparedVfFeatureSeries | null => {
      if (instrument.market !== "KOSPI" && instrument.market !== "KOSDAQ") {
        throw new Error(`V8 stock market 누락/오류: ${instrument.symbol} market=${instrument.market}`);
      }
      const bars = dataset.bars[instrument.symbol] ?? [];
      if (bars.length <= warmupDays) return null;
      const states = makeStateArrays(bars.length);
      for (let i = warmupDays; i < bars.length; i++) {
        const decoded = featureStates(computeIndicators(bars, i));
        for (const feature of V8_VF_FEATURE_IDS) states[feature][i] = decoded[feature];
      }
      return {
        symbol: instrument.symbol,
        name: instrument.name,
        market: instrument.market,
        bars,
        states,
      };
    })
    .filter((series): series is PreparedVfFeatureSeries => series !== null);
}

function indexMaps(indexSeries: IndexSeries[]) {
  return {
    KOSPI: new Map(
      (indexSeries.find((series) => series.indexCode.toUpperCase() === "KOSPI")?.bars ?? []).map(
        (bar) => [bar.tradeDate, bar],
      ),
    ),
    KOSDAQ: new Map(
      (indexSeries.find((series) => series.indexCode.toUpperCase() === "KOSDAQ")?.bars ?? []).map(
        (bar) => [bar.tradeDate, bar],
      ),
    ),
  } satisfies Record<StockMarket, Map<string, DailyPrice>>;
}

function buildOutcomes(
  series: PreparedVfFeatureSeries[],
  indexSeries: IndexSeries[],
  horizon: number,
  costBps: number,
): OutcomeSeries[] {
  const indexes = indexMaps(indexSeries);
  return series.map((item) => {
    const n = item.bars.length;
    const ret = new Float64Array(n);
    const excess = new Float64Array(n);
    const mae = new Float64Array(n);
    const mfe = new Float64Array(n);
    ret.fill(Number.NaN);
    excess.fill(Number.NaN);
    mae.fill(Number.NaN);
    mfe.fill(Number.NaN);
    const benchmark = indexes[item.market];
    for (let i = 0; i + horizon < n; i++) {
      const entry = item.bars[i + 1];
      const exit = item.bars[i + horizon];
      if (!entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exit.close) || exit.close <= 0)
        continue;
      let minimum = entry.open;
      let maximum = entry.open;
      let completePath = true;
      for (let j = i + 1; j <= i + horizon; j++) {
        const bar = item.bars[j];
        if (!bar || !finite(bar.low) || bar.low <= 0 || !finite(bar.high) || bar.high <= 0) {
          completePath = false;
          break;
        }
        minimum = Math.min(minimum, bar.low);
        maximum = Math.max(maximum, bar.high);
      }
      const stockReturn = (exit.close / entry.open - 1) * 100 - costBps / 100;
      ret[i] = stockReturn;
      if (completePath) {
        mae[i] = (minimum / entry.open - 1) * 100;
        mfe[i] = (maximum / entry.open - 1) * 100;
      }
      const entryBenchmark = benchmark.get(entry.tradeDate);
      const exitBenchmark = benchmark.get(exit.tradeDate);
      if (
        entryBenchmark &&
        exitBenchmark &&
        finite(entryBenchmark.open) &&
        entryBenchmark.open > 0 &&
        finite(exitBenchmark.close) &&
        exitBenchmark.close > 0
      ) {
        excess[i] = stockReturn - (exitBenchmark.close / entryBenchmark.open - 1) * 100;
      }
    }
    return { ret, excess, mae, mfe };
  });
}

function uniqueDates(series: PreparedVfFeatureSeries[]) {
  return [...new Set(series.flatMap((item) => item.bars.map((bar) => bar.tradeDate)))].sort();
}

function splitPolicy(dates: string[]) {
  if (!dates.length)
    return {
      method: "chronological-60-20-20" as const,
      developmentFrom: null,
      validationFrom: null,
      oosFrom: null,
    };
  const validationIndex = Math.min(dates.length - 1, Math.floor(dates.length * 0.6));
  const oosIndex = Math.min(dates.length - 1, Math.floor(dates.length * 0.8));
  return {
    method: "chronological-60-20-20" as const,
    developmentFrom: dates[0] ?? null,
    validationFrom: dates[validationIndex] ?? null,
    oosFrom: dates[oosIndex] ?? null,
  };
}

function splitForDate(
  date: string,
  policy: ReturnType<typeof splitPolicy>,
): Exclude<VfFeatureSplit, "ALL"> {
  if (policy.oosFrom && date >= policy.oosFrom) return "OOS";
  if (policy.validationFrom && date >= policy.validationFrom) return "VALIDATION";
  return "DEVELOPMENT";
}

function groupKey(group: Pick<MetricGroup, "scope" | "split" | "year" | "market">) {
  return `${group.scope}|${group.split ?? ""}|${group.year ?? ""}|${group.market}`;
}

function getGroup(
  groups: Map<string, MetricGroup>,
  scope: "SPLIT" | "YEAR",
  market: VfFeatureMarket,
  split: VfFeatureSplit | null,
  year: number | null,
) {
  const shell = { scope, split, year, market };
  const key = groupKey(shell);
  let group = groups.get(key);
  if (!group) {
    group = { ...shell, signal: emptyRunning(), control: emptyRunning(), daily: new Map() };
    groups.set(key, group);
  }
  return group;
}

function targets(
  groups: Map<string, MetricGroup>,
  date: string,
  market: StockMarket,
  policy: ReturnType<typeof splitPolicy>,
) {
  const split = splitForDate(date, policy);
  const year = Number(date.slice(0, 4));
  return [
    getGroup(groups, "SPLIT", "ALL", "ALL", null),
    getGroup(groups, "SPLIT", market, "ALL", null),
    getGroup(groups, "SPLIT", "ALL", split, null),
    getGroup(groups, "SPLIT", market, split, null),
    getGroup(groups, "YEAR", "ALL", null, year),
    getGroup(groups, "YEAR", market, null, year),
  ];
}

function updateGroup(
  group: MetricGroup,
  date: string,
  side: "signal" | "control",
  ret: number,
  excess: number | null,
  mae: number | null,
  mfe: number | null,
) {
  addRunning(group[side], ret, excess, mae, mfe, side === "signal");
  const bucket = group.daily.get(date) ?? emptyDaily();
  if (side === "signal") {
    bucket.signalRetSum += ret;
    bucket.signalRetCount++;
    if (excess !== null) {
      bucket.signalExcessSum += excess;
      bucket.signalExcessCount++;
    }
  } else {
    bucket.controlRetSum += ret;
    bucket.controlRetCount++;
    if (excess !== null) {
      bucket.controlExcessSum += excess;
      bucket.controlExcessCount++;
    }
  }
  group.daily.set(date, bucket);
}

function dailyEdges(group: MetricGroup, field: "return" | "excess") {
  const values: number[] = [];
  for (const date of [...group.daily.keys()].sort()) {
    const bucket = group.daily.get(date)!;
    if (field === "return") {
      if (bucket.signalRetCount && bucket.controlRetCount) {
        values.push(
          bucket.signalRetSum / bucket.signalRetCount -
            bucket.controlRetSum / bucket.controlRetCount,
        );
      }
    } else if (bucket.signalExcessCount && bucket.controlExcessCount) {
      values.push(
        bucket.signalExcessSum / bucket.signalExcessCount -
          bucket.controlExcessSum / bucket.controlExcessCount,
      );
    }
  }
  return values;
}

function finalizeGroup(
  group: MetricGroup,
  feature: VfFeatureId,
  signalKind: VfFeatureSignalKind,
  horizon: number,
): V8VfFeatureMetricRow {
  const signal = group.signal;
  const control = group.control;
  const returnHac = neweyWestMean(dailyEdges(group, "return"), horizon - 1);
  const excessHac = neweyWestMean(dailyEdges(group, "excess"), horizon - 1);
  const avgWin = signal.winCount ? signal.winSum / signal.winCount : null;
  const avgLoss = signal.lossCount ? signal.lossSum / signal.lossCount : null;
  const signalDateCount = new Set(
    [...group.daily.entries()]
      .filter(([, bucket]) => bucket.signalRetCount > 0)
      .map(([date]) => date),
  ).size;
  return {
    scope: group.scope,
    split: group.split,
    year: group.year,
    market: group.market,
    feature,
    label: FEATURE_LABELS[feature],
    weight: FEATURE_WEIGHTS[feature],
    signalKind,
    horizon,
    hacLag: Math.max(0, horizon - 1),
    signalCount: signal.count,
    signalDates: signalDateCount,
    avgSignalsPerDate: signalDateCount ? signal.count / signalDateCount : null,
    controlCount: control.count,
    avgReturn: mean(signal),
    medianReturn: median(signal.returns),
    winRate: pct(signal.positive, signal.count),
    avgWin,
    avgLoss,
    payoff: avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null,
    profitFactor: signal.lossSum < 0 ? signal.winSum / -signal.lossSum : null,
    avgExcessReturn: excessMean(signal),
    medianExcessReturn: median(signal.excessReturns),
    excessWinRate: pct(signal.excessPositive, signal.excessCount),
    avgMae: signal.maeCount ? signal.maeSum / signal.maeCount : null,
    avgMfe: signal.mfeCount ? signal.mfeSum / signal.mfeCount : null,
    controlAvgReturn: mean(control),
    controlWinRate: pct(control.positive, control.count),
    controlAvgExcessReturn: excessMean(control),
    controlExcessWinRate: pct(control.excessPositive, control.excessCount),
    rawReturnEdge: subtract(mean(signal), mean(control)),
    rawExcessEdge: subtract(excessMean(signal), excessMean(control)),
    dailyReturnEdgeMean: returnHac.mean,
    dailyReturnEdgeHacT: returnHac.t,
    dailyReturnEdgeCiLow: returnHac.ciLow,
    dailyReturnEdgeCiHigh: returnHac.ciHigh,
    dailyReturnEdgeDates: returnHac.count,
    dailyExcessEdgeMean: excessHac.mean,
    dailyExcessEdgeHacT: excessHac.t,
    dailyExcessEdgeCiLow: excessHac.ciLow,
    dailyExcessEdgeCiHigh: excessHac.ciHigh,
    dailyExcessEdgeDates: excessHac.count,
  };
}

function analyzeFeatureHorizon(
  series: PreparedVfFeatureSeries[],
  outcomes: OutcomeSeries[],
  feature: VfFeatureId,
  horizon: number,
  warmupDays: number,
  policy: ReturnType<typeof splitPolicy>,
) {
  const stateGroups = new Map<string, MetricGroup>();
  const onsetGroups = new Map<string, MetricGroup>();
  for (let s = 0; s < series.length; s++) {
    const item = series[s]!;
    const outcome = outcomes[s]!;
    const states = item.states[feature];
    for (let i = warmupDays; i + horizon < item.bars.length; i++) {
      const current = states[i] as EncodedState;
      if (current === -1) continue;
      const ret = outcome.ret[i];
      if (!Number.isFinite(ret)) continue;
      const excess = Number.isFinite(outcome.excess[i]) ? outcome.excess[i]! : null;
      const mae = Number.isFinite(outcome.mae[i]) ? outcome.mae[i]! : null;
      const mfe = Number.isFinite(outcome.mfe[i]) ? outcome.mfe[i]! : null;
      const date = item.bars[i]!.tradeDate;
      const stateTargets = targets(stateGroups, date, item.market, policy);
      if (current === 1) {
        for (const group of stateTargets) updateGroup(group, date, "signal", ret, excess, mae, mfe);
      } else {
        for (const group of stateTargets) updateGroup(group, date, "control", ret, excess, mae, mfe);
      }

      const previous = (states[i - 1] ?? -1) as EncodedState;
      const onset = current === 1 && previous === 0;
      if (onset || current === 0) {
        const onsetTargets = targets(onsetGroups, date, item.market, policy);
        for (const group of onsetTargets)
          updateGroup(group, date, onset ? "signal" : "control", ret, excess, mae, mfe);
      }
    }
  }
  return [
    ...[...stateGroups.values()].map((group) => finalizeGroup(group, feature, "STATE", horizon)),
    ...[...onsetGroups.values()].map((group) => finalizeGroup(group, feature, "ONSET", horizon)),
  ];
}

function availability(
  series: PreparedVfFeatureSeries[],
  warmupDays: number,
): V8VfFeatureAvailabilityRow[] {
  return V8_VF_FEATURE_IDS.map((feature) => {
    let availableDays = 0;
    let trueDays = 0;
    let falseDays = 0;
    let onsetDays = 0;
    let missingDays = 0;
    let firstAvailableDate: string | null = null;
    let lastAvailableDate: string | null = null;
    for (const item of series) {
      const states = item.states[feature];
      for (let i = warmupDays; i < item.bars.length; i++) {
        const state = states[i] as EncodedState;
        if (state === -1) {
          missingDays++;
          continue;
        }
        availableDays++;
        if (state === 1) trueDays++;
        else falseDays++;
        if (state === 1 && (states[i - 1] as EncodedState) === 0) onsetDays++;
        const date = item.bars[i]!.tradeDate;
        if (firstAvailableDate === null || date < firstAvailableDate) firstAvailableDate = date;
        if (lastAvailableDate === null || date > lastAvailableDate) lastAvailableDate = date;
      }
    }
    return {
      feature,
      label: FEATURE_LABELS[feature],
      weight: FEATURE_WEIGHTS[feature],
      availableDays,
      trueDays,
      falseDays,
      onsetDays,
      missingDays,
      trueRate: pct(trueDays, availableDays),
      firstAvailableDate,
      lastAvailableDate,
    };
  });
}

function robustness(rows: V8VfFeatureMetricRow[], horizons: number[]): V8VfFeatureRobustnessRow[] {
  const out: V8VfFeatureRobustnessRow[] = [];
  for (const feature of V8_VF_FEATURE_IDS) {
    for (const signalKind of ["STATE", "ONSET"] as const) {
      const select = (split: "ALL" | "OOS") =>
        rows.filter(
          (row) =>
            row.scope === "SPLIT" &&
            row.split === split &&
            row.market === "ALL" &&
            row.feature === feature &&
            row.signalKind === signalKind,
        );
      const all = select("ALL");
      const oos = select("OOS");
      const edgeValues = (selected: V8VfFeatureMetricRow[]) =>
        selected.map((row) => row.dailyExcessEdgeMean).filter(finite);
      out.push({
        feature,
        label: FEATURE_LABELS[feature],
        signalKind,
        allPositiveExcessHorizons: all.filter((row) => (row.dailyExcessEdgeMean ?? 0) > 0).length,
        allSignificantPositiveExcessHorizons: all.filter(
          (row) => row.dailyExcessEdgeCiLow !== null && row.dailyExcessEdgeCiLow > 0,
        ).length,
        oosPositiveExcessHorizons: oos.filter((row) => (row.dailyExcessEdgeMean ?? 0) > 0).length,
        oosSignificantPositiveExcessHorizons: oos.filter(
          (row) => row.dailyExcessEdgeCiLow !== null && row.dailyExcessEdgeCiLow > 0,
        ).length,
        allMedianDailyExcessEdge: median(edgeValues(all)),
        oosMedianDailyExcessEdge: median(edgeValues(oos)),
        horizonsTested: horizons.length,
      });
    }
  }
  return out;
}

export function buildV8VfFeatureValidationFromSeries(
  series: PreparedVfFeatureSeries[],
  indexSeries: IndexSeries[],
  options: V8VfFeatureValidationOptions = {},
): V8VfFeatureValidationResult | null {
  if (!series.length) return null;
  const warmupDays = Math.max(0, Math.round(options.warmupDays ?? 120));
  const costBps = Math.max(0, options.roundTripCostBps ?? 0);
  const horizons = [...new Set((options.horizons ?? [...V8_VF_FEATURE_HORIZONS]).map((value) => Math.round(value)))]
    .filter((value) => value >= 1 && value <= 252)
    .sort((a, b) => a - b);
  if (!horizons.length) throw new Error("V8 Vf feature validation horizon이 비어 있습니다.");
  const dates = uniqueDates(series);
  const policy = splitPolicy(dates);
  const rows: V8VfFeatureMetricRow[] = [];

  for (const horizon of horizons) {
    const outcomes = buildOutcomes(series, indexSeries, horizon, costBps);
    for (const feature of V8_VF_FEATURE_IDS) {
      rows.push(...analyzeFeatureHorizon(series, outcomes, feature, horizon, warmupDays, policy));
    }
  }

  return {
    version: V8_VF_FEATURE_VALIDATION_VERSION,
    from: dates[0] ?? "",
    to: dates.at(-1) ?? "",
    symbolCount: series.length,
    horizons,
    warmupDays,
    roundTripCostBps: costBps,
    splitPolicy: policy,
    featureDefinitions: V8_VF_FEATURE_IDS.map((feature) => ({
      feature,
      label: FEATURE_LABELS[feature],
      weight: FEATURE_WEIGHTS[feature],
    })),
    availability: availability(series, warmupDays),
    rows,
    robustness: robustness(rows, horizons),
    inference: {
      unit: "daily-cross-sectional-signal-minus-control",
      estimator: "Newey-West-HAC",
      lagRule: "horizon-1",
      confidenceLevel: 0.95,
      controlDefinition: "same-feature available and false",
    },
    notes: [
      "Vf 7개 피처는 운영 scoring.ts와 동일한 technicalFlagsV3 및 DEFAULT_SCORING_CONFIG 임계값을 사용한다.",
      "State는 해당 날짜 피처가 true인 종목-일, Onset은 직전 거래일 false에서 당일 true로 전환된 종목-일이다. null→true는 Onset으로 세지 않는다.",
      "대조군은 동일 피처가 계산 가능하고 false인 종목-일이며, 결측값은 false 또는 0으로 대체하지 않는다.",
      "신호는 t 종가 시점에 확정되고 forward return은 t+1 시가 진입, t+h 종가 청산으로 계산한다.",
      "시장초과수익률은 종목 시장에 따라 KOSPI/KOSDAQ 지수의 동일 진입일 시가→동일 청산일 종가 수익률을 차감한다. market fallback은 사용하지 않는다.",
      "HAC 검정은 각 거래일의 신호군 평균 - 대조군 평균을 먼저 만든 뒤 Newey-West를 적용한다. 겹치는 h일 forward return을 고려해 lag=h-1을 사용한다.",
      "Development/Validation/OOS는 전체 거래일을 시간순 60/20/20으로 고정 분할한다. 기존 V8 OOS의 마지막 20% 정의와 정합된다.",
      "연도별 행은 YEAR scope, 기간분할 행은 SPLIT scope로 제공한다. 시장국면(regime) 분리는 V8 연구 7번에서 별도 검증한다.",
    ],
  };
}

export function runV8VfFeatureValidation(
  dataset: MarketDataset,
  options: V8VfFeatureValidationOptions = {},
): V8VfFeatureValidationResult | null {
  const limit = Math.max(1, Math.round(options.limit ?? 613));
  const warmupDays = Math.max(0, Math.round(options.warmupDays ?? 120));
  const series = prepareV8VfFeatureSeries(dataset, limit, warmupDays);
  return buildV8VfFeatureValidationFromSeries(series, dataset.indexSeries, {
    ...options,
    limit,
    warmupDays,
  });
}
