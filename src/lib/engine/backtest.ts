// 피처 영향도 백테스트 엔진 (순수 함수).
// 토스증권 Open API로 받을 수 있는 값(일봉 OHLCV + 투자자 순매수)만 사용한다.
// 관측 시점 t의 피처는 t까지의 데이터만으로 계산하고(look-ahead 없음),
// 미래 종가는 forward return 계산에만 사용한다.
import { computeIndicators, periodReturn, type IndicatorSnapshot } from "./indicators";
import {
  DEFAULT_SCORING_CONFIG,
  technicalFlagsV3,
  type ScoringConfig,
} from "./scoring";
import type { DailyPrice } from "./types";

export interface FeatureDef {
  id: string;
  label: string;
  description: string;
  defaultWeight: number;
}

export const BACKTEST_FEATURES: FeatureDef[] = [
  {
    id: "ICH_ABOVE_CLOUD",
    label: "일목 구름 상단 위",
    description: "종가가 선행스팬(구름) 상단보다 높은 상태",
    defaultWeight: 2,
  },
  {
    id: "ICH_TENKAN_KIJUN",
    label: "전환선 > 기준선",
    description: "Momentum Confirmation ① (Primary) — 1.5점 ÷ 3",
    defaultWeight: 0.5,
  },
  {
    id: "BB_BREAKOUT",
    label: "볼린저 상단 돌파",
    description: "종가가 20일 볼린저 상단을 돌파 (Head Fake 시 미충족)",
    defaultWeight: 1,
  },
  {
    id: "MA_ALIGNED",
    label: "이동평균 정배열",
    description: "MA20 > MA60 > MA120",
    defaultWeight: 2,
  },
  {
    id: "MA20_SLOPE_UP",
    label: "MA20 상승",
    description: "Momentum Confirmation ② — 1.5점 ÷ 3",
    defaultWeight: 0.5,
  },
  {
    id: "VOLUME_SURGE",
    label: "고가 마감 거래량",
    description: "거래량 비율 기준 + 판정 방식(기본 고가 마감, CLV ≥ 0.7)",
    defaultWeight: 0.5,
  },
  {
    id: "NEAR_52W_HIGH",
    label: "52주 신고가 근접",
    description: "52주 최고가 대비 -10% 이내 (Priority 2점)",
    defaultWeight: 2,
  },
  {
    id: "RS_POSITIVE",
    label: "20일 수익률 양수",
    description: "Momentum Confirmation ③ — 1.5점 ÷ 3",
    defaultWeight: 0.5,
  },
  {
    id: "FOREIGN_NET_POSITIVE",
    label: "외국인 20일 순매수",
    description: "최근 20거래일 외국인 누적 순매수가 양수 (Priority 2점)",
    defaultWeight: 2,
  },
];

/** 거래량 급증 피처의 판정 방식 */
export type VolumeSurgeMode = "SIMPLE" | "UP_DAY" | "HIGH_CLOSE";

export const VOLUME_SURGE_MODES: Array<{ id: VolumeSurgeMode; label: string; note: string }> = [
  { id: "SIMPLE", label: "단순 거래량", note: "20일 평균 대비 비율만 확인" },
  { id: "UP_DAY", label: "상승 거래량", note: "거래량 조건 + 당일 상승 마감" },
  {
    id: "HIGH_CLOSE",
    label: "고가 마감 거래량",
    note: "거래량 조건 + (종가-저가)/(고가-저가) ≥ 0.7",
  },
];

export const DEFAULT_HORIZONS = [5, 10, 20, 30, 40, 60];
export const DEFAULT_INTERVAL_CANDIDATES = [1, 3, 5, 10, 20];
export const DEFAULT_ENTRY_THRESHOLDS = [40, 50, 60, 70, 80];
export const DEFAULT_EXTENSION_THRESHOLDS = [5, 10, 15, 20, 25, 30];
export const DEFAULT_VOLUME_THRESHOLDS = [120, 130, 150, 180, 200, 250];

export interface BacktestParams {
  /** 보유(전방 수익률 측정) 기간, 거래일 */
  horizonDays: number;
  /** 관측 샘플링 간격, 거래일 */
  sampleEvery: number;
  /** 거래량 급증 판정 기준 (%) */
  volumeSurgeRatio: number;
  /** 과열 이격 판정 기준 (%) */
  extensionLimit: number;
  /** 복합 점수 진입 기준 (0~100) */
  entryScore: number;
  /** 사용할 피처 id 목록 */
  features: string[];
  /** 피처별 가중치 */
  weights: Record<string, number>;
  /** 동시에 분석할 forward horizon 목록 (거래일) */
  horizons?: number[];
  /** 거래량 급증 피처 판정 방식 */
  volumeMode?: VolumeSurgeMode;
  /** 관측 간격 민감도 테스트 값 */
  intervalCandidates?: number[];
  /** 진입 점수 임계값 비교 목록 */
  entryThresholds?: number[];
  /** 과열 이격 민감도 테스트 값 (%) */
  extensionThresholds?: number[];
  /** 거래량 급증 민감도 테스트 값 (%) */
  volumeThresholds?: number[];
}

/** V3 composite score에 포함되지 않는 참고지표 피처 (분석용으로만 유지) */
export const INFORMATION_ONLY_FEATURES = ["BB_SQUEEZE", "NOT_OVEREXTENDED"];

export const DEFAULT_BACKTEST_PARAMS: BacktestParams = {
  horizonDays: 30,
  sampleEvery: 5,
  volumeSurgeRatio: 150,
  extensionLimit: 15,
  entryScore: 60,
  features: BACKTEST_FEATURES.filter((f) => !INFORMATION_ONLY_FEATURES.includes(f.id)).map(
    (f) => f.id,
  ),
  weights: Object.fromEntries(BACKTEST_FEATURES.map((f) => [f.id, f.defaultWeight])),
  horizons: DEFAULT_HORIZONS,
  volumeMode: "HIGH_CLOSE",
  intervalCandidates: DEFAULT_INTERVAL_CANDIDATES,
  entryThresholds: DEFAULT_ENTRY_THRESHOLDS,
  extensionThresholds: DEFAULT_EXTENSION_THRESHOLDS,
  volumeThresholds: DEFAULT_VOLUME_THRESHOLDS,
};

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
  /** 확장: 중앙값 */
  medianReturnOn?: number | null;
  medianReturnOff?: number | null;
}

export interface BucketStat {
  label: string;
  count: number;
  avgReturn: number | null;
  hitRate: number | null;
  medianReturn?: number | null;
}

/** 특정 피처 × 특정 horizon 성과 */
export interface HorizonMetric {
  horizon: number;
  signalCount: number;
  nonSignalCount: number;
  signalAvgReturn: number | null;
  signalMedianReturn: number | null;
  nonSignalAvgReturn: number | null;
  nonSignalMedianReturn: number | null;
  edge: number | null;
  winRate: number | null;
  nonSignalWinRate: number | null;
  tStat: number | null;
  standardError: number | null;
  edgePerDay: number | null;
}

export interface FeatureHorizonResult {
  featureKey: string;
  featureLabel: string;
  /** 신호 비율(%) — 변별력 판단용 */
  signalRate: number | null;
  metrics: HorizonMetric[];
}

export interface BucketHorizonStat {
  label: string;
  horizon: number;
  count: number;
  avgReturn: number | null;
  medianReturn: number | null;
  hitRate: number | null;
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
}

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
}

export interface ThresholdSensitivityRow {
  threshold: number;
  signalRate: number | null;
  lowDiscrimination: boolean;
  metrics: HorizonMetric[];
}

export interface CorrelationMatrix {
  ids: string[];
  labels: string[];
  matrix: Array<Array<number | null>>;
}

export interface DistributionStat {
  count: number;
  mean: number | null;
  p5: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p95: number | null;
}

export interface FeatureDistribution {
  featureKey: string;
  featureLabel: string;
  horizon: number;
  signal: DistributionStat;
  nonSignal: DistributionStat;
}

export interface BacktestSummary {
  strongestByHorizon: Array<{ horizon: number; featureKey: string; label: string; edge: number }>;
  worstFeature: { featureKey: string; label: string; edge: number; horizon: number } | null;
  highestTStat: { featureKey: string; label: string; tStat: number; horizon: number } | null;
  stableFeatures: Array<{ featureKey: string; label: string }>;
  lowDiscriminationFeatures: Array<{ featureKey: string; label: string; signalRate: number }>;
}

export interface BacktestResult {
  observations: number;
  symbolCount: number;
  from: string;
  to: string;
  horizonDays: number;
  avgBars: number;
  baselineAvgReturn: number | null;
  features: FeatureStat[];
  buckets: BucketStat[];
  strategy: {
    trades: number;
    avgReturn: number | null;
    hitRate: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    expectancy: number | null;
    cumulativeReturn: number | null;
    excessVsBaseline: number | null;
    medianReturn?: number | null;
  };
  notes: string[];
  // ---- 확장 결과 (기존 필드는 그대로 유지) ----
  horizons: number[];
  baselineByHorizon: Array<{ horizon: number; count: number; avgReturn: number | null; medianReturn: number | null }>;
  featureHorizons: FeatureHorizonResult[];
  bucketHorizons: BucketHorizonStat[];
  entryThresholds: EntryThresholdStat[];
  intervalSensitivity: IntervalSensitivityStat[];
  extensionSensitivity: ThresholdSensitivityRow[];
  volumeSensitivity: ThresholdSensitivityRow[];
  correlation: CorrelationMatrix;
  distributions: FeatureDistribution[];
  summary: BacktestSummary;
  /** holdingDays / observationInterval */
  overlapRatio: number;
  /** 관측 그리드 간격 (민감도 분석의 최소 단위) */
  baseInterval: number;
  volumeMode: VolumeSurgeMode;
}

/** (close - low) / (high - low). high == low면 null */
export function closeLocationValue(bar: DailyPrice): number | null {
  const range = bar.high - bar.low;
  if (!(range > 0)) return null;
  return (bar.close - bar.low) / range;
}

/** 거래량 급증 판정 (모드별). 데이터 없으면 null */
export function volumeSurgeFlag(
  volumeRatio: number | null,
  threshold: number,
  mode: VolumeSurgeMode,
  dayReturn: number | null,
  clv: number | null,
): boolean | null {
  if (volumeRatio === null) return null;
  const base = volumeRatio >= threshold;
  if (mode === "SIMPLE") return base;
  if (mode === "UP_DAY") {
    if (dayReturn === null) return null;
    return base && dayReturn > 0;
  }
  if (clv === null) return null;
  return base && clv >= 0.7;
}

/**
 * 관측 시점 피처 판정. Technical 피처는 live screener와 동일한 technicalFlagsV3를 사용하므로
 * 백테스트 composite score와 스크리너 기술점수는 같은 산식(source of truth)을 공유한다.
 */
export function evaluateFeatures(
  snap: IndicatorSnapshot,
  params: BacktestParams,
  bar: DailyPrice,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
): Record<string, boolean | null> {
  void bar;
  const v3 = technicalFlagsV3(snap, cfg);
  return {
    ICH_ABOVE_CLOUD: v3.cloudAbove,
    ICH_TENKAN_KIJUN: v3.tenkanAboveKijun,
    BB_BREAKOUT: v3.bbBreakout,
    MA_ALIGNED: v3.maAligned,
    MA20_SLOPE_UP: v3.ma20SlopeUp,
    VOLUME_SURGE: volumeSurgeFlag(
      snap.volumeRatio20,
      params.volumeSurgeRatio,
      params.volumeMode ?? "HIGH_CLOSE",
      snap.dayReturn,
      snap.closeLocationValue ?? closeLocationValue(bar),
    ),
    NEAR_52W_HIGH:
      snap.distanceFrom52wHigh === null
        ? null
        : snap.distanceFrom52wHigh >= cfg.priority.nearHighThresholdPercent,
    RS_POSITIVE: v3.return20Positive,
    FOREIGN_NET_POSITIVE: snap.foreignNet20d === null ? null : snap.foreignNet20d > 0,
  };
  };
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: number[]): number | null => {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
};

/** 선형 보간 분위수 (0~100) */
export function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const pos = ((sorted.length - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export const median = (xs: number[]): number | null => quantile(xs, 50);

const winRate = (xs: number[]): number | null =>
  xs.length === 0 ? null : (xs.filter((r) => r > 0).length / xs.length) * 100;

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

/** signal / non-signal forward return 배열로부터 horizon 성과지표를 만든다. */
export function horizonMetric(on: number[], off: number[], horizon: number): HorizonMetric {
  const ma = mean(on);
  const mb = mean(off);
  const va = variance(on);
  const vb = variance(off);
  const se =
    va !== null && vb !== null && on.length > 1 && off.length > 1
      ? Math.sqrt(va / on.length + vb / off.length)
      : null;
  const edge = ma !== null && mb !== null ? ma - mb : null;
  return {
    horizon,
    signalCount: on.length,
    nonSignalCount: off.length,
    signalAvgReturn: ma,
    signalMedianReturn: median(on),
    nonSignalAvgReturn: mb,
    nonSignalMedianReturn: median(off),
    edge,
    winRate: winRate(on),
    nonSignalWinRate: winRate(off),
    tStat: edge !== null && se !== null && se > 0 ? edge / se : null,
    standardError: se,
    edgePerDay: edge !== null && horizon > 0 ? edge / horizon : null,
  };
}

/** 0/1로 변환한 boolean 피처 간 Pearson 상관계수 (양쪽 모두 값이 있는 관측치만) */
export function pearson(a: Array<number | null>, b: Array<number | null>): number | null {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === null || x === undefined || y === null || y === undefined) continue;
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  if (n < 3) return null;
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  if (!(den > 0)) return null;
  return num / den;
}

export interface BacktestInputSeries {
  symbol: string;
  name: string;
  bars: DailyPrice[];
}

const SCORE_EDGES: Array<[number, number, string]> = [
  [0, 20, "0~20점"],
  [20, 40, "20~40점"],
  [40, 60, "40~60점"],
  [60, 80, "60~80점"],
  [80, 100.001, "80~100점"],
];

/** 관측 시점 하나의 스냅샷 — 지표는 한 번만 계산하고 horizon별 미래수익률을 연결한다. */
interface Observation {
  gridIndex: number;
  flags: Record<string, boolean | null>;
  score: number | null;
  /** horizon 순서대로의 forward return (%) — 미래 봉이 없으면 null */
  rets: Array<number | null>;
  volumeRatio: number | null;
  extension: number | null;
  dayReturn: number | null;
  clv: number | null;
}

const gcd2 = (a: number, b: number): number => (b === 0 ? a : gcd2(b, a % b));
const MAX_OBSERVATIONS = 60000;

function normalizeList(values: number[] | undefined, fallback: number[]): number[] {
  const list = (values && values.length ? values : fallback)
    .map((v) => Math.round(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  return [...new Set(list)].sort((a, b) => a - b);
}

/**
 * 각 종목의 일봉을 훑으면서 (관측일 → 전방 수익률) 표본을 만들고,
 * 피처별 신호 유무에 따른 평균 수익률 차이(edge)와 복합 점수 구간별 성과를 계산한다.
 * 지표 스냅샷은 관측 시점마다 한 번만 계산하며, horizon·임계값 민감도 분석은
 * 같은 스냅샷을 재사용한다.
 */
export function runBacktest(
  series: BacktestInputSeries[],
  paramsInput: BacktestParams,
): BacktestResult {
  const params: BacktestParams = {
    ...paramsInput,
    horizonDays: Math.max(1, Math.min(120, Math.round(paramsInput.horizonDays))),
    sampleEvery: Math.max(1, Math.min(20, Math.round(paramsInput.sampleEvery))),
  };
  const volumeMode = params.volumeMode ?? "HIGH_CLOSE";
  const active = BACKTEST_FEATURES.filter((f) => params.features.includes(f.id));
  const intervals = normalizeList(params.intervalCandidates, DEFAULT_INTERVAL_CANDIDATES);
  const entryThresholds = normalizeList(params.entryThresholds, DEFAULT_ENTRY_THRESHOLDS);
  const extThresholds = normalizeList(params.extensionThresholds, DEFAULT_EXTENSION_THRESHOLDS);
  const volThresholds = normalizeList(params.volumeThresholds, DEFAULT_VOLUME_THRESHOLDS);
  const horizons = normalizeList(
    [...(params.horizons ?? DEFAULT_HORIZONS), params.horizonDays],
    [...DEFAULT_HORIZONS, params.horizonDays],
  );
  const primaryIndex = horizons.indexOf(params.horizonDays);
  const minHorizon = horizons[0]!;
  const maxHorizon = horizons[horizons.length - 1]!;

  // 관측 그리드: 요청된 모든 간격의 최대공약수를 기본 단위로 삼아 스냅샷을 1회만 계산한다.
  let baseInterval = [params.sampleEvery, ...intervals].reduce((a, b) => gcd2(a, b));
  const usableBars = series.reduce(
    (acc, s) => acc + Math.max(0, s.bars.length - 120 - minHorizon),
    0,
  );
  const capNotes: string[] = [];
  if (usableBars / baseInterval > MAX_OBSERVATIONS) {
    const scaled = Math.ceil(usableBars / MAX_OBSERVATIONS);
    if (scaled > baseInterval) {
      baseInterval = scaled;
      capNotes.push(
        `표본이 매우 커서 관측 그리드를 ${baseInterval}거래일로 넓혔습니다(계산 시간 보호). 관측간격 민감도는 이 그리드의 배수로 근사됩니다.`,
      );
    }
  }

  const perSymbol: Observation[][] = [];
  let from = "";
  let to = "";
  let barTotal = 0;
  let usedSymbols = 0;

  for (const s of series) {
    const bars = s.bars;
    if (bars.length < 130) continue;
    usedSymbols++;
    barTotal += bars.length;
    if (!from || bars[0]!.tradeDate < from) from = bars[0]!.tradeDate;
    const lastDate = bars[bars.length - 1]!.tradeDate;
    if (lastDate > to) to = lastDate;

    const obs: Observation[] = [];
    for (let i = 120; i + minHorizon < bars.length; i += baseInterval) {
      const entry = bars[i]!.close;
      if (!(entry > 0)) continue;
      const snap = computeIndicators(bars, i);
      const flags = evaluateFeatures(snap, params, bars[i]!);

      let weighted = 0;
      let available = 0;
      for (const f of active) {
        const v = flags[f.id];
        if (v === null || v === undefined) continue;
        const w = Math.max(0, params.weights[f.id] ?? f.defaultWeight);
        available += w;
        if (v) weighted += w;
      }

      const rets = horizons.map((h) => {
        const exit = bars[i + h]?.close;
        if (exit === undefined || !(exit > 0)) return null;
        return (exit / entry - 1) * 100;
      });

      obs.push({
        gridIndex: obs.length,
        flags,
        score: available > 0 ? (weighted / available) * 100 : null,
        rets,
        volumeRatio: snap.volumeRatio20,
        extension: snap.extensionFromMa20,
        dayReturn: snap.dayReturn,
        clv: closeLocationValue(bars[i]!),
      });
    }
    perSymbol.push(obs);
  }

  const strideFor = (interval: number) => Math.max(1, Math.round(interval / baseInterval));
  const sampleWith = (interval: number): Observation[] => {
    const stride = strideFor(interval);
    const out: Observation[] = [];
    for (const obs of perSymbol) for (let i = 0; i < obs.length; i += stride) out.push(obs[i]!);
    return out;
  };

  const main = sampleWith(params.sampleEvery);
  const retsAt = (rows: Observation[], hIdx: number): number[] =>
    rows.map((o) => o.rets[hIdx]).filter((r): r is number => r !== null && r !== undefined);

  // ---- horizon별 baseline ----
  const baselineByHorizon = horizons.map((h, hIdx) => {
    const xs = retsAt(main, hIdx);
    return { horizon: h, count: xs.length, avgReturn: mean(xs), medianReturn: median(xs) };
  });

  // ---- 피처 × horizon ----
  const split = (
    rows: Observation[],
    hIdx: number,
    pick: (o: Observation) => boolean | null,
  ): { on: number[]; off: number[]; withFlag: number } => {
    const on: number[] = [];
    const off: number[] = [];
    let withFlag = 0;
    for (const o of rows) {
      const v = pick(o);
      if (v === null || v === undefined) continue;
      withFlag++;
      const r = o.rets[hIdx];
      if (r === null || r === undefined) continue;
      (v ? on : off).push(r);
    }
    return { on, off, withFlag };
  };

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
      metrics: horizons.map((h, hIdx) => {
        const { on, off } = split(main, hIdx, (o) => o.flags[f.id] ?? null);
        return horizonMetric(on, off, h);
      }),
    };
  });

  // ---- 기존(단일 보유기간) 피처 표 ----
  const pIdx = primaryIndex >= 0 ? primaryIndex : 0;
  const features: FeatureStat[] = active.map((f) => {
    const fh = featureHorizons.find((x) => x.featureKey === f.id)!;
    const m = fh.metrics[pIdx]!;
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
    };
  });

  // ---- 점수 구간 × horizon ----
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
  const buckets: BucketStat[] = bucketHorizons
    .filter((b) => b.horizon === horizons[pIdx])
    .map((b) => ({
      label: b.label,
      count: b.count,
      avgReturn: b.avgReturn,
      hitRate: b.hitRate,
      medianReturn: b.medianReturn,
    }));

  // ---- 진입 점수 임계값 × horizon ----
  const thresholdList = [...new Set([...entryThresholds, Math.round(params.entryScore)])].sort(
    (a, b) => a - b,
  );
  const entryThresholdStats: EntryThresholdStat[] = [];
  for (const th of thresholdList) {
    const rows = main.filter((o) => o.score !== null && o.score >= th);
    horizons.forEach((h, hIdx) => {
      const xs = retsAt(rows, hIdx);
      const all = retsAt(main, hIdx);
      const wins = xs.filter((r) => r > 0);
      const losses = xs.filter((r) => r <= 0);
      const avg = mean(xs);
      const base = mean(all);
      entryThresholdStats.push({
        threshold: th,
        horizon: h,
        count: xs.length,
        avgReturn: avg,
        medianReturn: median(xs),
        winRate: winRate(xs),
        avgWin: mean(wins),
        avgLoss: mean(losses),
        edgeVsAll: avg !== null && base !== null ? avg - base : null,
      });
    });
  }

  // ---- 전략(진입 기준 점수) 요약: 기존 필드 ----
  const trades = retsAt(
    main.filter((o) => o.score !== null && o.score >= params.entryScore),
    pIdx,
  );
  const wins = trades.filter((r) => r > 0);
  const losses = trades.filter((r) => r <= 0);
  const hitRate = winRate(trades);
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  const avgTrade = mean(trades);
  const all = retsAt(main, pIdx);
  const baseline = mean(all);
  const cumulative = trades.length
    ? (trades.reduce((acc, r) => acc * (1 + r / 100), 1) - 1) * 100
    : null;

  // ---- 관측 간격 민감도 (기준 horizon) ----
  const intervalSensitivity: IntervalSensitivityStat[] = intervals.map((interval) => {
    const rows = sampleWith(interval);
    const xs = retsAt(rows, pIdx);
    const entryRows = retsAt(
      rows.filter((o) => o.score !== null && o.score >= params.entryScore),
      pIdx,
    );
    const avg = mean(entryRows);
    const base = mean(xs);
    return {
      interval,
      horizon: horizons[pIdx]!,
      observations: xs.length,
      entrySignals: entryRows.length,
      avgReturn: avg,
      medianReturn: median(entryRows),
      winRate: winRate(entryRows),
      edge: avg !== null && base !== null ? avg - base : null,
      overlapRatio: horizons[pIdx]! / interval,
    };
  });

  // ---- 과열 이격 민감도 ----
  const extensionSensitivity: ThresholdSensitivityRow[] = extThresholds.map((th) => {
    const pick = (o: Observation) => (o.extension === null ? null : o.extension < th);
    let t = 0;
    let n = 0;
    for (const o of main) {
      const v = pick(o);
      if (v === null) continue;
      n++;
      if (v) t++;
    }
    const rate = n ? (t / n) * 100 : null;
    return {
      threshold: th,
      signalRate: rate,
      lowDiscrimination: rate !== null && (rate >= 95 || rate <= 5),
      metrics: horizons.map((h, hIdx) => {
        const { on, off } = split(main, hIdx, pick);
        return horizonMetric(on, off, h);
      }),
    };
  });

  // ---- 거래량 급증 민감도 (선택한 모드 기준) ----
  const volumeSensitivity: ThresholdSensitivityRow[] = volThresholds.map((th) => {
    const pick = (o: Observation) =>
      volumeSurgeFlag(o.volumeRatio, th, volumeMode, o.dayReturn, o.clv);
    let t = 0;
    let n = 0;
    for (const o of main) {
      const v = pick(o);
      if (v === null) continue;
      n++;
      if (v) t++;
    }
    const rate = n ? (t / n) * 100 : null;
    return {
      threshold: th,
      signalRate: rate,
      lowDiscrimination: rate !== null && (rate >= 95 || rate <= 5),
      metrics: horizons.map((h, hIdx) => {
        const { on, off } = split(main, hIdx, pick);
        return horizonMetric(on, off, h);
      }),
    };
  });

  // ---- 피처 상관행렬 ----
  const columns = active.map((f) => main.map((o) => {
    const v = o.flags[f.id];
    return v === null || v === undefined ? null : v ? 1 : 0;
  }));
  const correlation: CorrelationMatrix = {
    ids: active.map((f) => f.id),
    labels: active.map((f) => f.label),
    matrix: columns.map((a, i) => columns.map((b, j) => (i === j ? 1 : pearson(a, b)))),
  };

  // ---- 분포 ----
  const distributions: FeatureDistribution[] = [];
  for (const f of active) {
    horizons.forEach((h, hIdx) => {
      const { on, off } = split(main, hIdx, (o) => o.flags[f.id] ?? null);
      distributions.push({
        featureKey: f.id,
        featureLabel: f.label,
        horizon: h,
        signal: distribution(on),
        nonSignal: distribution(off),
      });
    });
  }

  // ---- 요약 카드 ----
  const strongestByHorizon = horizons.map((h, hIdx) => {
    let best: { featureKey: string; label: string; edge: number } | null = null;
    for (const fh of featureHorizons) {
      const e = fh.metrics[hIdx]?.edge;
      if (e === null || e === undefined) continue;
      if (!best || e > best.edge)
        best = { featureKey: fh.featureKey, label: fh.featureLabel, edge: e };
    }
    return { horizon: h, featureKey: best?.featureKey ?? "-", label: best?.label ?? "-", edge: best?.edge ?? 0 };
  });
  let worstFeature: BacktestSummary["worstFeature"] = null;
  let highestTStat: BacktestSummary["highestTStat"] = null;
  for (const fh of featureHorizons) {
    fh.metrics.forEach((m) => {
      if (m.edge !== null && (worstFeature === null || m.edge < worstFeature.edge))
        worstFeature = {
          featureKey: fh.featureKey,
          label: fh.featureLabel,
          edge: m.edge,
          horizon: m.horizon,
        };
      if (
        m.tStat !== null &&
        (highestTStat === null || Math.abs(m.tStat) > Math.abs(highestTStat.tStat))
      )
        highestTStat = {
          featureKey: fh.featureKey,
          label: fh.featureLabel,
          tStat: m.tStat,
          horizon: m.horizon,
        };
    });
  }
  const summary: BacktestSummary = {
    strongestByHorizon,
    worstFeature,
    highestTStat,
    stableFeatures: featureHorizons
      .filter((fh) => fh.metrics.every((m) => m.edge !== null && m.edge > 0))
      .map((fh) => ({ featureKey: fh.featureKey, label: fh.featureLabel })),
    lowDiscriminationFeatures: featureHorizons
      .filter((fh) => fh.signalRate !== null && (fh.signalRate >= 95 || fh.signalRate <= 5))
      .map((fh) => ({ featureKey: fh.featureKey, label: fh.featureLabel, signalRate: fh.signalRate! })),
  };

  const notes: string[] = [...capNotes];
  if (maxHorizon > params.sampleEvery)
    notes.push(
      `보유기간(최대 ${maxHorizon}일)이 관측간격(${params.sampleEvery}일)보다 길어 동일한 가격 구간이 최대 약 ${Math.round(maxHorizon / params.sampleEvery)}개 관측치에 중복 반영될 수 있습니다. t값은 중첩을 고려하지 않은 naive 값입니다.`,
    );

  return {
    observations: all.length,
    symbolCount: usedSymbols,
    from: from || "-",
    to: to || "-",
    horizonDays: params.horizonDays,
    avgBars: usedSymbols ? Math.round(barTotal / usedSymbols) : 0,
    baselineAvgReturn: baseline,
    features,
    buckets,
    strategy: {
      trades: trades.length,
      avgReturn: avgTrade,
      hitRate,
      avgWin,
      avgLoss,
      expectancy:
        hitRate !== null && avgWin !== null && avgLoss !== null
          ? (hitRate / 100) * avgWin + (1 - hitRate / 100) * avgLoss
          : avgTrade,
      cumulativeReturn: cumulative,
      excessVsBaseline: avgTrade !== null && baseline !== null ? avgTrade - baseline : null,
      medianReturn: median(trades),
    },
    notes,
    horizons,
    baselineByHorizon,
    featureHorizons,
    bucketHorizons,
    entryThresholds: entryThresholdStats,
    intervalSensitivity,
    extensionSensitivity,
    volumeSensitivity,
    correlation,
    distributions,
    summary,
    overlapRatio: params.horizonDays / params.sampleEvery,
    baseInterval,
    volumeMode,
  };
}

/** 벤치마크(지수) 전방 수익률 — 표본 편향 확인용 */
export function benchmarkForwardReturn(bars: DailyPrice[], horizonDays: number): number | null {
  const closes = bars.map((b) => b.close);
  const r = periodReturn(closes, closes.length - 1, horizonDays);
  return r === null ? null : r * 100;
}
