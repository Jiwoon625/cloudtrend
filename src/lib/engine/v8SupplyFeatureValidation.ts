import type { MarketDataset } from "./dataset";
import type { DailyPrice } from "./types";
import {
  V8_VF_FEATURE_IDS,
  neweyWestMean,
  prepareV8VfFeatureSeries,
  type PreparedVfFeatureSeries,
  type VfFeatureId,
} from "./v8VfFeatureValidation";
import { visitDelimitedRows } from "../sourceData";

export const V8_SUPPLY_FEATURE_VALIDATION_VERSION =
  "CloudTrend V8-9 Availability-Aware Supply Feature Validation" as const;

export const V8_SUPPLY_LOOKBACKS = [5, 20] as const;
export const V8_SUPPLY_FORWARD_HORIZONS = [5, 20] as const;
export const V8_SUPPLY_FOS_YEARS = [2018, 2022, 2025] as const;
export const V8_SUPPLY_COMPARATORS = ["BB_BREAKOUT", "ICH_ABOVE_CLOUD", "VOLUME_SURGE"] as const;

export type SupplyLookback = (typeof V8_SUPPLY_LOOKBACKS)[number];
export type SupplyForwardHorizon = (typeof V8_SUPPLY_FORWARD_HORIZONS)[number];
export type SupplyFosYear = (typeof V8_SUPPLY_FOS_YEARS)[number];
export type SupplyMarket = "ALL" | "KOSPI" | "KOSDAQ";
export type SupplyComparator = (typeof V8_SUPPLY_COMPARATORS)[number];

export type SupplyFeatureId =
  | "SHORT_AMOUNT_RATE_CHANGE"
  | "SHORT_VOLUME_RATE_CHANGE"
  | "LENDING_BALANCE_CHANGE"
  | "MARGIN_BALANCE_RATE_CHANGE"
  | "PROGRAM_NET_BUY_INTENSITY"
  | "FOREIGN_HOLDING_RATE_CHANGE";

export interface V8SupplyFeatureValidationOptions {
  limit?: number;
  warmupDays?: number;
  minCrossSection?: number;
  minFoldDays?: number;
  roundTripCostBps?: number;
}

interface SupplyPoint {
  date: string;
  shortAmountRate: number | null;
  shortVolumeRate: number | null;
  lendingBalanceQuantity: number | null;
  marginBalanceRate: number | null;
  programNetBuyVolume: number | null;
  foreignHoldingRate: number | null;
  foreignNetBuyValue: number | null;
  volume: number | null;
}

interface SupplyArrays {
  shortAmountRate: Float64Array;
  shortVolumeRate: Float64Array;
  lendingBalanceQuantity: Float64Array;
  marginBalanceRate: Float64Array;
  programNetBuyVolume: Float64Array;
  foreignHoldingRate: Float64Array;
  foreignNetBuyValue: Float64Array;
  volume: Float64Array;
}

interface RawAvailabilityAccumulator {
  nonNull: number;
  firstDate: string | null;
  lastDate: string | null;
}

interface RegressionObservation {
  yRaw: number;
  yExcess: number;
  target: number;
  controls: Partial<Record<VfFeatureId, number>>;
  extras?: Record<string, number>;
}

interface DailyFit {
  date: string;
  market: SupplyMarket;
  n: number;
  targetRaw: number;
  targetExcess: number;
  comparatorRaw: Partial<Record<SupplyComparator, number>>;
  comparatorExcess: Partial<Record<SupplyComparator, number>>;
}

export interface SupplyAvailabilityRow {
  feature: SupplyFeatureId | "SHORT_DOWN_LENDING_DOWN_FOREIGN_BUY";
  lookback: SupplyLookback;
  validStockDays: number;
  distinctDates: number;
  firstValidDate: string | null;
  lastValidDate: string | null;
  foldStockDays: Record<string, number>;
}

export interface SupplyEffectSummary {
  target: string;
  label: string;
  lookback: SupplyLookback | 0;
  horizon: SupplyForwardHorizon;
  market: SupplyMarket;
  supportedAll: {
    regressionDays: number;
    meanRawBeta: number | null;
    rawHacT: number | null;
    meanExcessBeta: number | null;
    excessHacT: number | null;
    comparatorMeanExcessBeta: Partial<Record<SupplyComparator, number | null>>;
  };
  threeFos: {
    usableFoldCount: number;
    usableFoldYears: SupplyFosYear[];
    preferredOrientation: "BONUS" | "PENALTY" | "NO_SIGNAL";
    equalWeightMeanExcessBeta: number | null;
    equalWeightMeanRawBeta: number | null;
    sameSignUsableFolds: number;
    foldSignConsistency: number | null;
    worstOrientedFoldExcessBeta: number | null;
    comparatorEqualWeightMeanExcessBeta: Partial<Record<SupplyComparator, number | null>>;
    folds: Record<string, {
      regressionDays: number;
      usable: boolean;
      meanRawBeta: number | null;
      rawHacT: number | null;
      meanExcessBeta: number | null;
      excessHacT: number | null;
      comparatorMeanExcessBeta: Partial<Record<SupplyComparator, number | null>>;
    }>;
  };
}

export interface V8SupplyFeatureValidationResult {
  version: typeof V8_SUPPLY_FEATURE_VALIDATION_VERSION;
  policy: {
    availabilityAware: true;
    missingValuePolicy: "missing-is-null-never-zero";
    candidateLookbacks: number[];
    forwardHorizons: number[];
    primaryOos: "3-FOS";
    foldYears: number[];
    incrementalEstimator: "daily-cross-sectional-Fama-MacBeth-with-existing-Vf-controls";
    inference: "Newey-West-HAC";
    comparatorPolicy: "same-date-same-stock-sample-standardized-beta";
    scoringChange: "none-research-only";
  };
  rawFieldAvailability: Record<string, RawAvailabilityAccumulator>;
  availability: SupplyAvailabilityRow[];
  technicalBaselines: SupplyEffectSummary[];
  supplyEffects: SupplyEffectSummary[];
  interactions: SupplyEffectSummary[];
  candidateDefinitions: Array<{
    feature: SupplyFeatureId;
    label: string;
    transform: string;
    interpretation: string;
  }>;
  notes: string[];
}

const FEATURE_LABELS: Record<SupplyFeatureId, string> = {
  SHORT_AMOUNT_RATE_CHANGE: "공매도 거래대금 비중 변화",
  SHORT_VOLUME_RATE_CHANGE: "공매도 거래량 비중 변화",
  LENDING_BALANCE_CHANGE: "대차잔고 수량 변화율",
  MARGIN_BALANCE_RATE_CHANGE: "신용잔고 비율 변화",
  PROGRAM_NET_BUY_INTENSITY: "프로그램 순매수 강도",
  FOREIGN_HOLDING_RATE_CHANGE: "외국인 보유비중 변화",
};

const FEATURE_DEFINITIONS: Array<{
  feature: SupplyFeatureId;
  label: string;
  transform: string;
  interpretation: string;
}> = [
  {
    feature: "SHORT_AMOUNT_RATE_CHANGE",
    label: FEATURE_LABELS.SHORT_AMOUNT_RATE_CHANGE,
    transform: "current short-selling amount rate minus N-trading-day lag (percentage points)",
    interpretation: "negative beta means rising short-selling intensity is a penalty signal",
  },
  {
    feature: "SHORT_VOLUME_RATE_CHANGE",
    label: FEATURE_LABELS.SHORT_VOLUME_RATE_CHANGE,
    transform: "current short-selling volume rate minus N-trading-day lag (percentage points)",
    interpretation: "negative beta means rising short-selling volume share is a penalty signal",
  },
  {
    feature: "LENDING_BALANCE_CHANGE",
    label: FEATURE_LABELS.LENDING_BALANCE_CHANGE,
    transform: "N-trading-day percent change in lending balance quantity",
    interpretation: "negative beta means increasing lending balance is a penalty signal",
  },
  {
    feature: "MARGIN_BALANCE_RATE_CHANGE",
    label: FEATURE_LABELS.MARGIN_BALANCE_RATE_CHANGE,
    transform: "current margin-loan balance rate minus N-trading-day lag (percentage points)",
    interpretation: "sign is learned; no bullish assumption is imposed",
  },
  {
    feature: "PROGRAM_NET_BUY_INTENSITY",
    label: FEATURE_LABELS.PROGRAM_NET_BUY_INTENSITY,
    transform: "N-day sum(program net buy volume) / N-day sum(total volume) * 100",
    interpretation: "positive beta means program net buying supplies incremental positive information",
  },
  {
    feature: "FOREIGN_HOLDING_RATE_CHANGE",
    label: FEATURE_LABELS.FOREIGN_HOLDING_RATE_CHANGE,
    transform: "current foreign holding rate minus N-trading-day lag (percentage points)",
    interpretation: "positive beta means rising foreign ownership supplies incremental positive information",
  },
];

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

function parseNumber(value: string | undefined): number | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "-" || /^(null|none|nan|na)$/i.test(raw)) return null;
  const parsed = Number(raw.replace(/[, ₩원%]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value: string | undefined): string | null {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/[^\d]/g, "").slice(0, 8);
  if (digits.length !== 8) return null;
  const y = Number(digits.slice(0, 4));
  const m = Number(digits.slice(4, 6));
  const d = Number(digits.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function normalizeSymbol(value: string | undefined) {
  let symbol = String(value ?? "").trim().toUpperCase().replace(/^A(?=\d{6}$)/, "").replace(/\.0$/, "");
  if (/^\d{1,6}$/.test(symbol)) symbol = symbol.padStart(6, "0");
  return symbol;
}

function compactHeader(value: string) {
  return value.trim().replace(/^\uFEFF/, "").replace(/[^0-9a-zA-Z가-힣]/g, "").toLowerCase();
}

function indexOfAny(index: Map<string, number>, aliases: string[]) {
  for (const alias of aliases) {
    const found = index.get(compactHeader(alias));
    if (found !== undefined) return found;
  }
  return -1;
}

function updateAvailability(acc: RawAvailabilityAccumulator, date: string, value: number | null) {
  if (!finite(value)) return;
  acc.nonNull++;
  if (!acc.firstDate || date < acc.firstDate) acc.firstDate = date;
  if (!acc.lastDate || date > acc.lastDate) acc.lastDate = date;
}

function rawAvailabilityShell(): Record<string, RawAvailabilityAccumulator> {
  return Object.fromEntries(
    [
      "shortAmountRate",
      "shortVolumeRate",
      "lendingBalanceQuantity",
      "marginBalanceRate",
      "programNetBuyVolume",
      "foreignHoldingRate",
      "foreignNetBuyValue",
      "volume",
    ].map((key) => [key, { nonNull: 0, firstDate: null, lastDate: null }]),
  );
}

function parseSupplyRows(rawTexts: string[], eligibleSymbols: Set<string>) {
  const bySymbol = new Map<string, SupplyPoint[]>();
  const availability = rawAvailabilityShell();

  for (const text of rawTexts) {
    let headerIndex: Map<string, number> | null = null;
    let idx: Record<string, number> | null = null;
    visitDelimitedRows(text, (cells, rowIndex) => {
      if (rowIndex === 0) {
        headerIndex = new Map(cells.map((header, i) => [compactHeader(header), i]));
        idx = {
          symbol: indexOfAny(headerIndex, ["symbol", "stockcode", "code", "ticker"]),
          date: indexOfAny(headerIndex, ["date", "tradedate"]),
          shortAmountRate: indexOfAny(headerIndex, ["shortsellingamountrate", "shortsellingtradingvaluerelativeimportance"]),
          shortVolumeRate: indexOfAny(headerIndex, ["shortsellingvolumerate", "shortsellingtradingvolumerelativeimportance"]),
          lendingBalanceQuantity: indexOfAny(headerIndex, ["lendingbalancequantity"]),
          marginBalanceRate: indexOfAny(headerIndex, ["marginloanbalancerate", "margintransactionbalanceratio"]),
          programNetBuyVolume: indexOfAny(headerIndex, ["programnetbuyvolume", "programtotalnetbuyingvolume"]),
          foreignHoldingRate: indexOfAny(headerIndex, ["foreignholdingratepct", "foreignholdingrate", "foreignholdingsratio"]),
          foreignNetBuyValue: indexOfAny(headerIndex, ["foreignnetbuyvalue"]),
          volume: indexOfAny(headerIndex, ["volume", "tradingvolume"]),
        };
        return;
      }
      if (!idx || idx.symbol < 0 || idx.date < 0) return;
      const symbol = normalizeSymbol(cells[idx.symbol]);
      if (!eligibleSymbols.has(symbol)) return;
      const date = normalizeDate(cells[idx.date]);
      if (!date) return;
      const point: SupplyPoint = {
        date,
        shortAmountRate: idx.shortAmountRate >= 0 ? parseNumber(cells[idx.shortAmountRate]) : null,
        shortVolumeRate: idx.shortVolumeRate >= 0 ? parseNumber(cells[idx.shortVolumeRate]) : null,
        lendingBalanceQuantity: idx.lendingBalanceQuantity >= 0 ? parseNumber(cells[idx.lendingBalanceQuantity]) : null,
        marginBalanceRate: idx.marginBalanceRate >= 0 ? parseNumber(cells[idx.marginBalanceRate]) : null,
        programNetBuyVolume: idx.programNetBuyVolume >= 0 ? parseNumber(cells[idx.programNetBuyVolume]) : null,
        foreignHoldingRate: idx.foreignHoldingRate >= 0 ? parseNumber(cells[idx.foreignHoldingRate]) : null,
        foreignNetBuyValue: idx.foreignNetBuyValue >= 0 ? parseNumber(cells[idx.foreignNetBuyValue]) : null,
        volume: idx.volume >= 0 ? parseNumber(cells[idx.volume]) : null,
      };
      for (const key of Object.keys(availability)) {
        updateAvailability(availability[key]!, date, point[key as keyof Omit<SupplyPoint, "date">] as number | null);
      }
      const xs = bySymbol.get(symbol) ?? [];
      xs.push(point);
      bySymbol.set(symbol, xs);
    });
  }

  for (const [symbol, rows] of bySymbol) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const merged: SupplyPoint[] = [];
    for (const row of rows) {
      const last = merged.at(-1);
      if (!last || last.date !== row.date) {
        merged.push(row);
        continue;
      }
      for (const key of [
        "shortAmountRate",
        "shortVolumeRate",
        "lendingBalanceQuantity",
        "marginBalanceRate",
        "programNetBuyVolume",
        "foreignHoldingRate",
        "foreignNetBuyValue",
        "volume",
      ] as const) {
        if (!finite(last[key]) && finite(row[key])) last[key] = row[key];
      }
    }
    bySymbol.set(symbol, merged);
  }

  return { bySymbol, availability };
}

function nanArray(length: number) {
  const values = new Float64Array(length);
  values.fill(Number.NaN);
  return values;
}

function alignSupply(bars: DailyPrice[], supply: SupplyPoint[] | undefined): SupplyArrays {
  const out: SupplyArrays = {
    shortAmountRate: nanArray(bars.length),
    shortVolumeRate: nanArray(bars.length),
    lendingBalanceQuantity: nanArray(bars.length),
    marginBalanceRate: nanArray(bars.length),
    programNetBuyVolume: nanArray(bars.length),
    foreignHoldingRate: nanArray(bars.length),
    foreignNetBuyValue: nanArray(bars.length),
    volume: nanArray(bars.length),
  };
  if (!supply?.length) return out;
  let j = 0;
  for (let i = 0; i < bars.length && j < supply.length; i++) {
    const date = bars[i]!.tradeDate;
    while (j < supply.length && supply[j]!.date < date) j++;
    if (j >= supply.length || supply[j]!.date !== date) continue;
    const row = supply[j]!;
    for (const key of Object.keys(out) as Array<keyof SupplyArrays>) {
      const value = row[key as keyof Omit<SupplyPoint, "date">] as number | null;
      if (finite(value)) out[key][i] = value;
    }
  }
  return out;
}

function delta(values: Float64Array, i: number, lookback: number) {
  if (i - lookback < 0) return null;
  const current = values[i];
  const lag = values[i - lookback];
  return Number.isFinite(current) && Number.isFinite(lag) ? current - lag : null;
}

function pctChange(values: Float64Array, i: number, lookback: number) {
  if (i - lookback < 0) return null;
  const current = values[i];
  const lag = values[i - lookback];
  if (!Number.isFinite(current) || !Number.isFinite(lag) || lag <= 0 || current < 0) return null;
  return (current / lag - 1) * 100;
}

function rollingRatio(numerator: Float64Array, denominator: Float64Array, i: number, lookback: number) {
  if (i - lookback + 1 < 0) return null;
  let num = 0;
  let den = 0;
  for (let j = i - lookback + 1; j <= i; j++) {
    const a = numerator[j];
    const b = denominator[j];
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < 0) return null;
    num += a;
    den += b;
  }
  return den > 0 ? (num / den) * 100 : null;
}

function rollingSum(values: Float64Array, i: number, lookback: number) {
  if (i - lookback + 1 < 0) return null;
  let sum = 0;
  for (let j = i - lookback + 1; j <= i; j++) {
    const value = values[j];
    if (!Number.isFinite(value)) return null;
    sum += value;
  }
  return sum;
}

function candidateValue(feature: SupplyFeatureId, arrays: SupplyArrays, i: number, lookback: SupplyLookback) {
  switch (feature) {
    case "SHORT_AMOUNT_RATE_CHANGE":
      return delta(arrays.shortAmountRate, i, lookback);
    case "SHORT_VOLUME_RATE_CHANGE":
      return delta(arrays.shortVolumeRate, i, lookback);
    case "LENDING_BALANCE_CHANGE":
      return pctChange(arrays.lendingBalanceQuantity, i, lookback);
    case "MARGIN_BALANCE_RATE_CHANGE":
      return delta(arrays.marginBalanceRate, i, lookback);
    case "PROGRAM_NET_BUY_INTENSITY":
      return rollingRatio(arrays.programNetBuyVolume, arrays.volume, i, lookback);
    case "FOREIGN_HOLDING_RATE_CHANGE":
      return delta(arrays.foreignHoldingRate, i, lookback);
  }
}

function buildIndexMaps(dataset: MarketDataset) {
  return {
    KOSPI: new Map(
      (dataset.indexSeries.find((series) => series.indexCode.toUpperCase() === "KOSPI")?.bars ?? []).map((bar) => [bar.tradeDate, bar]),
    ),
    KOSDAQ: new Map(
      (dataset.indexSeries.find((series) => series.indexCode.toUpperCase() === "KOSDAQ")?.bars ?? []).map((bar) => [bar.tradeDate, bar]),
    ),
  } as const;
}

function outcome(
  item: PreparedVfFeatureSeries,
  i: number,
  horizon: SupplyForwardHorizon,
  benchmark: Map<string, DailyPrice>,
  costBps: number,
) {
  if (i + horizon >= item.bars.length) return null;
  const entry = item.bars[i + 1];
  const exit = item.bars[i + horizon];
  if (!entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exit.close) || exit.close <= 0) return null;
  const raw = (exit.close / entry.open - 1) * 100 - costBps / 100;
  const bEntry = benchmark.get(entry.tradeDate);
  const bExit = benchmark.get(exit.tradeDate);
  if (!bEntry || !bExit || !finite(bEntry.open) || bEntry.open <= 0 || !finite(bExit.close) || bExit.close <= 0) return null;
  const excess = raw - (bExit.close / bEntry.open - 1) * 100;
  return { raw, excess };
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function solveLinear(matrix: number[][], vector: number[]) {
  const n = vector.length;
  const aug = matrix.map((row, i) => [...row, vector[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row]![col]!) > Math.abs(aug[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(aug[pivot]![col]!) < 1e-10) return null;
    if (pivot !== col) [aug[pivot], aug[col]] = [aug[col]!, aug[pivot]!];
    const scale = aug[col]![col]!;
    for (let j = col; j <= n; j++) aug[col]![j] /= scale;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row]![col]!;
      if (Math.abs(factor) < 1e-14) continue;
      for (let j = col; j <= n; j++) aug[row]![j] -= factor * aug[col]![j]!;
    }
  }
  return aug.map((row) => row[n]!);
}

function standardizedBeta(
  observations: RegressionObservation[],
  targetY: "yRaw" | "yExcess",
  extraNames: string[] = [],
) {
  if (observations.length < 20) return null;
  const predictorNames = ["TARGET", ...extraNames, ...V8_VF_FEATURE_IDS] as string[];
  const columns = predictorNames.map((name) =>
    observations.map((row) => {
      if (name === "TARGET") return row.target;
      if (extraNames.includes(name)) return row.extras?.[name] ?? Number.NaN;
      return row.controls[name as VfFeatureId] ?? Number.NaN;
    }),
  );
  if (columns.some((column) => column.some((value) => !Number.isFinite(value)))) return null;

  const means = columns.map((column) => mean(column) ?? 0);
  const sds = columns.map((column, k) => {
    const m = means[k]!;
    const variance = column.reduce((sum, value) => sum + (value - m) ** 2, 0) / Math.max(1, column.length - 1);
    return Math.sqrt(variance);
  });
  if (!(sds[0]! > 1e-12)) return null;

  const active = predictorNames.map((name, k) => ({ name, k })).filter(({ k }) => sds[k]! > 1e-12);
  const p = active.length + 1;
  if (observations.length <= p + 5) return null;
  const xtx = Array.from({ length: p }, () => Array(p).fill(0) as number[]);
  const xty = Array(p).fill(0) as number[];

  for (let r = 0; r < observations.length; r++) {
    const x = [1, ...active.map(({ k }) => (columns[k]![r]! - means[k]!) / sds[k]!)];
    const y = observations[r]![targetY];
    for (let a = 0; a < p; a++) {
      xty[a] += x[a]! * y;
      for (let b = 0; b < p; b++) xtx[a]![b] += x[a]! * x[b]!;
    }
  }
  for (let k = 1; k < p; k++) xtx[k]![k] += 1e-8;
  const beta = solveLinear(xtx, xty);
  if (!beta) return null;
  const out: Record<string, number> = {};
  active.forEach(({ name }, k) => {
    out[name] = beta[k + 1]!;
  });
  return out;
}

function controlsAt(item: PreparedVfFeatureSeries, i: number, exclude?: VfFeatureId) {
  const controls: Partial<Record<VfFeatureId, number>> = {};
  for (const feature of V8_VF_FEATURE_IDS) {
    if (feature === exclude) continue;
    const state = item.states[feature][i];
    if (state === -1) return null;
    controls[feature] = state;
  }
  return controls;
}

function fitDailyBuckets(
  buckets: Map<string, RegressionObservation[]>,
  horizon: SupplyForwardHorizon,
  minCrossSection: number,
  extraNames: string[] = [],
) {
  const fits: DailyFit[] = [];
  for (const [key, observations] of buckets) {
    if (observations.length < minCrossSection) continue;
    const [market, date] = key.split("|") as [SupplyMarket, string];
    const raw = standardizedBeta(observations, "yRaw", extraNames);
    const excess = standardizedBeta(observations, "yExcess", extraNames);
    if (!raw?.TARGET || !excess?.TARGET) continue;
    fits.push({
      date,
      market,
      n: observations.length,
      targetRaw: raw.TARGET,
      targetExcess: excess.TARGET,
      comparatorRaw: Object.fromEntries(V8_SUPPLY_COMPARATORS.map((feature) => [feature, raw[feature]]).filter(([, value]) => finite(value as number))),
      comparatorExcess: Object.fromEntries(V8_SUPPLY_COMPARATORS.map((feature) => [feature, excess[feature]]).filter(([, value]) => finite(value as number))),
    });
  }
  fits.sort((a, b) => a.date.localeCompare(b.date) || a.market.localeCompare(b.market));
  return { horizon, fits };
}

function summarizeFits(
  target: string,
  label: string,
  lookback: SupplyLookback | 0,
  horizon: SupplyForwardHorizon,
  market: SupplyMarket,
  fits: DailyFit[],
  minFoldDays: number,
): SupplyEffectSummary {
  const marketFits = fits.filter((fit) => fit.market === market);
  const lag = Math.max(0, horizon - 1);
  const allRaw = neweyWestMean(marketFits.map((fit) => fit.targetRaw), lag);
  const allExcess = neweyWestMean(marketFits.map((fit) => fit.targetExcess), lag);
  const comparatorAll: Partial<Record<SupplyComparator, number | null>> = {};
  for (const comparator of V8_SUPPLY_COMPARATORS) {
    comparatorAll[comparator] = mean(
      marketFits.map((fit) => fit.comparatorExcess[comparator]).filter(finite),
    );
  }

  const folds: SupplyEffectSummary["threeFos"]["folds"] = {};
  const usable: Array<{ year: SupplyFosYear; raw: number; excess: number; comparators: Partial<Record<SupplyComparator, number | null>> }> = [];
  for (const year of V8_SUPPLY_FOS_YEARS) {
    const xs = marketFits.filter((fit) => Number(fit.date.slice(0, 4)) === year);
    const raw = neweyWestMean(xs.map((fit) => fit.targetRaw), lag);
    const excess = neweyWestMean(xs.map((fit) => fit.targetExcess), lag);
    const comparators: Partial<Record<SupplyComparator, number | null>> = {};
    for (const comparator of V8_SUPPLY_COMPARATORS) {
      comparators[comparator] = mean(xs.map((fit) => fit.comparatorExcess[comparator]).filter(finite));
    }
    const isUsable = xs.length >= minFoldDays && finite(excess.mean);
    folds[String(year)] = {
      regressionDays: xs.length,
      usable: isUsable,
      meanRawBeta: raw.mean,
      rawHacT: raw.t,
      meanExcessBeta: excess.mean,
      excessHacT: excess.t,
      comparatorMeanExcessBeta: comparators,
    };
    if (isUsable && finite(raw.mean) && finite(excess.mean)) usable.push({ year, raw: raw.mean, excess: excess.mean, comparators });
  }

  const eqExcess = mean(usable.map((fold) => fold.excess));
  const eqRaw = mean(usable.map((fold) => fold.raw));
  const orientation = !finite(eqExcess) || Math.abs(eqExcess) < 1e-9 ? "NO_SIGNAL" : eqExcess > 0 ? "BONUS" : "PENALTY";
  const orientationSign = orientation === "BONUS" ? 1 : orientation === "PENALTY" ? -1 : 0;
  const sameSign = orientationSign
    ? usable.filter((fold) => Math.sign(fold.excess) === orientationSign).length
    : 0;
  const comparatorEq: Partial<Record<SupplyComparator, number | null>> = {};
  for (const comparator of V8_SUPPLY_COMPARATORS) {
    comparatorEq[comparator] = mean(usable.map((fold) => fold.comparators[comparator]).filter(finite));
  }
  const orientedFoldValues = orientationSign ? usable.map((fold) => fold.excess * orientationSign) : [];

  return {
    target,
    label,
    lookback,
    horizon,
    market,
    supportedAll: {
      regressionDays: marketFits.length,
      meanRawBeta: allRaw.mean,
      rawHacT: allRaw.t,
      meanExcessBeta: allExcess.mean,
      excessHacT: allExcess.t,
      comparatorMeanExcessBeta: comparatorAll,
    },
    threeFos: {
      usableFoldCount: usable.length,
      usableFoldYears: usable.map((fold) => fold.year),
      preferredOrientation: orientation,
      equalWeightMeanExcessBeta: eqExcess,
      equalWeightMeanRawBeta: eqRaw,
      sameSignUsableFolds: sameSign,
      foldSignConsistency: usable.length ? sameSign / usable.length : null,
      worstOrientedFoldExcessBeta: orientedFoldValues.length ? Math.min(...orientedFoldValues) : null,
      comparatorEqualWeightMeanExcessBeta: comparatorEq,
      folds,
    },
  };
}

function candidateAvailability(
  feature: SupplyFeatureId,
  lookback: SupplyLookback,
  series: PreparedVfFeatureSeries[],
  aligned: Map<string, SupplyArrays>,
): SupplyAvailabilityRow {
  let validStockDays = 0;
  let firstValidDate: string | null = null;
  let lastValidDate: string | null = null;
  const dates = new Set<string>();
  const foldStockDays: Record<string, number> = Object.fromEntries(V8_SUPPLY_FOS_YEARS.map((year) => [String(year), 0]));
  for (const item of series) {
    const arrays = aligned.get(item.symbol);
    if (!arrays) continue;
    for (let i = 0; i < item.bars.length; i++) {
      const value = candidateValue(feature, arrays, i, lookback);
      if (!finite(value)) continue;
      const date = item.bars[i]!.tradeDate;
      validStockDays++;
      dates.add(date);
      if (!firstValidDate || date < firstValidDate) firstValidDate = date;
      if (!lastValidDate || date > lastValidDate) lastValidDate = date;
      const year = Number(date.slice(0, 4));
      if (V8_SUPPLY_FOS_YEARS.includes(year as SupplyFosYear)) foldStockDays[String(year)]++;
    }
  }
  return { feature, lookback, validStockDays, distinctDates: dates.size, firstValidDate, lastValidDate, foldStockDays };
}

function buildSupplyFits(
  feature: SupplyFeatureId,
  lookback: SupplyLookback,
  horizon: SupplyForwardHorizon,
  series: PreparedVfFeatureSeries[],
  aligned: Map<string, SupplyArrays>,
  indexes: ReturnType<typeof buildIndexMaps>,
  costBps: number,
  minCrossSection: number,
) {
  const buckets = new Map<string, RegressionObservation[]>();
  const add = (market: SupplyMarket, date: string, observation: RegressionObservation) => {
    const key = `${market}|${date}`;
    const xs = buckets.get(key) ?? [];
    xs.push(observation);
    buckets.set(key, xs);
  };
  for (const item of series) {
    const arrays = aligned.get(item.symbol);
    if (!arrays) continue;
    const benchmark = indexes[item.market];
    for (let i = 0; i < item.bars.length; i++) {
      const target = candidateValue(feature, arrays, i, lookback);
      if (!finite(target)) continue;
      const controls = controlsAt(item, i);
      if (!controls) continue;
      const result = outcome(item, i, horizon, benchmark, costBps);
      if (!result) continue;
      const observation: RegressionObservation = { yRaw: result.raw, yExcess: result.excess, target, controls };
      const date = item.bars[i]!.tradeDate;
      add(item.market, date, observation);
      add("ALL", date, observation);
    }
  }
  return fitDailyBuckets(buckets, horizon, minCrossSection).fits;
}

function buildTechnicalBaselineFits(
  targetFeature: SupplyComparator,
  horizon: SupplyForwardHorizon,
  series: PreparedVfFeatureSeries[],
  indexes: ReturnType<typeof buildIndexMaps>,
  costBps: number,
  minCrossSection: number,
) {
  const buckets = new Map<string, RegressionObservation[]>();
  const add = (market: SupplyMarket, date: string, observation: RegressionObservation) => {
    const key = `${market}|${date}`;
    const xs = buckets.get(key) ?? [];
    xs.push(observation);
    buckets.set(key, xs);
  };
  for (const item of series) {
    const benchmark = indexes[item.market];
    for (let i = 0; i < item.bars.length; i++) {
      const target = item.states[targetFeature][i];
      if (target === -1) continue;
      const controls = controlsAt(item, i, targetFeature);
      if (!controls) continue;
      const result = outcome(item, i, horizon, benchmark, costBps);
      if (!result) continue;
      const observation: RegressionObservation = { yRaw: result.raw, yExcess: result.excess, target, controls };
      const date = item.bars[i]!.tradeDate;
      add(item.market, date, observation);
      add("ALL", date, observation);
    }
  }
  return fitDailyBuckets(buckets, horizon, minCrossSection).fits;
}

function buildInteractionFits(
  lookback: SupplyLookback,
  horizon: SupplyForwardHorizon,
  series: PreparedVfFeatureSeries[],
  aligned: Map<string, SupplyArrays>,
  indexes: ReturnType<typeof buildIndexMaps>,
  costBps: number,
  minCrossSection: number,
) {
  const buckets = new Map<string, RegressionObservation[]>();
  const add = (market: SupplyMarket, date: string, observation: RegressionObservation) => {
    const key = `${market}|${date}`;
    const xs = buckets.get(key) ?? [];
    xs.push(observation);
    buckets.set(key, xs);
  };
  for (const item of series) {
    const arrays = aligned.get(item.symbol);
    if (!arrays) continue;
    const benchmark = indexes[item.market];
    for (let i = 0; i < item.bars.length; i++) {
      const shortChange = delta(arrays.shortAmountRate, i, lookback);
      const lendingChange = pctChange(arrays.lendingBalanceQuantity, i, lookback);
      const foreignNetBuy = rollingSum(arrays.foreignNetBuyValue, i, lookback);
      if (!finite(shortChange) || !finite(lendingChange) || !finite(foreignNetBuy)) continue;
      const shortDown = shortChange < 0 ? 1 : 0;
      const lendingDown = lendingChange < 0 ? 1 : 0;
      const foreignBuy = foreignNetBuy > 0 ? 1 : 0;
      const target = shortDown && lendingDown && foreignBuy ? 1 : 0;
      const controls = controlsAt(item, i);
      if (!controls) continue;
      const result = outcome(item, i, horizon, benchmark, costBps);
      if (!result) continue;
      const observation: RegressionObservation = {
        yRaw: result.raw,
        yExcess: result.excess,
        target,
        controls,
        extras: { SHORT_CHANGE: shortChange, LENDING_CHANGE: lendingChange, FOREIGN_BUY: foreignBuy },
      };
      const date = item.bars[i]!.tradeDate;
      add(item.market, date, observation);
      add("ALL", date, observation);
    }
  }
  return fitDailyBuckets(buckets, horizon, minCrossSection, ["SHORT_CHANGE", "LENDING_CHANGE", "FOREIGN_BUY"]).fits;
}

function interactionAvailability(
  lookback: SupplyLookback,
  series: PreparedVfFeatureSeries[],
  aligned: Map<string, SupplyArrays>,
): SupplyAvailabilityRow {
  let validStockDays = 0;
  let firstValidDate: string | null = null;
  let lastValidDate: string | null = null;
  const dates = new Set<string>();
  const foldStockDays: Record<string, number> = Object.fromEntries(V8_SUPPLY_FOS_YEARS.map((year) => [String(year), 0]));
  for (const item of series) {
    const arrays = aligned.get(item.symbol);
    if (!arrays) continue;
    for (let i = 0; i < item.bars.length; i++) {
      const shortChange = delta(arrays.shortAmountRate, i, lookback);
      const lendingChange = pctChange(arrays.lendingBalanceQuantity, i, lookback);
      const foreignNetBuy = rollingSum(arrays.foreignNetBuyValue, i, lookback);
      if (!finite(shortChange) || !finite(lendingChange) || !finite(foreignNetBuy)) continue;
      const date = item.bars[i]!.tradeDate;
      validStockDays++;
      dates.add(date);
      if (!firstValidDate || date < firstValidDate) firstValidDate = date;
      if (!lastValidDate || date > lastValidDate) lastValidDate = date;
      const year = Number(date.slice(0, 4));
      if (V8_SUPPLY_FOS_YEARS.includes(year as SupplyFosYear)) foldStockDays[String(year)]++;
    }
  }
  return {
    feature: "SHORT_DOWN_LENDING_DOWN_FOREIGN_BUY",
    lookback,
    validStockDays,
    distinctDates: dates.size,
    firstValidDate,
    lastValidDate,
    foldStockDays,
  };
}

export function analyzeV8SupplyFeatures(
  dataset: MarketDataset,
  rawTexts: string[],
  options: V8SupplyFeatureValidationOptions = {},
): V8SupplyFeatureValidationResult {
  const limit = options.limit ?? 613;
  const warmupDays = options.warmupDays ?? 120;
  const minCrossSection = options.minCrossSection ?? 30;
  const minFoldDays = options.minFoldDays ?? 20;
  const roundTripCostBps = options.roundTripCostBps ?? 0;

  const series = prepareV8VfFeatureSeries(dataset, limit, warmupDays);
  const eligibleSymbols = new Set(series.map((item) => item.symbol));
  const parsed = parseSupplyRows(rawTexts, eligibleSymbols);
  const aligned = new Map<string, SupplyArrays>();
  for (const item of series) aligned.set(item.symbol, alignSupply(item.bars, parsed.bySymbol.get(item.symbol)));
  const indexes = buildIndexMaps(dataset);

  const availability: SupplyAvailabilityRow[] = [];
  const supplyEffects: SupplyEffectSummary[] = [];
  for (const definition of FEATURE_DEFINITIONS) {
    for (const lookback of V8_SUPPLY_LOOKBACKS) {
      availability.push(candidateAvailability(definition.feature, lookback, series, aligned));
      for (const horizon of V8_SUPPLY_FORWARD_HORIZONS) {
        const fits = buildSupplyFits(
          definition.feature,
          lookback,
          horizon,
          series,
          aligned,
          indexes,
          roundTripCostBps,
          minCrossSection,
        );
        for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
          supplyEffects.push(
            summarizeFits(definition.feature, definition.label, lookback, horizon, market, fits, minFoldDays),
          );
        }
      }
    }
  }

  const technicalBaselines: SupplyEffectSummary[] = [];
  for (const feature of V8_SUPPLY_COMPARATORS) {
    for (const horizon of V8_SUPPLY_FORWARD_HORIZONS) {
      const fits = buildTechnicalBaselineFits(feature, horizon, series, indexes, roundTripCostBps, minCrossSection);
      for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
        technicalBaselines.push(
          summarizeFits(feature, feature, 0, horizon, market, fits, minFoldDays),
        );
      }
    }
  }

  const interactions: SupplyEffectSummary[] = [];
  for (const lookback of V8_SUPPLY_LOOKBACKS) {
    availability.push(interactionAvailability(lookback, series, aligned));
    for (const horizon of V8_SUPPLY_FORWARD_HORIZONS) {
      const fits = buildInteractionFits(
        lookback,
        horizon,
        series,
        aligned,
        indexes,
        roundTripCostBps,
        minCrossSection,
      );
      for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
        interactions.push(
          summarizeFits(
            "SHORT_DOWN_LENDING_DOWN_FOREIGN_BUY",
            "공매도 감소 × 대차잔고 감소 × 외국인 순매수 interaction",
            lookback,
            horizon,
            market,
            fits,
            minFoldDays,
          ),
        );
      }
    }
  }

  return {
    version: V8_SUPPLY_FEATURE_VALIDATION_VERSION,
    policy: {
      availabilityAware: true,
      missingValuePolicy: "missing-is-null-never-zero",
      candidateLookbacks: [...V8_SUPPLY_LOOKBACKS],
      forwardHorizons: [...V8_SUPPLY_FORWARD_HORIZONS],
      primaryOos: "3-FOS",
      foldYears: [...V8_SUPPLY_FOS_YEARS],
      incrementalEstimator: "daily-cross-sectional-Fama-MacBeth-with-existing-Vf-controls",
      inference: "Newey-West-HAC",
      comparatorPolicy: "same-date-same-stock-sample-standardized-beta",
      scoringChange: "none-research-only",
    },
    rawFieldAvailability: parsed.availability,
    availability,
    technicalBaselines,
    supplyEffects,
    interactions,
    candidateDefinitions: FEATURE_DEFINITIONS,
    notes: [
      "Missing supply data is never imputed as zero.",
      "Each candidate is evaluated only on stock-days where its own N-day transformation is observable.",
      "Daily cross-sectional regressions include all seven existing Vf feature states as controls; candidate and controls are standardized within each day before Fama-MacBeth aggregation.",
      "BB_BREAKOUT, ICH_ABOVE_CLOUD and VOLUME_SURGE coefficients are recorded on the exact same candidate sample for direct comparison.",
      "A negative incremental beta is interpreted as evidence that the raw signal is more suitable as a penalty/avoidance variable than as a bonus.",
      "The short-down × lending-down × foreign-buy interaction controls the three main effects as well as the existing Vf states.",
      "No V8 score weight is changed by this study; candidates require separate decision and forward validation before production scoring.",
    ],
  };
}
