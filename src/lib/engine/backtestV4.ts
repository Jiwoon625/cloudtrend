// CloudTrend Backtest V5
// V4의 장기 시장조정/Signal Onset 검증 구조를 유지하면서,
// Score Threshold Onset과 score ranking 성능을 추가로 검증한다.
import { computeIndicators } from "./indicators";
import {
  BACKTEST_FEATURES as LEGACY_BACKTEST_FEATURES,
  DEFAULT_BACKTEST_PARAMS as LEGACY_DEFAULT_BACKTEST_PARAMS,
  DEFAULT_ENTRY_THRESHOLDS,
  DEFAULT_EXTENSION_THRESHOLDS,
  DEFAULT_HORIZONS,
  DEFAULT_VOLUME_THRESHOLDS,
  VOLUME_SURGE_MODES,
  evaluateFeatures,
  horizonMetric as legacyHorizonMetric,
  median,
  pearson,
  quantile,
  volumeSurgeFlag,
  type BacktestParams,
  type CorrelationMatrix,
  type DistributionStat,
  type FeatureDistribution,
  type HorizonMetric as LegacyHorizonMetric,
  type VolumeSurgeMode,
} from "./backtest";
import type { DailyPrice, IndexSeries } from "./types";

export {
  DEFAULT_ENTRY_THRESHOLDS,
  DEFAULT_EXTENSION_THRESHOLDS,
  DEFAULT_HORIZONS,
  DEFAULT_VOLUME_THRESHOLDS,
  VOLUME_SURGE_MODES,
};
export type { BacktestParams, VolumeSurgeMode };

/**
 * MA20 상승/20일 수익률 양수는 V4부터 독립 피처에서 제외한다.
 * 과거 저장 설정이나 업로드 데이터에 관련 값이 있어도 active feature로 사용하지 않는다.
 */
const REMOVED_BACKTEST_FEATURE_IDS = new Set(["MA20_SLOPE_UP", "RS_POSITIVE"]);
export const BACKTEST_FEATURES = LEGACY_BACKTEST_FEATURES.filter(
  (f) => !REMOVED_BACKTEST_FEATURE_IDS.has(f.id),
);

/** V5 고정 검증 기준. */
export const DEFAULT_INTERVAL_CANDIDATES = [5, 10, 20];
export const DEFAULT_SCORE_ONSET_THRESHOLDS = [40, 50, 60, 70, 80];
export const RANKING_HORIZON = 30;
export const TOP_SELECTION_COUNT = 5;
export const RANKING_QUANTILE_BUCKETS = [5, 10];

export const DEFAULT_BACKTEST_PARAMS: BacktestParams = {
  ...LEGACY_DEFAULT_BACKTEST_PARAMS,
  features: BACKTEST_FEATURES.map((f) => f.id),
  weights: Object.fromEntries(BACKTEST_FEATURES.map((f) => [f.id, f.defaultWeight])),
  sampleEvery: 5,
  intervalCandidates: DEFAULT_INTERVAL_CANDIDATES,
};

export type BacktestMarket = "KOSPI" | "KOSDAQ";
export type MarketRegime = "RISK_ON" | "NEUTRAL" | "RISK_OFF" | "UNKNOWN";
export type SampleSplit = "DEVELOPMENT" | "VALIDATION" | "OOS";

export interface BacktestInputSeries {
  symbol: string;
  name: string;
  market?: BacktestMarket;
  bars: DailyPrice[];
}

export interface BacktestMarketContext {
  indexSeries: IndexSeries[];
}

export interface HorizonMetric extends LegacyHorizonMetric {
  marketAdjustedSignalAvgReturn: number | null;
  marketAdjustedNonSignalAvgReturn: number | null;
  marketAdjustedEdge: number | null;
  crossSectionalEdge: number | null;
  marketAdjustedCrossSectionalEdge: number | null;
  robustTStat: number | null;
  ci95Low: number | null;
  ci95High: number | null;
  robustObservations: number;
}

export interface FeatureHorizonResult {
  featureKey: string;
  featureLabel: string;
  signalRate: number | null;
  metrics: HorizonMetric[];
}

export interface FeatureStat {
  id: string;
  label: string;
  signalCount: number;
  noSignalCount: number;
  avgReturnOn: number | null;
  avgReturnOff: number | null;
  edge: number | null;
  hitRateOn: number | null;
  hitRateOff: number | null;
  tStat: number | null;
  medianReturnOn: number | null;
  medianReturnOff: number | null;
  marketAdjustedEdge: number | null;
  crossSectionalEdge: number | null;
  marketAdjustedCrossSectionalEdge: number | null;
  robustTStat: number | null;
  ci95Low: number | null;
  ci95High: number | null;
}

export interface BucketStat {
  label: string;
  count: number;
  avgReturn: number | null;
  hitRate: number | null;
  medianReturn: number | null;
}

export interface BucketHorizonStat extends BucketStat {
  horizon: number;
}

export interface EntryThresholdStat {
  threshold: number;
  horizon: number;
  count: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  edgeVsAll: number | null;
  marketAdjustedAvgReturn: number | null;
}

export interface ScoreOnsetStat extends EntryThresholdStat {}

export interface IntervalSensitivityStat {
  interval: number;
  horizon: number;
  observations: number;
  entrySignals: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  edge: number | null;
  overlapRatio: number;
  marketAdjustedAvgReturn: number | null;
}

export interface ThresholdSensitivityRow {
  threshold: number;
  signalRate: number | null;
  lowDiscrimination: boolean;
  metrics: HorizonMetric[];
}

export interface BreakdownStat {
  segment: string;
  featureKey: string;
  featureLabel: string;
  horizon: number;
  observations: number;
  signalCount: number;
  edge: number | null;
  marketAdjustedEdge: number | null;
  crossSectionalEdge: number | null;
  marketAdjustedCrossSectionalEdge: number | null;
  robustTStat: number | null;
  ci95Low: number | null;
  ci95High: number | null;
}

export interface RankIcDateStat {
  date: string;
  observations: number;
  rawRankIc: number | null;
  marketAdjustedRankIc: number | null;
}

export interface RankIcSummary {
  horizon: number;
  dates: number;
  avgRawRankIc: number | null;
  medianRawRankIc: number | null;
  rawPositiveRate: number | null;
  avgMarketAdjustedRankIc: number | null;
  medianMarketAdjustedRankIc: number | null;
  marketAdjustedPositiveRate: number | null;
}

export interface TopSelectionDateStat {
  date: string;
  symbols: string[];
  count: number;
  avgScore: number | null;
  avgReturn: number | null;
  benchmarkAvgReturn: number | null;
  marketAdjustedAvgReturn: number | null;
}

export interface TopSelectionSummary {
  horizon: number;
  topN: number;
  dates: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  marketAdjustedAvgReturn: number | null;
  dateReturns: TopSelectionDateStat[];
}

export interface QuantileSpreadStat {
  horizon: number;
  bucketCount: number;
  dates: number;
  topAvgReturn: number | null;
  bottomAvgReturn: number | null;
  rawSpread: number | null;
  topMarketAdjustedAvgReturn: number | null;
  bottomMarketAdjustedAvgReturn: number | null;
  marketAdjustedSpread: number | null;
  robustTStat: number | null;
  ci95Low: number | null;
  ci95High: number | null;
}

export interface BacktestConfigSnapshot {
  features: string[];
  weights: Record<string, number>;
  horizonDays: number;
  horizons: number[];
  sampleEvery: number;
  entryScore: number;
  entryThresholds: number[];
  intervalCandidates: number[];
  extensionLimit: number;
  extensionThresholds: number[];
  volumeSurgeRatio: number;
  volumeThresholds: number[];
  volumeMode: VolumeSurgeMode;
  scoreOnsetThresholds: number[];
  rankingHorizon: number;
  topSelectionCount: number;
  rankingQuantileBuckets: number[];
}

export interface BacktestSummary {
  strongestByHorizon: Array<{ horizon: number; featureKey: string; label: string; edge: number }>;
  strongestAdjustedByHorizon: Array<{
    horizon: number;
    featureKey: string;
    label: string;
    edge: number;
  }>;
  worstFeature: { featureKey: string; label: string; edge: number; horizon: number } | null;
  highestTStat: { featureKey: string; label: string; tStat: number; horizon: number } | null;
  stableFeatures: Array<{ featureKey: string; label: string }>;
  lowDiscriminationFeatures: Array<{ featureKey: string; label: string; signalRate: number }>;
  oosStableFeatures: Array<{ featureKey: string; label: string }>;
}

export interface BacktestResult {
  observations: number;
  symbolCount: number;
  from: string;
  to: string;
  horizonDays: number;
  avgBars: number;
  baselineAvgReturn: number | null;
  baselineMarketReturn: number | null;
  baselineMarketAdjustedReturn: number | null;
  config: BacktestConfigSnapshot;
  features: FeatureStat[];
  buckets: BucketStat[];
  strategy: {
    trades: number;
    avgReturn: number | null;
    medianReturn: number | null;
    hitRate: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    expectancy: number | null;
    excessVsBaseline: number | null;
    marketAdjustedAvgReturn: number | null;
  };
  notes: string[];
  horizons: number[];
  baselineByHorizon: Array<{
    horizon: number;
    count: number;
    avgReturn: number | null;
    medianReturn: number | null;
    marketAvgReturn: number | null;
    marketAdjustedAvgReturn: number | null;
  }>;
  featureHorizons: FeatureHorizonResult[];
  bucketHorizons: BucketHorizonStat[];
  entryThresholds: EntryThresholdStat[];
  scoreOnsets: ScoreOnsetStat[];
  rankIcByDate: RankIcDateStat[];
  rankIcSummary: RankIcSummary;
  topSelection: TopSelectionSummary;
  quantileSpreads: QuantileSpreadStat[];
  intervalSensitivity: IntervalSensitivityStat[];
  extensionSensitivity: ThresholdSensitivityRow[];
  volumeSensitivity: ThresholdSensitivityRow[];
  correlation: CorrelationMatrix;
  distributions: FeatureDistribution[];
  summary: BacktestSummary;
  overlapRatio: number;
  baseInterval: number;
  volumeMode: VolumeSurgeMode;
  marketBreakdown: BreakdownStat[];
  yearlyBreakdown: BreakdownStat[];
  regimeBreakdown: BreakdownStat[];
  splitBreakdown: BreakdownStat[];
  splitBoundaries: {
    developmentEnd: string | null;
    validationEnd: string | null;
    oosStart: string | null;
  };
  regimeCounts: Record<MarketRegime, number>;
}

interface Observation {
  symbol: string;
  market: BacktestMarket;
  date: string;
  year: string;
  regime: MarketRegime;
  split: SampleSplit;
  flags: Record<string, boolean | null>;
  stateFlags: Record<string, boolean | null>;
  score: number | null;
  rets: Array<number | null>;
  benchmarkRets: Array<number | null>;
  excessRets: Array<number | null>;
  volumeRatio: number | null;
  extension: number | null;
  dayReturn: number | null;
  clv: number | null;
}

interface BenchmarkData {
  closeByDate: Map<string, number>;
  regimeByDate: Map<string, MarketRegime>;
}

const SCORE_EDGES: Array<[number, number, string]> = [
  [0, 20, "0~20점"],
  [20, 40, "20~40점"],
  [40, 60, "40~60점"],
  [60, 80, "60~80점"],
  [80, 100.001, "80~100점"],
];

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const winRate = (xs: number[]): number | null =>
  xs.length ? (xs.filter((r) => r > 0).length / xs.length) * 100 : null;

function distribution(xs: number[]): DistributionStat {
  return {
    count: xs.length,
    mean: mean(xs),
    p5: quantile(xs, 5),
    p25: quantile(xs, 25),
    median: quantile(xs, 50),
    p75: quantile(xs, 75),
    p95: quantile(xs, 95),
  };
}

function normalizeList(values: number[] | undefined, fallback: number[]): number[] {
  const list = (values?.length ? values : fallback)
    .map((v) => Math.round(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  return [...new Set(list)].sort((a, b) => a - b);
}

function closeLocationValue(bar: DailyPrice): number | null {
  const range = bar.high - bar.low;
  return range > 0 ? (bar.close - bar.low) / range : null;
}

function realizedVolAt(bars: DailyPrice[], endIndex: number, window = 20): number | null {
  if (endIndex < window) return null;
  const xs: number[] = [];
  for (let i = endIndex - window + 1; i <= endIndex; i++) {
    const p0 = bars[i - 1]?.close;
    const p1 = bars[i]?.close;
    if (!(p0 && p1 && p0 > 0 && p1 > 0)) return null;
    xs.push(Math.log(p1 / p0));
  }
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1);
  return Math.sqrt(v * 252) * 100;
}

function buildBenchmarks(ctx?: BacktestMarketContext): Record<BacktestMarket, BenchmarkData> | null {
  if (!ctx?.indexSeries?.length) return null;
  const kospi = ctx.indexSeries.find((s) => s.indexCode.toUpperCase() === "KOSPI");
  const kosdaq = ctx.indexSeries.find((s) => s.indexCode.toUpperCase() === "KOSDAQ");
  if (!kospi) return null;

  const volMaps = new Map<BacktestMarket, Map<string, number>>();
  for (const [market, series] of [
    ["KOSPI", kospi],
    ["KOSDAQ", kosdaq ?? kospi],
  ] as const) {
    const m = new Map<string, number>();
    series.bars.forEach((bar, i) => {
      const v = realizedVolAt(series.bars, i);
      if (v !== null) m.set(bar.tradeDate, v);
    });
    volMaps.set(market, m);
  }

  const blendedVol = new Map<string, number>();
  const dates = new Set<string>([
    ...volMaps.get("KOSPI")!.keys(),
    ...volMaps.get("KOSDAQ")!.keys(),
  ]);
  for (const d of dates) {
    const kp = volMaps.get("KOSPI")!.get(d);
    const kq = volMaps.get("KOSDAQ")!.get(d);
    if (kp !== undefined && kq !== undefined) blendedVol.set(d, 0.7 * kp + 0.3 * kq);
    else if (kp !== undefined) blendedVol.set(d, kp);
    else if (kq !== undefined) blendedVol.set(d, kq);
  }

  const build = (series: IndexSeries): BenchmarkData => {
    const closeByDate = new Map<string, number>();
    const regimeByDate = new Map<string, MarketRegime>();
    series.bars.forEach((bar, i) => {
      closeByDate.set(bar.tradeDate, bar.close);
      if (i < 120) {
        regimeByDate.set(bar.tradeDate, "UNKNOWN");
        return;
      }
      const snap = computeIndicators(series.bars, i);
      const checks: Array<boolean | null> = [
        snap.ma60 === null ? null : snap.close > snap.ma60,
        snap.ichimoku.cloudTop === null ? null : snap.close > snap.ichimoku.cloudTop,
        snap.return60 === null ? null : snap.return60 > 0,
        blendedVol.get(bar.tradeDate) === undefined ? null : blendedVol.get(bar.tradeDate)! < 30,
      ];
      const evaluated = checks.filter((v) => v !== null).length;
      const met = checks.filter((v) => v === true).length;
      const regime: MarketRegime =
        evaluated < 3 ? "UNKNOWN" : met >= 3 ? "RISK_ON" : met <= 1 ? "RISK_OFF" : "NEUTRAL";
      regimeByDate.set(bar.tradeDate, regime);
    });
    return { closeByDate, regimeByDate };
  };

  return {
    KOSPI: build(kospi),
    KOSDAQ: build(kosdaq ?? kospi),
  };
}

function benchmarkReturn(
  bench: BenchmarkData | undefined,
  entryDate: string,
  exitDate: string,
): number | null {
  if (!bench) return null;
  const a = bench.closeByDate.get(entryDate);
  const b = bench.closeByDate.get(exitDate);
  if (!(a && b && a > 0 && b > 0)) return null;
  return (b / a - 1) * 100;
}

function groupByDate(rows: Observation[]): Map<string, Observation[]> {
  const out = new Map<string, Observation[]>();
  for (const o of rows) {
    const cur = out.get(o.date);
    if (cur) cur.push(o);
    else out.set(o.date, [o]);
  }
  return out;
}

function hacMeanStats(xs: number[], lag: number): {
  mean: number | null;
  t: number | null;
  low: number | null;
  high: number | null;
} {
  const m = mean(xs);
  if (m === null || xs.length < 3) return { mean: m, t: null, low: null, high: null };
  const n = xs.length;
  const centered = xs.map((x) => x - m);
  let longRun = centered.reduce((a, x) => a + x * x, 0) / n;
  const maxLag = Math.min(Math.max(0, lag), n - 1);
  for (let l = 1; l <= maxLag; l++) {
    let gamma = 0;
    for (let t = l; t < n; t++) gamma += centered[t]! * centered[t - l]!;
    gamma /= n;
    const weight = 1 - l / (maxLag + 1);
    longRun += 2 * weight * gamma;
  }
  const se = Math.sqrt(Math.max(0, longRun) / n);
  if (!(se > 0)) return { mean: m, t: null, low: m, high: m };
  return { mean: m, t: m / se, low: m - 1.96 * se, high: m + 1.96 * se };
}

function splitReturns(
  rows: Observation[],
  hIdx: number,
  pick: (o: Observation) => boolean | null,
  adjusted = false,
): { on: number[]; off: number[] } {
  const on: number[] = [];
  const off: number[] = [];
  for (const o of rows) {
    const flag = pick(o);
    if (flag === null || flag === undefined) continue;
    const r = adjusted ? o.excessRets[hIdx] : o.rets[hIdx];
    if (r === null || r === undefined) continue;
    (flag ? on : off).push(r);
  }
  return { on, off };
}

function dailyEdges(
  groups: Map<string, Observation[]>,
  hIdx: number,
  pick: (o: Observation) => boolean | null,
  adjusted = false,
): number[] {
  const out: number[] = [];
  for (const rows of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => r)) {
    const { on, off } = splitReturns(rows, hIdx, pick, adjusted);
    const a = mean(on);
    const b = mean(off);
    if (a !== null && b !== null) out.push(a - b);
  }
  return out;
}

function enhancedMetric(
  rows: Observation[],
  groups: Map<string, Observation[]>,
  hIdx: number,
  horizon: number,
  sampleEvery: number,
  pick: (o: Observation) => boolean | null,
): HorizonMetric {
  const raw = splitReturns(rows, hIdx, pick, false);
  const adj = splitReturns(rows, hIdx, pick, true);
  const legacy = legacyHorizonMetric(raw.on, raw.off, horizon);
  const adjA = mean(adj.on);
  const adjB = mean(adj.off);
  const rawDaily = dailyEdges(groups, hIdx, pick, false);
  const adjDaily = dailyEdges(groups, hIdx, pick, true);
  const robust = hacMeanStats(adjDaily, Math.max(1, Math.ceil(horizon / sampleEvery) - 1));
  return {
    ...legacy,
    marketAdjustedSignalAvgReturn: adjA,
    marketAdjustedNonSignalAvgReturn: adjB,
    marketAdjustedEdge: adjA !== null && adjB !== null ? adjA - adjB : null,
    crossSectionalEdge: mean(rawDaily),
    marketAdjustedCrossSectionalEdge: robust.mean,
    robustTStat: robust.t,
    ci95Low: robust.low,
    ci95High: robust.high,
    robustObservations: adjDaily.length,
  };
}

function breakdownFor(
  rows: Observation[],
  active: typeof BACKTEST_FEATURES,
  hIdx: number,
  horizon: number,
  sampleEvery: number,
  segment: string,
): BreakdownStat[] {
  const groups = groupByDate(rows);
  return active.map((f) => {
    const m = enhancedMetric(rows, groups, hIdx, horizon, sampleEvery, (o) => o.flags[f.id] ?? null);
    return {
      segment,
      featureKey: f.id,
      featureLabel: f.label,
      horizon,
      observations: rows.length,
      signalCount: m.signalCount,
      edge: m.edge,
      marketAdjustedEdge: m.marketAdjustedEdge,
      crossSectionalEdge: m.crossSectionalEdge,
      marketAdjustedCrossSectionalEdge: m.marketAdjustedCrossSectionalEdge,
      robustTStat: m.robustTStat,
      ci95Low: m.ci95Low,
      ci95High: m.ci95High,
    };
  });
}

export function signalOnsetFlags(
  current: Record<string, boolean | null>,
  previous: Record<string, boolean | null> | null,
): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (const [id, value] of Object.entries(current)) {
    if (value === null || value === undefined) {
      out[id] = null;
      continue;
    }
    if (!value) {
      out[id] = false;
      continue;
    }
    const prior = previous?.[id] ?? null;
    out[id] = prior === false ? true : prior === true ? false : null;
  }
  return out;
}

/** score[t-1] < threshold && score[t] >= threshold */
export function scoreThresholdOnset(
  previousScore: number | null | undefined,
  currentScore: number | null | undefined,
  threshold: number,
): boolean | null {
  if (previousScore === null || previousScore === undefined) return null;
  if (currentScore === null || currentScore === undefined) return null;
  return previousScore < threshold && currentScore >= threshold;
}

function averageRanks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.value === order[start]!.value) end++;
    const avgRank = (start + end + 2) / 2;
    for (let i = start; i <= end; i++) ranks[order[i]!.index] = avgRank;
    start = end + 1;
  }
  return ranks;
}

/** tie에는 평균 rank를 부여하는 Spearman correlation. */
export function spearmanRankCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

function buildScoreOnsets(
  perSymbol: Observation[][],
  main: Observation[],
  horizons: number[],
  retsAt: (rows: Observation[], hIdx: number) => number[],
  excessAt: (rows: Observation[], hIdx: number) => number[],
): ScoreOnsetStat[] {
  const byThreshold = new Map<number, Observation[]>();
  for (const threshold of DEFAULT_SCORE_ONSET_THRESHOLDS) byThreshold.set(threshold, []);
  for (const rows of perSymbol) {
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1]!;
      const current = rows[i]!;
      for (const threshold of DEFAULT_SCORE_ONSET_THRESHOLDS) {
        if (scoreThresholdOnset(previous.score, current.score, threshold) === true)
          byThreshold.get(threshold)!.push(current);
      }
    }
  }

  const out: ScoreOnsetStat[] = [];
  for (const threshold of DEFAULT_SCORE_ONSET_THRESHOLDS) {
    const rows = byThreshold.get(threshold)!;
    horizons.forEach((horizon, hIdx) => {
      const xs = retsAt(rows, hIdx);
      const all = retsAt(main, hIdx);
      const wins = xs.filter((r) => r > 0);
      const losses = xs.filter((r) => r <= 0);
      const avg = mean(xs);
      const base = mean(all);
      out.push({
        threshold,
        horizon,
        count: xs.length,
        avgReturn: avg,
        medianReturn: median(xs),
        winRate: winRate(xs),
        avgWin: mean(wins),
        avgLoss: mean(losses),
        edgeVsAll: avg !== null && base !== null ? avg - base : null,
        marketAdjustedAvgReturn: mean(excessAt(rows, hIdx)),
      });
    });
  }
  return out;
}

function buildRankingAnalysis(
  groups: Map<string, Observation[]>,
  horizons: number[],
  baseInterval: number,
): {
  rankIcByDate: RankIcDateStat[];
  rankIcSummary: RankIcSummary;
  topSelection: TopSelectionSummary;
  quantileSpreads: QuantileSpreadStat[];
} {
  const hIdx = horizons.indexOf(RANKING_HORIZON);
  if (hIdx < 0) {
    return {
      rankIcByDate: [],
      rankIcSummary: {
        horizon: RANKING_HORIZON,
        dates: 0,
        avgRawRankIc: null,
        medianRawRankIc: null,
        rawPositiveRate: null,
        avgMarketAdjustedRankIc: null,
        medianMarketAdjustedRankIc: null,
        marketAdjustedPositiveRate: null,
      },
      topSelection: {
        horizon: RANKING_HORIZON,
        topN: TOP_SELECTION_COUNT,
        dates: 0,
        avgReturn: null,
        medianReturn: null,
        winRate: null,
        marketAdjustedAvgReturn: null,
        dateReturns: [],
      },
      quantileSpreads: RANKING_QUANTILE_BUCKETS.map((bucketCount) => ({
        horizon: RANKING_HORIZON,
        bucketCount,
        dates: 0,
        topAvgReturn: null,
        bottomAvgReturn: null,
        rawSpread: null,
        topMarketAdjustedAvgReturn: null,
        bottomMarketAdjustedAvgReturn: null,
        marketAdjustedSpread: null,
        robustTStat: null,
        ci95Low: null,
        ci95High: null,
      })),
    };
  }

  const rankIcByDate: RankIcDateStat[] = [];
  const topDateReturns: TopSelectionDateStat[] = [];
  const quantileDaily = new Map<
    number,
    Array<{
      topRaw: number;
      bottomRaw: number;
      rawSpread: number;
      topAdjusted: number | null;
      bottomAdjusted: number | null;
      adjustedSpread: number | null;
    }>
  >();
  for (const buckets of RANKING_QUANTILE_BUCKETS) quantileDaily.set(buckets, []);

  for (const [date, rows] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rawPairs = rows.filter(
      (o) => o.score !== null && o.rets[hIdx] !== null && o.rets[hIdx] !== undefined,
    );
    const adjustedPairs = rows.filter(
      (o) => o.score !== null && o.excessRets[hIdx] !== null && o.excessRets[hIdx] !== undefined,
    );
    const rawRankIc = spearmanRankCorrelation(
      rawPairs.map((o) => o.score!),
      rawPairs.map((o) => o.rets[hIdx]!),
    );
    const marketAdjustedRankIc = spearmanRankCorrelation(
      adjustedPairs.map((o) => o.score!),
      adjustedPairs.map((o) => o.excessRets[hIdx]!),
    );
    if (rawRankIc !== null || marketAdjustedRankIc !== null) {
      rankIcByDate.push({
        date,
        observations: rawPairs.length,
        rawRankIc,
        marketAdjustedRankIc,
      });
    }

    const ranked = [...rawPairs].sort(
      (a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.symbol.localeCompare(b.symbol),
    );
    const selected = ranked.slice(0, TOP_SELECTION_COUNT);
    if (selected.length) {
      topDateReturns.push({
        date,
        symbols: selected.map((o) => o.symbol),
        count: selected.length,
        avgScore: mean(selected.map((o) => o.score!).filter(Number.isFinite)),
        avgReturn: mean(selected.map((o) => o.rets[hIdx]!).filter(Number.isFinite)),
        benchmarkAvgReturn: mean(
          selected
            .map((o) => o.benchmarkRets[hIdx])
            .filter((r): r is number => r !== null && r !== undefined),
        ),
        marketAdjustedAvgReturn: mean(
          selected
            .map((o) => o.excessRets[hIdx])
            .filter((r): r is number => r !== null && r !== undefined),
        ),
      });
    }

    for (const bucketCount of RANKING_QUANTILE_BUCKETS) {
      const bucketSize = Math.floor(ranked.length / bucketCount);
      if (bucketSize < 1) continue;
      const top = ranked.slice(0, bucketSize);
      const bottom = ranked.slice(-bucketSize);
      const topRaw = mean(top.map((o) => o.rets[hIdx]!).filter(Number.isFinite));
      const bottomRaw = mean(bottom.map((o) => o.rets[hIdx]!).filter(Number.isFinite));
      if (topRaw === null || bottomRaw === null) continue;
      const topAdjusted = mean(
        top.map((o) => o.excessRets[hIdx]).filter((r): r is number => r !== null && r !== undefined),
      );
      const bottomAdjusted = mean(
        bottom
          .map((o) => o.excessRets[hIdx])
          .filter((r): r is number => r !== null && r !== undefined),
      );
      quantileDaily.get(bucketCount)!.push({
        topRaw,
        bottomRaw,
        rawSpread: topRaw - bottomRaw,
        topAdjusted,
        bottomAdjusted,
        adjustedSpread:
          topAdjusted !== null && bottomAdjusted !== null ? topAdjusted - bottomAdjusted : null,
      });
    }
  }

  const rawIcs = rankIcByDate
    .map((r) => r.rawRankIc)
    .filter((r): r is number => r !== null && r !== undefined);
  const adjustedIcs = rankIcByDate
    .map((r) => r.marketAdjustedRankIc)
    .filter((r): r is number => r !== null && r !== undefined);
  const dailyTopRaw = topDateReturns
    .map((r) => r.avgReturn)
    .filter((r): r is number => r !== null && r !== undefined);
  const dailyTopAdjusted = topDateReturns
    .map((r) => r.marketAdjustedAvgReturn)
    .filter((r): r is number => r !== null && r !== undefined);

  const rankIcSummary: RankIcSummary = {
    horizon: RANKING_HORIZON,
    dates: rankIcByDate.length,
    avgRawRankIc: mean(rawIcs),
    medianRawRankIc: median(rawIcs),
    rawPositiveRate: winRate(rawIcs),
    avgMarketAdjustedRankIc: mean(adjustedIcs),
    medianMarketAdjustedRankIc: median(adjustedIcs),
    marketAdjustedPositiveRate: winRate(adjustedIcs),
  };

  const topSelection: TopSelectionSummary = {
    horizon: RANKING_HORIZON,
    topN: TOP_SELECTION_COUNT,
    dates: topDateReturns.length,
    avgReturn: mean(dailyTopRaw),
    medianReturn: median(dailyTopRaw),
    winRate: winRate(dailyTopRaw),
    marketAdjustedAvgReturn: mean(dailyTopAdjusted),
    dateReturns: topDateReturns,
  };

  const quantileSpreads: QuantileSpreadStat[] = RANKING_QUANTILE_BUCKETS.map((bucketCount) => {
    const rows = quantileDaily.get(bucketCount)!;
    const topRaw = rows.map((r) => r.topRaw);
    const bottomRaw = rows.map((r) => r.bottomRaw);
    const rawSpreads = rows.map((r) => r.rawSpread);
    const topAdjusted = rows
      .map((r) => r.topAdjusted)
      .filter((r): r is number => r !== null && r !== undefined);
    const bottomAdjusted = rows
      .map((r) => r.bottomAdjusted)
      .filter((r): r is number => r !== null && r !== undefined);
    const adjustedSpreads = rows
      .map((r) => r.adjustedSpread)
      .filter((r): r is number => r !== null && r !== undefined);
    const robust = hacMeanStats(
      adjustedSpreads,
      Math.max(1, Math.ceil(RANKING_HORIZON / baseInterval) - 1),
    );
    return {
      horizon: RANKING_HORIZON,
      bucketCount,
      dates: rows.length,
      topAvgReturn: mean(topRaw),
      bottomAvgReturn: mean(bottomRaw),
      rawSpread: mean(rawSpreads),
      topMarketAdjustedAvgReturn: mean(topAdjusted),
      bottomMarketAdjustedAvgReturn: mean(bottomAdjusted),
      marketAdjustedSpread: robust.mean,
      robustTStat: robust.t,
      ci95Low: robust.low,
      ci95High: robust.high,
    };
  });

  return { rankIcByDate, rankIcSummary, topSelection, quantileSpreads };
}

export function runBacktest(
  series: BacktestInputSeries[],
  paramsInput: BacktestParams,
  marketContext?: BacktestMarketContext,
): BacktestResult {
  const params: BacktestParams = {
    ...paramsInput,
    features: paramsInput.features.filter((id) => !REMOVED_BACKTEST_FEATURE_IDS.has(id)),
    horizonDays: Math.max(1, Math.min(120, Math.round(paramsInput.horizonDays))),
    sampleEvery: Math.max(1, Math.min(20, Math.round(paramsInput.sampleEvery))),
  };
  const volumeMode = params.volumeMode ?? "HIGH_CLOSE";
  const active = BACKTEST_FEATURES.filter((f) => params.features.includes(f.id));
  const horizons = normalizeList(
    [...(params.horizons ?? DEFAULT_HORIZONS), params.horizonDays],
    [...DEFAULT_HORIZONS, params.horizonDays],
  );
  const pIdx = Math.max(0, horizons.indexOf(params.horizonDays));
  const minHorizon = horizons[0]!;
  const maxHorizon = horizons[horizons.length - 1]!;
  const baseInterval = params.sampleEvery;
  const requestedIntervals = normalizeList(params.intervalCandidates, DEFAULT_INTERVAL_CANDIDATES);
  const intervals = requestedIntervals.filter((v) => v >= baseInterval && v % baseInterval === 0);
  const benchmarks = buildBenchmarks(marketContext);

  const perSymbol: Observation[][] = [];
  let from = "";
  let to = "";
  let barTotal = 0;
  let usedSymbols = 0;

  for (const s of series) {
    const bars = s.bars;
    if (bars.length < 130) continue;
    const market: BacktestMarket = s.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
    const bench = benchmarks?.[market];
    usedSymbols++;
    barTotal += bars.length;
    if (!from || bars[0]!.tradeDate < from) from = bars[0]!.tradeDate;
    const lastDate = bars[bars.length - 1]!.tradeDate;
    if (lastDate > to) to = lastDate;

    const obs: Observation[] = [];
    let previousStateFlags: Record<string, boolean | null> | null = null;
    for (let i = 120; i + minHorizon < bars.length; i += baseInterval) {
      const entry = bars[i]!.close;
      if (!(entry > 0)) continue;
      const snap = computeIndicators(bars, i);
      const stateFlags = evaluateFeatures(snap, params, bars[i]!);
      const flags = signalOnsetFlags(stateFlags, previousStateFlags);
      previousStateFlags = stateFlags;
      let weighted = 0;
      let available = 0;
      for (const f of active) {
        const v = stateFlags[f.id];
        if (v === null || v === undefined) continue;
        const w = Math.max(0, params.weights[f.id] ?? f.defaultWeight);
        available += w;
        if (v) weighted += w;
      }
      const rets = horizons.map((h) => {
        const exit = bars[i + h]?.close;
        return exit !== undefined && exit > 0 ? (exit / entry - 1) * 100 : null;
      });
      const benchmarkRets = horizons.map((h) => {
        const exitDate = bars[i + h]?.tradeDate;
        return exitDate ? benchmarkReturn(bench, bars[i]!.tradeDate, exitDate) : null;
      });
      const excessRets = rets.map((r, idx) => {
        const b = benchmarkRets[idx];
        return r !== null && b !== null && b !== undefined ? r - b : null;
      });
      obs.push({
        symbol: s.symbol,
        market,
        date: bars[i]!.tradeDate,
        year: bars[i]!.tradeDate.slice(0, 4),
        regime: bench?.regimeByDate.get(bars[i]!.tradeDate) ?? "UNKNOWN",
        split: "DEVELOPMENT",
        flags,
        stateFlags,
        score: available > 0 ? (weighted / available) * 100 : null,
        rets,
        benchmarkRets,
        excessRets,
        volumeRatio: snap.volumeRatio20,
        extension: snap.extensionFromMa20,
        dayReturn: snap.dayReturn,
        clv: closeLocationValue(bars[i]!),
      });
    }
    perSymbol.push(obs);
  }

  const main = perSymbol.flat();
  const uniqueDates = [...new Set(main.map((o) => o.date))].sort();
  const devCut = Math.max(1, Math.floor(uniqueDates.length * 0.6));
  const valCut = Math.max(devCut + 1, Math.floor(uniqueDates.length * 0.8));
  const developmentEnd = uniqueDates[devCut - 1] ?? null;
  const validationEnd = uniqueDates[valCut - 1] ?? developmentEnd;
  const oosStart = uniqueDates[valCut] ?? null;
  const dateRank = new Map(uniqueDates.map((d, i) => [d, i]));
  for (const o of main) {
    const i = dateRank.get(o.date) ?? 0;
    o.split = i < devCut ? "DEVELOPMENT" : i < valCut ? "VALIDATION" : "OOS";
  }

  const groups = groupByDate(main);
  const retsAt = (rows: Observation[], hIdx: number): number[] =>
    rows.map((o) => o.rets[hIdx]).filter((r): r is number => r !== null);
  const marketAt = (rows: Observation[], hIdx: number): number[] =>
    rows.map((o) => o.benchmarkRets[hIdx]).filter((r): r is number => r !== null);
  const excessAt = (rows: Observation[], hIdx: number): number[] =>
    rows.map((o) => o.excessRets[hIdx]).filter((r): r is number => r !== null);

  const baselineByHorizon = horizons.map((h, hIdx) => {
    const xs = retsAt(main, hIdx);
    const markets = marketAt(main, hIdx);
    const excess = excessAt(main, hIdx);
    return {
      horizon: h,
      count: xs.length,
      avgReturn: mean(xs),
      medianReturn: median(xs),
      marketAvgReturn: mean(markets),
      marketAdjustedAvgReturn: mean(excess),
    };
  });

  const featureHorizons: FeatureHorizonResult[] = active.map((f) => {
    let signalTrue = 0;
    let signalTotal = 0;
    for (const o of main) {
      const v = o.flags[f.id];
      if (v === null || v === undefined) continue;
      signalTotal++;
      if (v) signalTrue++;
    }
    return {
      featureKey: f.id,
      featureLabel: f.label,
      signalRate: signalTotal ? (signalTrue / signalTotal) * 100 : null,
      metrics: horizons.map((h, hIdx) =>
        enhancedMetric(main, groups, hIdx, h, baseInterval, (o) => o.flags[f.id] ?? null),
      ),
    };
  });

  const stateSignalRates = new Map<string, number | null>(
    active.map((f) => {
      const valid = main
        .map((o) => o.stateFlags[f.id])
        .filter((v): v is boolean => v !== null && v !== undefined);
      return [f.id, valid.length ? (valid.filter(Boolean).length / valid.length) * 100 : null];
    }),
  );

  const features: FeatureStat[] = active.map((f) => {
    const m = featureHorizons.find((x) => x.featureKey === f.id)!.metrics[pIdx]!;
    return {
      id: f.id,
      label: f.label,
      signalCount: m.signalCount,
      noSignalCount: m.nonSignalCount,
      avgReturnOn: m.signalAvgReturn,
      avgReturnOff: m.nonSignalAvgReturn,
      edge: m.edge,
      hitRateOn: m.winRate,
      hitRateOff: m.nonSignalWinRate,
      tStat: m.tStat,
      medianReturnOn: m.signalMedianReturn,
      medianReturnOff: m.nonSignalMedianReturn,
      marketAdjustedEdge: m.marketAdjustedEdge,
      crossSectionalEdge: m.crossSectionalEdge,
      marketAdjustedCrossSectionalEdge: m.marketAdjustedCrossSectionalEdge,
      robustTStat: m.robustTStat,
      ci95Low: m.ci95Low,
      ci95High: m.ci95High,
    };
  });

  const bucketHorizons: BucketHorizonStat[] = [];
  for (const [lo, hi, label] of SCORE_EDGES) {
    const rows = main.filter((o) => o.score !== null && o.score >= lo && o.score < hi);
    horizons.forEach((h, hIdx) => {
      const xs = retsAt(rows, hIdx);
      bucketHorizons.push({
        label,
        horizon: h,
        count: xs.length,
        avgReturn: mean(xs),
        medianReturn: median(xs),
        hitRate: winRate(xs),
      });
    });
  }
  const buckets = bucketHorizons.filter((b) => b.horizon === horizons[pIdx]);

  const thresholdList = [
    ...new Set([
      ...normalizeList(params.entryThresholds, DEFAULT_ENTRY_THRESHOLDS),
      Math.round(params.entryScore),
    ]),
  ].sort((a, b) => a - b);
  const entryThresholds: EntryThresholdStat[] = [];
  for (const th of thresholdList) {
    const rows = main.filter((o) => o.score !== null && o.score >= th);
    horizons.forEach((h, hIdx) => {
      const xs = retsAt(rows, hIdx);
      const all = retsAt(main, hIdx);
      const wins = xs.filter((r) => r > 0);
      const losses = xs.filter((r) => r <= 0);
      const avg = mean(xs);
      const base = mean(all);
      entryThresholds.push({
        threshold: th,
        horizon: h,
        count: xs.length,
        avgReturn: avg,
        medianReturn: median(xs),
        winRate: winRate(xs),
        avgWin: mean(wins),
        avgLoss: mean(losses),
        edgeVsAll: avg !== null && base !== null ? avg - base : null,
        marketAdjustedAvgReturn: mean(excessAt(rows, hIdx)),
      });
    });
  }

  const scoreOnsets = buildScoreOnsets(perSymbol, main, horizons, retsAt, excessAt);
  const ranking = buildRankingAnalysis(groups, horizons, baseInterval);

  const entryRows = main.filter((o) => o.score !== null && o.score >= params.entryScore);
  const trades = retsAt(entryRows, pIdx);
  const wins = trades.filter((r) => r > 0);
  const losses = trades.filter((r) => r <= 0);
  const hit = winRate(trades);
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  const avgTrade = mean(trades);
  const baseline = mean(retsAt(main, pIdx));

  const sampleWith = (interval: number): Observation[] => {
    const stride = Math.max(1, Math.round(interval / baseInterval));
    const out: Observation[] = [];
    for (const obs of perSymbol) for (let i = 0; i < obs.length; i += stride) out.push(obs[i]!);
    return out;
  };
  const intervalSensitivity: IntervalSensitivityStat[] = intervals.map((interval) => {
    const rows = sampleWith(interval);
    const xs = retsAt(rows, pIdx);
    const entries = rows.filter((o) => o.score !== null && o.score >= params.entryScore);
    const entryRets = retsAt(entries, pIdx);
    const avg = mean(entryRets);
    const base = mean(xs);
    return {
      interval,
      horizon: horizons[pIdx]!,
      observations: xs.length,
      entrySignals: entryRets.length,
      avgReturn: avg,
      medianReturn: median(entryRets),
      winRate: winRate(entryRets),
      edge: avg !== null && base !== null ? avg - base : null,
      overlapRatio: horizons[pIdx]! / interval,
      marketAdjustedAvgReturn: mean(excessAt(entries, pIdx)),
    };
  });

  const extThresholds = normalizeList(params.extensionThresholds, DEFAULT_EXTENSION_THRESHOLDS);
  const extensionSensitivity: ThresholdSensitivityRow[] = extThresholds.map((th) => {
    const pick = (o: Observation) => (o.extension === null ? null : o.extension < th);
    const valid = main.map(pick).filter((v): v is boolean => v !== null);
    return {
      threshold: th,
      signalRate: valid.length ? (valid.filter(Boolean).length / valid.length) * 100 : null,
      lowDiscrimination:
        valid.length > 0 &&
        ((valid.filter(Boolean).length / valid.length) * 100 >= 95 ||
          (valid.filter(Boolean).length / valid.length) * 100 <= 5),
      metrics: horizons.map((h, hIdx) => enhancedMetric(main, groups, hIdx, h, baseInterval, pick)),
    };
  });

  const volThresholds = normalizeList(params.volumeThresholds, DEFAULT_VOLUME_THRESHOLDS);
  const volumeSensitivity: ThresholdSensitivityRow[] = volThresholds.map((th) => {
    const pick = (o: Observation) =>
      volumeSurgeFlag(o.volumeRatio, th, volumeMode, o.dayReturn, o.clv);
    const valid = main.map(pick).filter((v): v is boolean => v !== null);
    return {
      threshold: th,
      signalRate: valid.length ? (valid.filter(Boolean).length / valid.length) * 100 : null,
      lowDiscrimination:
        valid.length > 0 &&
        ((valid.filter(Boolean).length / valid.length) * 100 >= 95 ||
          (valid.filter(Boolean).length / valid.length) * 100 <= 5),
      metrics: horizons.map((h, hIdx) => enhancedMetric(main, groups, hIdx, h, baseInterval, pick)),
    };
  });

  const columns = active.map((f) =>
    main.map((o) => {
      const v = o.stateFlags[f.id];
      return v === null || v === undefined ? null : v ? 1 : 0;
    }),
  );
  const correlation: CorrelationMatrix = {
    ids: active.map((f) => f.id),
    labels: active.map((f) => f.label),
    matrix: columns.map((a, i) => columns.map((b, j) => (i === j ? 1 : pearson(a, b)))),
  };

  const distributions: FeatureDistribution[] = [];
  for (const f of active) {
    horizons.forEach((h, hIdx) => {
      const raw = splitReturns(main, hIdx, (o) => o.flags[f.id] ?? null, false);
      distributions.push({
        featureKey: f.id,
        featureLabel: f.label,
        horizon: h,
        signal: distribution(raw.on),
        nonSignal: distribution(raw.off),
      });
    });
  }

  const marketBreakdown = (["KOSPI", "KOSDAQ"] as BacktestMarket[]).flatMap((segment) =>
    breakdownFor(
      main.filter((o) => o.market === segment),
      active,
      pIdx,
      horizons[pIdx]!,
      baseInterval,
      segment,
    ),
  );
  const yearlyBreakdown = [...new Set(main.map((o) => o.year))]
    .sort()
    .flatMap((segment) =>
      breakdownFor(
        main.filter((o) => o.year === segment),
        active,
        pIdx,
        horizons[pIdx]!,
        baseInterval,
        segment,
      ),
    );
  const regimeBreakdown = (["RISK_ON", "NEUTRAL", "RISK_OFF"] as MarketRegime[]).flatMap(
    (segment) =>
      breakdownFor(
        main.filter((o) => o.regime === segment),
        active,
        pIdx,
        horizons[pIdx]!,
        baseInterval,
        segment,
      ),
  );
  const splitBreakdown = (["DEVELOPMENT", "VALIDATION", "OOS"] as SampleSplit[]).flatMap(
    (segment) =>
      breakdownFor(
        main.filter((o) => o.split === segment),
        active,
        pIdx,
        horizons[pIdx]!,
        baseInterval,
        segment,
      ),
  );

  const strongestByHorizon = horizons.map((h, hIdx) => {
    const ranked = featureHorizons
      .map((fh) => ({ fh, edge: fh.metrics[hIdx]?.edge }))
      .filter(
        (x): x is { fh: FeatureHorizonResult; edge: number } =>
          x.edge !== null && x.edge !== undefined,
      )
      .sort((a, b) => b.edge - a.edge);
    return {
      horizon: h,
      featureKey: ranked[0]?.fh.featureKey ?? "-",
      label: ranked[0]?.fh.featureLabel ?? "-",
      edge: ranked[0]?.edge ?? 0,
    };
  });
  const strongestAdjustedByHorizon = horizons.map((h, hIdx) => {
    const ranked = featureHorizons
      .map((fh) => ({ fh, edge: fh.metrics[hIdx]?.marketAdjustedCrossSectionalEdge }))
      .filter(
        (x): x is { fh: FeatureHorizonResult; edge: number } =>
          x.edge !== null && x.edge !== undefined,
      )
      .sort((a, b) => b.edge - a.edge);
    return {
      horizon: h,
      featureKey: ranked[0]?.fh.featureKey ?? "-",
      label: ranked[0]?.fh.featureLabel ?? "-",
      edge: ranked[0]?.edge ?? 0,
    };
  });

  let worstFeature: BacktestSummary["worstFeature"] = null;
  let highestTStat: BacktestSummary["highestTStat"] = null;
  for (const fh of featureHorizons) {
    for (const m of fh.metrics) {
      const e = m.marketAdjustedCrossSectionalEdge;
      if (e !== null && (worstFeature === null || e < worstFeature.edge))
        worstFeature = { featureKey: fh.featureKey, label: fh.featureLabel, edge: e, horizon: m.horizon };
      if (
        m.robustTStat !== null &&
        (highestTStat === null || Math.abs(m.robustTStat) > Math.abs(highestTStat.tStat))
      )
        highestTStat = {
          featureKey: fh.featureKey,
          label: fh.featureLabel,
          tStat: m.robustTStat,
          horizon: m.horizon,
        };
    }
  }

  const oosByFeature = new Map(
    splitBreakdown.filter((r) => r.segment === "OOS").map((r) => [r.featureKey, r]),
  );
  const summary: BacktestSummary = {
    strongestByHorizon,
    strongestAdjustedByHorizon,
    worstFeature,
    highestTStat,
    stableFeatures: featureHorizons
      .filter((fh) =>
        fh.metrics.every(
          (m) => m.marketAdjustedCrossSectionalEdge !== null && m.marketAdjustedCrossSectionalEdge > 0,
        ),
      )
      .map((fh) => ({ featureKey: fh.featureKey, label: fh.featureLabel })),
    lowDiscriminationFeatures: active
      .map((f) => ({ featureKey: f.id, label: f.label, signalRate: stateSignalRates.get(f.id) ?? null }))
      .filter(
        (f): f is { featureKey: string; label: string; signalRate: number } =>
          f.signalRate !== null && (f.signalRate >= 95 || f.signalRate <= 5),
      ),
    oosStableFeatures: active
      .filter((f) => (oosByFeature.get(f.id)?.marketAdjustedCrossSectionalEdge ?? -Infinity) > 0)
      .map((f) => ({ featureKey: f.id, label: f.label })),
  };

  const regimeCounts: Record<MarketRegime, number> = {
    RISK_ON: 0,
    NEUTRAL: 0,
    RISK_OFF: 0,
    UNKNOWN: 0,
  };
  for (const o of main) regimeCounts[o.regime]++;

  const config: BacktestConfigSnapshot = {
    features: active.map((f) => f.id),
    weights: Object.fromEntries(active.map((f) => [f.id, Math.max(0, params.weights[f.id] ?? f.defaultWeight)])),
    horizonDays: params.horizonDays,
    horizons,
    sampleEvery: baseInterval,
    entryScore: params.entryScore,
    entryThresholds: thresholdList,
    intervalCandidates: intervals,
    extensionLimit: params.extensionLimit,
    extensionThresholds: extThresholds,
    volumeSurgeRatio: params.volumeSurgeRatio,
    volumeThresholds: volThresholds,
    volumeMode,
    scoreOnsetThresholds: DEFAULT_SCORE_ONSET_THRESHOLDS,
    rankingHorizon: RANKING_HORIZON,
    topSelectionCount: TOP_SELECTION_COUNT,
    rankingQuantileBuckets: RANKING_QUANTILE_BUCKETS,
  };

  const notes: string[] = [
    "V5는 V4의 전체 관측치/시장조정/Signal Onset/HAC 검증 구조를 그대로 유지합니다.",
    "Score Threshold Onset은 직전 관측 점수가 threshold 미만이고 현재 점수가 threshold 이상인 최초 상향 돌파만 집계합니다.",
    "Rank IC와 Top 5/5분위/10분위 분석은 30D forward return을 사용하며, 같은 점수 tie의 Top 5 정렬은 종목코드 순으로 고정합니다.",
    "MA20 상승과 20일 수익률 양수는 피처에서 제외되며 백테스트 점수·Edge에 사용하지 않습니다.",
    "피처별 Edge는 직전 관측에서 미충족(false)이었다가 현재 충족(true)된 Signal Onset만 신호로 집계합니다. 복합점수는 상태 피처를 사용합니다.",
    "52주 신고가 피처는 현재 봉을 포함한 정확히 252거래일이 확보된 시점부터만 계산합니다.",
    "시장대비 초과수익률은 종목이 KOSPI면 KOSPI, KOSDAQ이면 KOSDAQ의 같은 진입일·청산일 수익률을 차감합니다.",
    "시장국면은 해당 시장 지수의 MA60·일목 구름·60일 수익률과 KOSPI 70%+KOSDAQ 30% 20일 실현변동성(<30)을 관측시점 데이터만으로 평가합니다.",
    "Robust t/95% CI는 날짜별 시장조정 cross-sectional edge에 Newey-West(HAC) 보정을 적용합니다.",
    "OOS는 관측일을 시간순 60% Development / 20% Validation / 20% OOS로 자동 분리합니다.",
  ];
  if (!horizons.includes(RANKING_HORIZON))
    notes.push(`Rank IC/Top 5/Quantile 분석을 표시하려면 Forward horizon에 ${RANKING_HORIZON}D를 포함하세요.`);
  if (requestedIntervals.some((v) => !intervals.includes(v)))
    notes.push(
      `장기 데이터 계산량 보호를 위해 메인 관측간격(${baseInterval}일)보다 짧거나 배수가 아닌 관측간격 민감도는 제외했습니다.`,
    );
  if (!benchmarks)
    notes.push("KOSPI/KOSDAQ 지수 시계열을 찾지 못해 시장조정 수익률과 시장국면 일부가 데이터 없음으로 처리됩니다.");
  if (maxHorizon > baseInterval)
    notes.push(
      `최대 보유기간 ${maxHorizon}일 / 관측간격 ${baseInterval}일로 가격구간 중첩이 존재합니다. naive t 대신 Robust t/95% CI를 우선 해석하세요.`,
    );

  const primaryBaseline = baselineByHorizon[pIdx];
  return {
    observations: retsAt(main, pIdx).length,
    symbolCount: usedSymbols,
    from: from || "-",
    to: to || "-",
    horizonDays: params.horizonDays,
    avgBars: usedSymbols ? Math.round(barTotal / usedSymbols) : 0,
    baselineAvgReturn: primaryBaseline?.avgReturn ?? null,
    baselineMarketReturn: primaryBaseline?.marketAvgReturn ?? null,
    baselineMarketAdjustedReturn: primaryBaseline?.marketAdjustedAvgReturn ?? null,
    config,
    features,
    buckets,
    strategy: {
      trades: trades.length,
      avgReturn: avgTrade,
      medianReturn: median(trades),
      hitRate: hit,
      avgWin,
      avgLoss,
      expectancy:
        hit !== null && avgWin !== null && avgLoss !== null
          ? (hit / 100) * avgWin + (1 - hit / 100) * avgLoss
          : avgTrade,
      excessVsBaseline: avgTrade !== null && baseline !== null ? avgTrade - baseline : null,
      marketAdjustedAvgReturn: mean(excessAt(entryRows, pIdx)),
    },
    notes,
    horizons,
    baselineByHorizon,
    featureHorizons,
    bucketHorizons,
    entryThresholds,
    scoreOnsets,
    rankIcByDate: ranking.rankIcByDate,
    rankIcSummary: ranking.rankIcSummary,
    topSelection: ranking.topSelection,
    quantileSpreads: ranking.quantileSpreads,
    intervalSensitivity,
    extensionSensitivity,
    volumeSensitivity,
    correlation,
    distributions,
    summary,
    overlapRatio: params.horizonDays / baseInterval,
    baseInterval,
    volumeMode,
    marketBreakdown,
    yearlyBreakdown,
    regimeBreakdown,
    splitBreakdown,
    splitBoundaries: { developmentEnd, validationEnd, oosStart },
    regimeCounts,
  };
}
