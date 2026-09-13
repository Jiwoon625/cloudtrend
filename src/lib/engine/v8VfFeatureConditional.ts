import type { IndexSeries } from "./types";
import {
  V8_VF_FEATURE_IDS,
  neweyWestMean,
  type PreparedVfFeatureSeries,
  type VfFeatureId,
  type VfFeatureMarket,
  type VfFeatureSplit,
} from "./v8VfFeatureValidation";

export const V8_VF_CONDITIONAL_VERSION = "CloudTrend V8 Vf Conditional Fama-MacBeth" as const;

const FEATURE_LABELS: Record<VfFeatureId, string> = {
  ICH_ABOVE_CLOUD: "일목 구름 상단 위",
  ICH_TENKAN_KIJUN: "전환선 > 기준선",
  BB_BREAKOUT: "볼린저 상단 돌파",
  MA_ALIGNED: "MA20 > MA60 > MA120 정배열",
  VOLUME_SURGE: "고가 마감 거래량",
  NEAR_52W_HIGH: "52주 신고가 대비 10% 이내",
  FOREIGN_NET_POSITIVE: "20D 외국인 누적 순매수 > 0",
};

type StockMarket = Exclude<VfFeatureMarket, "ALL">;

type ConditionalScope = "SPLIT" | "YEAR";

interface OutcomeSeries {
  ret: Float64Array;
  excess: Float64Array;
}

interface DailyRegression {
  date: string;
  market: StockMarket | "ALL";
  n: number;
  rawBetas: number[] | null;
  excessBetas: number[] | null;
}

export interface V8VfConditionalRow {
  scope: ConditionalScope;
  split: VfFeatureSplit | null;
  year: number | null;
  market: VfFeatureMarket;
  feature: VfFeatureId;
  label: string;
  horizon: number;
  hacLag: number;
  regressionDatesRaw: number;
  regressionDatesExcess: number;
  averageCrossSectionNRaw: number | null;
  averageCrossSectionNExcess: number | null;
  rawBetaMean: number | null;
  rawBetaHacT: number | null;
  rawBetaCiLow: number | null;
  rawBetaCiHigh: number | null;
  excessBetaMean: number | null;
  excessBetaHacT: number | null;
  excessBetaCiLow: number | null;
  excessBetaCiHigh: number | null;
}

export interface V8VfConditionalRobustnessRow {
  feature: VfFeatureId;
  label: string;
  allPositiveExcessHorizons: number;
  allSignificantPositiveExcessHorizons: number;
  oosPositiveExcessHorizons: number;
  oosSignificantPositiveExcessHorizons: number;
  allMedianExcessBeta: number | null;
  oosMedianExcessBeta: number | null;
  horizonsTested: number;
}

export interface V8VfConditionalResult {
  version: typeof V8_VF_CONDITIONAL_VERSION;
  horizons: number[];
  rows: V8VfConditionalRow[];
  robustness: V8VfConditionalRobustnessRow[];
  inference: {
    method: "Fama-MacBeth-daily-cross-sectional-OLS + Newey-West-HAC";
    dependentVariables: ["forwardReturn", "forwardMarketExcessReturn"];
    predictors: VfFeatureId[];
    intercept: true;
    completeCase: true;
    minCrossSectionN: number;
    lagRule: "horizon-1";
    confidenceLevel: 0.95;
  };
  notes: string[];
}

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)]! + sorted[Math.ceil(mid)]!) / 2;
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
  } satisfies Record<StockMarket, Map<string, (IndexSeries["bars"])[number]>>;
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
    ret.fill(Number.NaN);
    excess.fill(Number.NaN);
    const benchmark = indexes[item.market];
    for (let i = 0; i + horizon < n; i++) {
      const entry = item.bars[i + 1];
      const exit = item.bars[i + horizon];
      if (!entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exit.close) || exit.close <= 0)
        continue;
      const stockReturn = (exit.close / entry.open - 1) * 100 - costBps / 100;
      ret[i] = stockReturn;
      const indexEntry = benchmark.get(entry.tradeDate);
      const indexExit = benchmark.get(exit.tradeDate);
      if (
        indexEntry &&
        indexExit &&
        finite(indexEntry.open) &&
        indexEntry.open > 0 &&
        finite(indexExit.close) &&
        indexExit.close > 0
      ) {
        excess[i] = stockReturn - (indexExit.close / indexEntry.open - 1) * 100;
      }
    }
    return { ret, excess };
  });
}

function solveLinearSystem(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const augmented = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(augmented[row]![col]!) > Math.abs(augmented[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(augmented[pivot]![col]!) < 1e-9) return null;
    [augmented[col], augmented[pivot]] = [augmented[pivot]!, augmented[col]!];
    const scale = augmented[col]![col]!;
    for (let j = col; j <= n; j++) augmented[col]![j] = augmented[col]![j]! / scale;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = augmented[row]![col]!;
      if (Math.abs(factor) < 1e-15) continue;
      for (let j = col; j <= n; j++) {
        augmented[row]![j] = augmented[row]![j]! - factor * augmented[col]![j]!;
      }
    }
  }
  return augmented.map((row) => row[n]!);
}

export function crossSectionalOls(features: number[][], y: number[]): number[] | null {
  if (!features.length || features.length !== y.length) return null;
  const p = features[0]?.length ?? 0;
  if (!p || features.some((row) => row.length !== p)) return null;
  const dimension = p + 1;
  const xtx = Array.from({ length: dimension }, () => Array(dimension).fill(0) as number[]);
  const xty = Array(dimension).fill(0) as number[];
  for (let i = 0; i < features.length; i++) {
    const x = [1, ...features[i]!];
    const yi = y[i]!;
    for (let a = 0; a < dimension; a++) {
      xty[a] += x[a]! * yi;
      for (let b = a; b < dimension; b++) xtx[a]![b] += x[a]! * x[b]!;
    }
  }
  for (let a = 0; a < dimension; a++) {
    for (let b = 0; b < a; b++) xtx[a]![b] = xtx[b]![a]!;
  }
  return solveLinearSystem(xtx, xty);
}

function uniqueDates(series: PreparedVfFeatureSeries[]) {
  return [...new Set(series.flatMap((item) => item.bars.map((bar) => bar.tradeDate)))].sort();
}

function splitPolicy(dates: string[]) {
  const validationIndex = Math.min(dates.length - 1, Math.floor(dates.length * 0.6));
  const oosIndex = Math.min(dates.length - 1, Math.floor(dates.length * 0.8));
  return {
    validationFrom: dates[validationIndex] ?? null,
    oosFrom: dates[oosIndex] ?? null,
  };
}

function splitForDate(date: string, policy: ReturnType<typeof splitPolicy>): Exclude<VfFeatureSplit, "ALL"> {
  if (policy.oosFrom && date >= policy.oosFrom) return "OOS";
  if (policy.validationFrom && date >= policy.validationFrom) return "VALIDATION";
  return "DEVELOPMENT";
}

function collectDailyRegressions(
  series: PreparedVfFeatureSeries[],
  outcomes: OutcomeSeries[],
  warmupDays: number,
  minCrossSectionN: number,
): DailyRegression[] {
  type Obs = { market: StockMarket; x: number[]; raw: number; excess: number };
  const byDate = new Map<string, Obs[]>();
  for (let s = 0; s < series.length; s++) {
    const item = series[s]!;
    const outcome = outcomes[s]!;
    for (let i = warmupDays; i < item.bars.length; i++) {
      const raw = outcome.ret[i];
      const excess = outcome.excess[i];
      if (!Number.isFinite(raw) || !Number.isFinite(excess)) continue;
      const x: number[] = [];
      let complete = true;
      for (const feature of V8_VF_FEATURE_IDS) {
        const value = item.states[feature][i];
        if (value !== 0 && value !== 1) {
          complete = false;
          break;
        }
        x.push(value);
      }
      if (!complete) continue;
      const date = item.bars[i]!.tradeDate;
      const bucket = byDate.get(date) ?? [];
      bucket.push({ market: item.market, x, raw, excess });
      byDate.set(date, bucket);
    }
  }

  const output: DailyRegression[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const all = byDate.get(date)!;
    for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
      const obs = market === "ALL" ? all : all.filter((value) => value.market === market);
      if (obs.length < minCrossSectionN) continue;
      const x = obs.map((value) => value.x);
      const rawBetas = crossSectionalOls(x, obs.map((value) => value.raw));
      const excessBetas = crossSectionalOls(x, obs.map((value) => value.excess));
      if (!rawBetas && !excessBetas) continue;
      output.push({
        date,
        market,
        n: obs.length,
        rawBetas,
        excessBetas,
      });
    }
  }
  return output;
}

function rowGroups(
  regressions: DailyRegression[],
  policy: ReturnType<typeof splitPolicy>,
): Array<{
  scope: ConditionalScope;
  split: VfFeatureSplit | null;
  year: number | null;
  market: VfFeatureMarket;
  data: DailyRegression[];
}> {
  const groups: Array<{
    scope: ConditionalScope;
    split: VfFeatureSplit | null;
    year: number | null;
    market: VfFeatureMarket;
    data: DailyRegression[];
  }> = [];
  for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
    const marketRows = regressions.filter((row) => row.market === market);
    groups.push({ scope: "SPLIT", split: "ALL", year: null, market, data: marketRows });
    for (const split of ["DEVELOPMENT", "VALIDATION", "OOS"] as const) {
      groups.push({
        scope: "SPLIT",
        split,
        year: null,
        market,
        data: marketRows.filter((row) => splitForDate(row.date, policy) === split),
      });
    }
    const years = [...new Set(marketRows.map((row) => Number(row.date.slice(0, 4))))].sort((a, b) => a - b);
    for (const year of years) {
      groups.push({
        scope: "YEAR",
        split: null,
        year,
        market,
        data: marketRows.filter((row) => Number(row.date.slice(0, 4)) === year),
      });
    }
  }
  return groups;
}

function averageN(data: DailyRegression[], field: "rawBetas" | "excessBetas") {
  const ns = data.filter((row) => row[field] !== null).map((row) => row.n);
  return ns.length ? ns.reduce((sum, value) => sum + value, 0) / ns.length : null;
}

function rowsForHorizon(
  regressions: DailyRegression[],
  dates: string[],
  horizon: number,
): V8VfConditionalRow[] {
  const policy = splitPolicy(dates);
  const output: V8VfConditionalRow[] = [];
  for (const group of rowGroups(regressions, policy)) {
    for (let f = 0; f < V8_VF_FEATURE_IDS.length; f++) {
      const feature = V8_VF_FEATURE_IDS[f]!;
      const coefficientIndex = f + 1;
      const raw = group.data
        .map((row) => row.rawBetas?.[coefficientIndex])
        .filter((value): value is number => finite(value));
      const excess = group.data
        .map((row) => row.excessBetas?.[coefficientIndex])
        .filter((value): value is number => finite(value));
      const rawHac = neweyWestMean(raw, horizon - 1);
      const excessHac = neweyWestMean(excess, horizon - 1);
      output.push({
        scope: group.scope,
        split: group.split,
        year: group.year,
        market: group.market,
        feature,
        label: FEATURE_LABELS[feature],
        horizon,
        hacLag: Math.max(0, horizon - 1),
        regressionDatesRaw: rawHac.count,
        regressionDatesExcess: excessHac.count,
        averageCrossSectionNRaw: averageN(group.data, "rawBetas"),
        averageCrossSectionNExcess: averageN(group.data, "excessBetas"),
        rawBetaMean: rawHac.mean,
        rawBetaHacT: rawHac.t,
        rawBetaCiLow: rawHac.ciLow,
        rawBetaCiHigh: rawHac.ciHigh,
        excessBetaMean: excessHac.mean,
        excessBetaHacT: excessHac.t,
        excessBetaCiLow: excessHac.ciLow,
        excessBetaCiHigh: excessHac.ciHigh,
      });
    }
  }
  return output;
}

function robustness(rows: V8VfConditionalRow[], horizons: number[]): V8VfConditionalRobustnessRow[] {
  return V8_VF_FEATURE_IDS.map((feature) => {
    const select = (split: "ALL" | "OOS") =>
      rows.filter(
        (row) =>
          row.scope === "SPLIT" &&
          row.split === split &&
          row.market === "ALL" &&
          row.feature === feature,
      );
    const all = select("ALL");
    const oos = select("OOS");
    return {
      feature,
      label: FEATURE_LABELS[feature],
      allPositiveExcessHorizons: all.filter((row) => (row.excessBetaMean ?? 0) > 0).length,
      allSignificantPositiveExcessHorizons: all.filter(
        (row) => row.excessBetaCiLow !== null && row.excessBetaCiLow > 0,
      ).length,
      oosPositiveExcessHorizons: oos.filter((row) => (row.excessBetaMean ?? 0) > 0).length,
      oosSignificantPositiveExcessHorizons: oos.filter(
        (row) => row.excessBetaCiLow !== null && row.excessBetaCiLow > 0,
      ).length,
      allMedianExcessBeta: median(all.map((row) => row.excessBetaMean).filter(finite)),
      oosMedianExcessBeta: median(oos.map((row) => row.excessBetaMean).filter(finite)),
      horizonsTested: horizons.length,
    };
  });
}

export function buildV8VfConditionalValidation(
  series: PreparedVfFeatureSeries[],
  indexSeries: IndexSeries[],
  options: {
    horizons: number[];
    warmupDays?: number;
    roundTripCostBps?: number;
    minCrossSectionN?: number;
  },
): V8VfConditionalResult {
  const horizons = [...new Set(options.horizons)].sort((a, b) => a - b);
  const warmupDays = Math.max(0, Math.round(options.warmupDays ?? 120));
  const costBps = Math.max(0, options.roundTripCostBps ?? 0);
  const minCrossSectionN = Math.max(20, Math.round(options.minCrossSectionN ?? 30));
  const dates = uniqueDates(series);
  const rows: V8VfConditionalRow[] = [];
  for (const horizon of horizons) {
    const outcomes = buildOutcomes(series, indexSeries, horizon, costBps);
    const regressions = collectDailyRegressions(series, outcomes, warmupDays, minCrossSectionN);
    rows.push(...rowsForHorizon(regressions, dates, horizon));
  }
  return {
    version: V8_VF_CONDITIONAL_VERSION,
    horizons,
    rows,
    robustness: robustness(rows, horizons),
    inference: {
      method: "Fama-MacBeth-daily-cross-sectional-OLS + Newey-West-HAC",
      dependentVariables: ["forwardReturn", "forwardMarketExcessReturn"],
      predictors: [...V8_VF_FEATURE_IDS],
      intercept: true,
      completeCase: true,
      minCrossSectionN,
      lagRule: "horizon-1",
      confidenceLevel: 0.95,
    },
    notes: [
      "각 거래일마다 7개 Vf 상태를 동시에 설명변수로 넣은 횡단면 OLS를 수행한 뒤 일별 계수의 시계열 평균을 Fama-MacBeth 방식으로 평가한다.",
      "계수는 다른 6개 Vf 상태를 통제한 상태에서 해당 피처가 false→true일 때의 forward return 또는 시장초과수익률 차이(%p)를 뜻한다.",
      "7개 Vf가 모두 계산 가능한 complete-case만 사용하며 결측은 0으로 대체하지 않는다.",
      "시장별 회귀는 KOSPI/KOSDAQ을 별도로 수행하며 최소 횡단면 표본은 30종목이다. 특이행렬인 날짜는 해당 회귀에서 제외한다.",
      "Fama-MacBeth 일별 계수에는 겹치는 h일 forward return을 고려해 Newey-West lag=h-1을 적용한다.",
    ],
  };
}
