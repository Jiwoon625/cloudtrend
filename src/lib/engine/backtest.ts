// 피처 영향도 백테스트 엔진 (순수 함수).
// 토스증권 Open API로 받을 수 있는 값(일봉 OHLCV + 투자자 순매수)만 사용한다.
import { computeIndicators, periodReturn, type IndicatorSnapshot } from "./indicators";
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
    description: "단기 전환선이 기준선 위 (일목 보조 조건)",
    defaultWeight: 1,
  },
  {
    id: "BB_BREAKOUT",
    label: "볼린저 상단 돌파",
    description: "종가가 20일 볼린저 상단을 돌파",
    defaultWeight: 2,
  },
  {
    id: "BB_SQUEEZE",
    label: "볼린저 스퀴즈",
    description: "밴드폭이 직전 구간 대비 축소(에너지 응축)",
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
    description: "20일선 기울기가 양수",
    defaultWeight: 1,
  },
  {
    id: "VOLUME_SURGE",
    label: "거래량 급증",
    description: "20일 평균 거래량 대비 설정 비율 이상",
    defaultWeight: 1,
  },
  {
    id: "NEAR_52W_HIGH",
    label: "52주 신고가 근접",
    description: "52주 최고가 대비 -10% 이내",
    defaultWeight: 1,
  },
  {
    id: "RS_POSITIVE",
    label: "20일 수익률 양수",
    description: "최근 20거래일 수익률이 0보다 큼",
    defaultWeight: 1,
  },
  {
    id: "FOREIGN_NET_POSITIVE",
    label: "외국인 20일 순매수",
    description: "최근 20거래일 외국인 누적 순매수가 양수 (데이터 있는 종목만)",
    defaultWeight: 1,
  },
  {
    id: "NOT_OVEREXTENDED",
    label: "과열 이격 아님",
    description: "20일선 이격도가 설정값 미만",
    defaultWeight: 1,
  },
];

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
}

export const DEFAULT_BACKTEST_PARAMS: BacktestParams = {
  horizonDays: 20,
  sampleEvery: 3,
  volumeSurgeRatio: 150,
  extensionLimit: 15,
  entryScore: 60,
  features: BACKTEST_FEATURES.map((f) => f.id),
  weights: Object.fromEntries(BACKTEST_FEATURES.map((f) => [f.id, f.defaultWeight])),
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
}

export interface BucketStat {
  label: string;
  count: number;
  avgReturn: number | null;
  hitRate: number | null;
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
  };
  notes: string[];
}

function evaluateFeatures(
  snap: IndicatorSnapshot,
  params: BacktestParams,
): Record<string, boolean | null> {
  const ich = snap.ichimoku;
  const bb = snap.bollinger;
  return {
    ICH_ABOVE_CLOUD: ich.cloudTop === null ? null : snap.close > ich.cloudTop,
    ICH_TENKAN_KIJUN: ich.tenkanAboveKijun,
    BB_BREAKOUT: bb.bb === null ? null : bb.bbBreakout === true,
    BB_SQUEEZE:
      bb.bb === null ? null : bb.bbSqueezePrior === true || bb.bbSqueezeAbsolute === true,
    MA_ALIGNED: snap.maAligned,
    MA20_SLOPE_UP: snap.ma20Slope === null ? null : snap.ma20Slope > 0,
    VOLUME_SURGE:
      snap.volumeRatio20 === null ? null : snap.volumeRatio20 >= params.volumeSurgeRatio,
    NEAR_52W_HIGH:
      snap.distanceFrom52wHigh === null ? null : snap.distanceFrom52wHigh >= -10,
    RS_POSITIVE: snap.return20 === null ? null : snap.return20 > 0,
    FOREIGN_NET_POSITIVE: snap.foreignNet20d === null ? null : snap.foreignNet20d > 0,
    NOT_OVEREXTENDED:
      snap.extensionFromMa20 === null ? null : snap.extensionFromMa20 < params.extensionLimit,
  };
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: number[]): number | null => {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
};

export interface BacktestInputSeries {
  symbol: string;
  name: string;
  bars: DailyPrice[];
}

/**
 * 각 종목의 일봉을 훑으면서 (관측일 → 전방 수익률) 표본을 만들고,
 * 피처별 신호 유무에 따른 평균 수익률 차이(edge)와 복합 점수 구간별 성과를 계산한다.
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
  const active = BACKTEST_FEATURES.filter((f) => params.features.includes(f.id));
  const on = new Map<string, number[]>(active.map((f) => [f.id, []]));
  const off = new Map<string, number[]>(active.map((f) => [f.id, []]));
  const all: number[] = [];
  const scored: Array<{ score: number; ret: number }> = [];

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

    for (let i = 120; i + params.horizonDays < bars.length; i += params.sampleEvery) {
      const entry = bars[i]!.close;
      const exit = bars[i + params.horizonDays]!.close;
      if (!(entry > 0) || !(exit > 0)) continue;
      const ret = (exit / entry - 1) * 100;
      const snap = computeIndicators(bars, i);
      const flags = evaluateFeatures(snap, params);
      all.push(ret);

      let weighted = 0;
      let available = 0;
      for (const f of active) {
        const v = flags[f.id];
        if (v === null || v === undefined) continue;
        const w = Math.max(0, params.weights[f.id] ?? f.defaultWeight);
        available += w;
        if (v) weighted += w;
        (v ? on : off).get(f.id)!.push(ret);
      }
      if (available > 0) scored.push({ score: (weighted / available) * 100, ret });
    }
  }

  const features: FeatureStat[] = active.map((f) => {
    const a = on.get(f.id)!;
    const b = off.get(f.id)!;
    const ma = mean(a);
    const mb = mean(b);
    const va = variance(a);
    const vb = variance(b);
    const tStat =
      ma !== null && mb !== null && va !== null && vb !== null && a.length > 1 && b.length > 1
        ? (ma - mb) / Math.sqrt(va / a.length + vb / b.length)
        : null;
    return {
      id: f.id,
      label: f.label,
      signalCount: a.length,
      noSignalCount: b.length,
      avgReturnOn: ma,
      avgReturnOff: mb,
      edge: ma !== null && mb !== null ? ma - mb : null,
      hitRateOn: a.length ? (a.filter((r) => r > 0).length / a.length) * 100 : null,
      hitRateOff: b.length ? (b.filter((r) => r > 0).length / b.length) * 100 : null,
      tStat,
    };
  });

  const edges: Array<[number, number, string]> = [
    [0, 20, "0~20점"],
    [20, 40, "20~40점"],
    [40, 60, "40~60점"],
    [60, 80, "60~80점"],
    [80, 100.001, "80~100점"],
  ];
  const buckets: BucketStat[] = edges.map(([lo, hi, label]) => {
    const rows = scored.filter((r) => r.score >= lo && r.score < hi).map((r) => r.ret);
    return {
      label,
      count: rows.length,
      avgReturn: mean(rows),
      hitRate: rows.length ? (rows.filter((r) => r > 0).length / rows.length) * 100 : null,
    };
  });

  const trades = scored.filter((r) => r.score >= params.entryScore).map((r) => r.ret);
  const wins = trades.filter((r) => r > 0);
  const losses = trades.filter((r) => r <= 0);
  const hitRate = trades.length ? (wins.length / trades.length) * 100 : null;
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  const avgTrade = mean(trades);
  const baseline = mean(all);
  const cumulative = trades.length
    ? (trades.reduce((acc, r) => acc * (1 + r / 100), 1) - 1) * 100
    : null;

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
    },
    notes: [],
  };
}

/** 벤치마크(지수) 전방 수익률 — 표본 편향 확인용 */
export function benchmarkForwardReturn(bars: DailyPrice[], horizonDays: number): number | null {
  const closes = bars.map((b) => b.close);
  const r = periodReturn(closes, closes.length - 1, horizonDays);
  return r === null ? null : r * 100;
}
