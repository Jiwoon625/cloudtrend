import { computeIndicators } from "./indicators";
import { historicalTechnicalScore } from "./scoring";
import {
  adjustSectorPenaltyScore,
  SECTOR_PENALTY_POINTS,
  SECTOR_SLOT_POINTS,
} from "./sectorScoreAdjustment";
import type { MarketDataset } from "./dataset";
import type { SimulatedTrade, StrategySeries, V6ExitReason } from "./strategyValidationLegacy";
import type { DailyPrice, Instrument } from "./types";

export const SECTOR_PENALTY_BACKTEST_VERSION = "CloudTrend V8 Sector Penalty Backtest";

const SCORE_MAX = 10;
const SECTOR_SLOT = SECTOR_SLOT_POINTS;
const SECTOR_PENALTY = SECTOR_PENALTY_POINTS;

export interface SectorPenaltyBacktestOptions {
  limit?: number;
  roundTripCostBps?: number;
  entryThresholds?: number[];
  upsideExitThresholds?: number[];
  downsideExitThresholds?: number[];
  maxHoldingDays?: number[];
  priceLeadershipOverheatThresholds?: number[];
  includeNoPenaltyBaseline?: boolean;
}

export interface SectorPenaltyScenario {
  id: string;
  label: string;
  modelId: string;
  modelLabel: string;
  priceLeadershipOverheatThreshold: number | null;
  entryThreshold: number;
  upsideExitThreshold: number;
  downsideExitThreshold: number;
  maxHoldingDays: number;
}

export interface SectorPenaltyTrade extends SimulatedTrade {
  modelId: string;
  priceLeadershipOverheatThreshold: number | null;
  baseScore9p5: number | null;
  adjustedScore10: number;
  sectorCode: string;
  sectorName: string;
  sectorPriceLeadership: number | null;
  sectorOverheated: boolean | null;
  sectorPenaltyApplied: boolean;
  benchmarkReturn: number | null;
  excessReturn: number | null;
}

export interface SectorPenaltyMetricRow {
  scenario: string;
  label: string;
  modelId: string;
  modelLabel: string;
  split: "ALL" | "OOS";
  market: "ALL" | "KOSPI" | "KOSDAQ";
  priceLeadershipOverheatThreshold: number | null;
  entryThreshold: number;
  entryScore10: number;
  upsideExitThreshold: number;
  upsideExitScore10: number;
  downsideExitThreshold: number;
  downsideExitScore10: number;
  maxHoldingDays: number;
  trades: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  avgExcessReturn: number | null;
  medianExcessReturn: number | null;
  excessWinRate: number | null;
  payoff: number | null;
  profitFactor: number | null;
  averageHoldingDays: number | null;
  timeExitRate: number | null;
  upsideExitRate: number | null;
  downsideExitRate: number | null;
  avgSignalScore: number | null;
  avgBaseScore9p5: number | null;
  avgSectorPriceLeadership: number | null;
  penaltyAppliedRate: number | null;
  tradesWithSectorScoreRate: number | null;
  worstReturn: number | null;
  avgMae: number | null;
  avgMfe: number | null;
  portfolioTotalReturn: number | null;
  portfolioCagr: number | null;
  portfolioMdd: number | null;
  portfolioSharpe: number | null;
  activeDayRate: number | null;
  avgActivePositions: number | null;
  peakActivePositions: number;
}

export interface SectorPenaltyScoreModelSummary {
  modelId: string;
  modelLabel: string;
  priceLeadershipOverheatThreshold: number | null;
  scoredDays: number;
  penaltyAppliedDays: number;
  penaltyAppliedRate: number | null;
  avgBaseScore9p5: number | null;
  avgAdjustedScore10: number | null;
  avgSectorPriceLeadership: number | null;
}

export interface SectorPenaltyBacktestResult {
  version: typeof SECTOR_PENALTY_BACKTEST_VERSION;
  from: string;
  to: string;
  symbolCount: number;
  sectorCount: number;
  scoreMax: 10;
  sectorSlotPoints: 0.5;
  sectorPenaltyPoints: 0.5;
  defaultScenario: {
    entryThreshold: 75;
    entryScore10: 7.5;
    upsideExitThreshold: 90;
    upsideExitScore10: 9;
    downsideExitThreshold: 30;
    downsideExitScore10: 3;
    maxHoldingDays: 30;
    priceLeadershipOverheatThreshold: 80;
  };
  compared: {
    entryThresholds: number[];
    upsideExitThresholds: number[];
    downsideExitThresholds: number[];
    maxHoldingDays: number[];
    priceLeadershipOverheatThresholds: number[];
    includeNoPenaltyBaseline: boolean;
  };
  scoreModels: SectorPenaltyScoreModelSummary[];
  rows: SectorPenaltyMetricRow[];
  defaultRows: SectorPenaltyMetricRow[];
  bestRows: {
    allByAvgExcess: SectorPenaltyMetricRow | null;
    oosByAvgExcess: SectorPenaltyMetricRow | null;
    allBySharpe: SectorPenaltyMetricRow | null;
    oosBySharpe: SectorPenaltyMetricRow | null;
  };
  notes: string[];
}

type Market = "KOSPI" | "KOSDAQ";

interface Series extends StrategySeries {
  market: Market;
  sectorCode: string;
  sectorName: string;
  baseScores: Array<number | null>;
  sectorPriceLeadership: Array<number | null>;
  sectorOverheated: Array<boolean | null>;
}

interface PreparedInstrument {
  instrument: Instrument;
  bars: DailyPrice[];
  dateIndex: Map<string, number>;
  closePrefix: number[];
  turnoverPrefix: number[];
  rollingHigh250: number[];
}

interface Agg {
  sectorCode: string;
  sectorName: string;
  r20: number[];
  r60: number[];
  r120: number[];
  turnover5: number;
  turnover20: number;
  turnover5Count: number;
  turnover20Count: number;
  aboveMa20True: number;
  aboveMa20Valid: number;
  aboveMa60True: number;
  aboveMa60Valid: number;
  aboveMa120True: number;
  aboveMa120Valid: number;
  maAlignedTrue: number;
  maAlignedValid: number;
  nearHighTrue: number;
  nearHighValid: number;
  advancingTrue: number;
  advancingValid: number;
}

interface RawSectorRow {
  sectorCode: string;
  rs20: number | null;
  rs60: number | null;
  rs120: number | null;
  relativeTurnover: number | null;
  advancing: number | null;
  aboveMa20: number | null;
  aboveMa60: number | null;
  aboveMa120: number | null;
  maAligned: number | null;
  nearHigh: number | null;
}

const finite = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(v);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const lo = Math.floor((s.length - 1) / 2);
  const hi = Math.ceil((s.length - 1) / 2);
  return (s[lo]! + s[hi]!) / 2;
}

function pct<T>(xs: T[], pick: (x: T) => boolean) {
  return xs.length ? (xs.filter(pick).length / xs.length) * 100 : null;
}

function periodReturn(bars: DailyPrice[], endIndex: number, period: number) {
  const past = bars[endIndex - period]?.close;
  const current = bars[endIndex]?.close;
  return finite(past) && finite(current) && past > 0 ? current / past - 1 : null;
}

function prefix(values: number[]) {
  const out = new Array<number>(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) out[i + 1] = out[i]! + values[i]!;
  return out;
}

function windowSum(sum: number[], endIndex: number, period: number) {
  const start = endIndex - period + 1;
  return start < 0 ? null : sum[endIndex + 1]! - sum[start]!;
}

function rollingHigh(bars: DailyPrice[], window = 250, minimum = 60) {
  const out = new Array<number>(bars.length).fill(Number.NaN);
  const deque: number[] = [];
  let head = 0;
  for (let i = 0; i < bars.length; i++) {
    while (head < deque.length && deque[head]! < i - window + 1) head++;
    while (deque.length > head && bars[deque[deque.length - 1]!]!.high <= bars[i]!.high) deque.pop();
    deque.push(i);
    if (i >= minimum - 1) out[i] = bars[deque[head]!]!.high;
    if (head > 256 && head * 2 > deque.length) {
      deque.splice(0, head);
      head = 0;
    }
  }
  return out;
}

function percentileRatio(sortedAsc: number[], value: number | null) {
  if (!finite(value) || sortedAsc.length === 0) return null;
  let below = 0;
  for (const x of sortedAsc) if (x < value) below++;
  return below / sortedAsc.length;
}

function ratio(trueCount: number, validCount: number) {
  return validCount ? (trueCount / validCount) * 100 : null;
}

function avgRatio(values: Array<number | null>) {
  const valid = values.filter(finite).map((v) => v / 100);
  return mean(valid);
}

function combine(parts: Array<{ weight: number; ratio: number | null }>) {
  const available = parts.filter((p) => finite(p.ratio));
  const weight = available.reduce((sum, p) => sum + p.weight, 0);
  return weight ? (available.reduce((sum, p) => sum + p.weight * (p.ratio ?? 0), 0) / weight) * 100 : null;
}

function addBool(
  agg: Agg,
  key: "aboveMa20" | "aboveMa60" | "aboveMa120" | "maAligned" | "nearHigh" | "advancing",
  value: boolean | null,
) {
  if (value === null) return;
  (agg[`${key}True` as keyof Agg] as number) += value ? 1 : 0;
  (agg[`${key}Valid` as keyof Agg] as number) += 1;
}

function createAgg(code: string, name: string): Agg {
  return {
    sectorCode: code,
    sectorName: name,
    r20: [],
    r60: [],
    r120: [],
    turnover5: 0,
    turnover20: 0,
    turnover5Count: 0,
    turnover20Count: 0,
    aboveMa20True: 0,
    aboveMa20Valid: 0,
    aboveMa60True: 0,
    aboveMa60Valid: 0,
    aboveMa120True: 0,
    aboveMa120Valid: 0,
    maAlignedTrue: 0,
    maAlignedValid: 0,
    nearHighTrue: 0,
    nearHighValid: 0,
    advancingTrue: 0,
    advancingValid: 0,
  };
}

function prepare(instrument: Instrument, bars: DailyPrice[]): PreparedInstrument {
  return {
    instrument,
    bars,
    dateIndex: new Map(bars.map((bar, i) => [bar.tradeDate, i])),
    closePrefix: prefix(bars.map((bar) => bar.close)),
    turnoverPrefix: prefix(bars.map((bar) => bar.tradingValue)),
    rollingHigh250: rollingHigh(bars),
  };
}

function buildSectorPriceLeadershipMap(dataset: MarketDataset) {
  const kospi = dataset.indexSeries.find((s) => s.indexCode === "KOSPI");
  if (!kospi || kospi.bars.length < 130) return new Map<string, number>();
  const sectorNames = new Map(dataset.sectors.map((s) => [s.code, s.name]));
  const prepared = dataset.instruments
    .filter(
      (inst) =>
        inst.instrumentType === "STOCK" &&
        inst.isActive &&
        inst.sectorCode !== "MARKET_IDX" &&
        inst.sectorCode !== "ETC",
    )
    .map((inst) => prepare(inst, dataset.bars[inst.symbol] ?? []))
    .filter((item) => item.bars.length >= 130);
  const byDateSector = new Map<string, number>();

  for (let marketIndex = 120; marketIndex < kospi.bars.length; marketIndex++) {
    const date = kospi.bars[marketIndex]!.tradeDate;
    const mr20 = periodReturn(kospi.bars, marketIndex, 20);
    const mr60 = periodReturn(kospi.bars, marketIndex, 60);
    const mr120 = periodReturn(kospi.bars, marketIndex, 120);
    const aggs = new Map<string, Agg>();

    for (const item of prepared) {
      const i = item.dateIndex.get(date);
      if (i === undefined || i < 120) continue;
      const bar = item.bars[i]!;
      const prev = item.bars[i - 1];
      if (!prev) continue;
      const ma = (period: number) => {
        const v = windowSum(item.closePrefix, i, period);
        return v === null ? null : v / period;
      };
      const tv = (period: number) => {
        const v = windowSum(item.turnoverPrefix, i, period);
        return v === null ? null : v / period;
      };
      const ma20 = ma(20);
      const ma60 = ma(60);
      const ma120 = ma(120);
      const tv5 = tv(5);
      const tv20 = tv(20);
      const code = item.instrument.sectorCode;
      const agg = aggs.get(code) ?? createAgg(code, sectorNames.get(code) ?? item.instrument.sectorName);
      const r20 = periodReturn(item.bars, i, 20);
      const r60 = periodReturn(item.bars, i, 60);
      const r120 = periodReturn(item.bars, i, 120);
      if (finite(r20)) agg.r20.push(r20);
      if (finite(r60)) agg.r60.push(r60);
      if (finite(r120)) agg.r120.push(r120);
      if (finite(tv5)) {
        agg.turnover5 += tv5;
        agg.turnover5Count++;
      }
      if (finite(tv20)) {
        agg.turnover20 += tv20;
        agg.turnover20Count++;
      }
      addBool(agg, "aboveMa20", ma20 === null ? null : bar.close > ma20);
      addBool(agg, "aboveMa60", ma60 === null ? null : bar.close > ma60);
      addBool(agg, "aboveMa120", ma120 === null ? null : bar.close > ma120);
      addBool(agg, "maAligned", ma20 === null || ma60 === null || ma120 === null ? null : ma20 > ma60 && ma60 > ma120);
      addBool(
        agg,
        "nearHigh",
        Number.isFinite(item.rollingHigh250[i]) ? bar.close >= item.rollingHigh250[i]! * 0.95 : null,
      );
      addBool(agg, "advancing", bar.close > prev.close);
      aggs.set(code, agg);
    }

    const raw: RawSectorRow[] = [...aggs.values()].map((agg) => {
      const eq20 = median(agg.r20);
      const eq60 = median(agg.r60);
      const eq120 = median(agg.r120);
      return {
        sectorCode: agg.sectorCode,
        rs20: finite(eq20) && finite(mr20) ? (eq20 - mr20) * 100 : null,
        rs60: finite(eq60) && finite(mr60) ? (eq60 - mr60) * 100 : null,
        rs120: finite(eq120) && finite(mr120) ? (eq120 - mr120) * 100 : null,
        relativeTurnover:
          agg.turnover20Count > 0 && agg.turnover5Count > 0 && agg.turnover20 > 0
            ? agg.turnover5 / agg.turnover20
            : null,
        advancing: ratio(agg.advancingTrue, agg.advancingValid),
        aboveMa20: ratio(agg.aboveMa20True, agg.aboveMa20Valid),
        aboveMa60: ratio(agg.aboveMa60True, agg.aboveMa60Valid),
        aboveMa120: ratio(agg.aboveMa120True, agg.aboveMa120Valid),
        maAligned: ratio(agg.maAlignedTrue, agg.maAlignedValid),
        nearHigh: ratio(agg.nearHighTrue, agg.nearHighValid),
      };
    });
    const rs20s = raw.map((r) => r.rs20).filter(finite).sort((a, b) => a - b);
    const rs60s = raw.map((r) => r.rs60).filter(finite).sort((a, b) => a - b);
    const rs120s = raw.map((r) => r.rs120).filter(finite).sort((a, b) => a - b);
    for (const r of raw) {
      const trend = avgRatio([r.aboveMa20, r.aboveMa60, r.aboveMa120]);
      const breadth = avgRatio([r.advancing, r.aboveMa20, r.maAligned]);
      const price = combine([
        { weight: 20, ratio: percentileRatio(rs20s, r.rs20) },
        { weight: 20, ratio: percentileRatio(rs60s, r.rs60) },
        { weight: 10, ratio: percentileRatio(rs120s, r.rs120) },
        { weight: 15, ratio: trend },
        { weight: 20, ratio: breadth },
        { weight: 10, ratio: r.nearHigh === null ? null : r.nearHigh / 100 },
        {
          weight: 5,
          ratio:
            r.relativeTurnover === null
              ? null
              : Math.min(1, Math.max(0, (r.relativeTurnover - 0.7) / 0.8)),
        },
      ]);
      if (finite(price)) byDateSector.set(`${date}|${r.sectorCode}`, price);
    }
  }
  return byDateSector;
}

function normalize(values: number[] | undefined, fallback: number[]) {
  return [...new Set((values ?? fallback).map((v) => Math.round(v)).filter((v) => v >= 0 && v <= 100))].sort((a, b) => a - b);
}

function normalizeDays(values: number[] | undefined, fallback: number[]) {
  return [...new Set((values ?? fallback).map((v) => Math.round(v)).filter((v) => v >= 1 && v <= 252))].sort((a, b) => a - b);
}

function percent(score: number | null | undefined) {
  return finite(score) ? (score / SCORE_MAX) * 100 : null;
}

function crossedUp(prev: number | null | undefined, cur: number | null | undefined, threshold: number) {
  const p = percent(prev);
  const c = percent(cur);
  return p !== null && c !== null && p < threshold && c >= threshold;
}

function crossedDown(prev: number | null | undefined, cur: number | null | undefined, threshold: number) {
  const p = percent(prev);
  const c = percent(cur);
  return p !== null && c !== null && p >= threshold && c < threshold;
}

function scoreRise(s: Series, i: number, lag: number) {
  const c = percent(s.scores[i]);
  const p = percent(s.scores[i - lag]);
  return c !== null && p !== null ? c - p : null;
}

function excursion(
  s: Series,
  entryIndex: number,
  exitIndex: number,
  entryPrice: number,
  exitPrice: number,
  timing: "OPEN" | "CLOSE" | "STOP",
) {
  let low = entryPrice;
  let high = entryPrice;
  for (let i = entryIndex; i <= exitIndex; i++) {
    const bar = s.bars[i];
    if (!bar) break;
    if (i === exitIndex && timing !== "CLOSE") {
      low = Math.min(low, exitPrice);
      high = Math.max(high, exitPrice);
      continue;
    }
    if (Number.isFinite(bar.low) && bar.low > 0) low = Math.min(low, bar.low);
    if (Number.isFinite(bar.high) && bar.high > 0) high = Math.max(high, bar.high);
  }
  return {
    mae: entryPrice > 0 ? (low / entryPrice - 1) * 100 : null,
    mfe: entryPrice > 0 ? (high / entryPrice - 1) * 100 : null,
  };
}

function benchmarkReturn(
  bench: Map<string, DailyPrice> | undefined,
  entryDate: string,
  exitDate: string,
  timing: "OPEN" | "CLOSE" | "STOP",
) {
  const entry = bench?.get(entryDate);
  const exit = bench?.get(exitDate);
  if (!entry || !exit || !finite(entry.open) || entry.open <= 0) return null;
  const exitPrice = timing === "OPEN" ? exit.open : exit.close;
  return finite(exitPrice) && exitPrice > 0 ? (exitPrice / entry.open - 1) * 100 : null;
}

function makeTrade(
  s: Series,
  scenario: SectorPenaltyScenario,
  signalIndex: number,
  entryIndex: number,
  exitIndex: number,
  entryPrice: number,
  exitPrice: number,
  reason: V6ExitReason,
  timing: "OPEN" | "CLOSE" | "STOP",
  costBps: number,
  bench: Map<string, DailyPrice> | undefined,
): SectorPenaltyTrade {
  const entryDate = s.bars[entryIndex]!.tradeDate;
  const exitDate = s.bars[exitIndex]!.tradeDate;
  const ret = (exitPrice / entryPrice - 1) * 100 - Math.max(0, costBps) / 100;
  const br = benchmarkReturn(bench, entryDate, exitDate, timing);
  const ex = excursion(s, entryIndex, exitIndex, entryPrice, exitPrice, timing);
  return {
    symbol: s.symbol,
    ...(s.name !== undefined ? { name: s.name } : {}),
    market: s.market,
    signalDate: s.bars[signalIndex]!.tradeDate,
    entryDate,
    exitDate,
    signalIndex,
    entryIndex,
    exitIndex,
    entryPrice,
    exitPrice,
    ret,
    holdingDays: exitIndex - entryIndex + 1,
    reason,
    exitTiming: timing,
    signalScore: percent(s.scores[signalIndex]) ?? 0,
    scoreChange1d: scoreRise(s, signalIndex, 1),
    scoreRise5d: scoreRise(s, signalIndex, 5),
    scoreRise10d: scoreRise(s, signalIndex, 10),
    signalRegime: s.regimes[signalIndex] ?? "UNKNOWN",
    mae: ex.mae,
    mfe: ex.mfe,
    modelId: scenario.modelId,
    priceLeadershipOverheatThreshold: scenario.priceLeadershipOverheatThreshold,
    baseScore9p5: s.baseScores[signalIndex] ?? null,
    adjustedScore10: s.scores[signalIndex]!,
    sectorCode: s.sectorCode,
    sectorName: s.sectorName,
    sectorPriceLeadership: s.sectorPriceLeadership[signalIndex] ?? null,
    sectorOverheated: s.sectorOverheated[signalIndex] ?? null,
    sectorPenaltyApplied: s.sectorOverheated[signalIndex] === true,
    benchmarkReturn: br,
    excessReturn: br === null ? null : ret - br,
  };
}

function passesEntry(s: Series, i: number, scenario: SectorPenaltyScenario) {
  if (!crossedUp(s.scores[i - 1], s.scores[i], scenario.entryThreshold)) return false;
  const cur = percent(s.scores[i]);
  return cur !== null && cur < scenario.upsideExitThreshold;
}

function simulateTrade(
  s: Series,
  signalIndex: number,
  scenario: SectorPenaltyScenario,
  costBps: number,
  bench: Map<string, DailyPrice> | undefined,
) {
  const entryIndex = signalIndex + 1;
  const plannedExit = signalIndex + scenario.maxHoldingDays;
  const entry = s.bars[entryIndex];
  if (!entry || !finite(entry.open) || entry.open <= 0 || percent(s.scores[signalIndex]) === null) return null;
  for (let j = entryIndex; j <= Math.min(plannedExit, s.bars.length - 1); j++) {
    const bar = s.bars[j]!;
    if (![bar.open, bar.close, bar.low, bar.high].every((v) => finite(v) && v > 0)) return null;
    if (j > entryIndex) {
      const scoreIndex = j - 1;
      if (crossedDown(s.scores[scoreIndex - 1], s.scores[scoreIndex], scenario.downsideExitThreshold)) {
        return makeTrade(s, scenario, signalIndex, entryIndex, j, entry.open, bar.open, "DOWNSIDE_SCORE", "OPEN", costBps, bench);
      }
      if (crossedUp(s.scores[scoreIndex - 1], s.scores[scoreIndex], scenario.upsideExitThreshold)) {
        return makeTrade(s, scenario, signalIndex, entryIndex, j, entry.open, bar.open, "UPSIDE_SCORE", "OPEN", costBps, bench);
      }
    }
    if (j === plannedExit) {
      return makeTrade(s, scenario, signalIndex, entryIndex, j, entry.open, bar.close, "TIME", "CLOSE", costBps, bench);
    }
  }
  return null;
}

function simulateScenario(
  s: Series,
  scenario: SectorPenaltyScenario,
  costBps: number,
  benchmarks: Record<Market, Map<string, DailyPrice> | undefined>,
) {
  const trades: SectorPenaltyTrade[] = [];
  let nextSignalIndex = 0;
  for (let i = 1; i + 1 < s.bars.length; i++) {
    if (i < nextSignalIndex || !passesEntry(s, i, scenario)) continue;
    const trade = simulateTrade(s, i, scenario, costBps, benchmarks[s.market]);
    if (trade) {
      trades.push(trade);
      nextSignalIndex = trade.exitIndex + 1;
    }
  }
  return trades;
}

function scenariosFor(
  modelId: string,
  modelLabel: string,
  threshold: number | null,
  entries: number[],
  ups: number[],
  downs: number[],
  holds: number[],
) {
  return entries.flatMap((entry) =>
    holds.flatMap((hold) =>
      ups.flatMap((up) =>
        downs.map(
          (down): SectorPenaltyScenario => ({
            id: `${modelId}-e${entry}-h${hold}-u${up}-d${down}`,
            label: `${modelLabel} · ${entry} Onset · 최대 ${hold}D · ↑${up} / ↓${down}`,
            modelId,
            modelLabel,
            priceLeadershipOverheatThreshold: threshold,
            entryThreshold: entry,
            upsideExitThreshold: up,
            downsideExitThreshold: down,
            maxHoldingDays: hold,
          }),
        ),
      ),
    ),
  );
}

function baseSeries(dataset: MarketDataset, limit: number): Series[] {
  return [...dataset.instruments]
    .filter((inst) => inst.instrumentType === "STOCK")
    .sort((a, b) => (dataset.bars[b.symbol]?.at(-1)?.tradingValue ?? 0) - (dataset.bars[a.symbol]?.at(-1)?.tradingValue ?? 0))
    .slice(0, limit)
    .map((inst): Series | null => {
      const bars = dataset.bars[inst.symbol] ?? [];
      if (bars.length < 130) return null;
      const scores = new Array<number | null>(bars.length).fill(null);
      const baseScores = new Array<number | null>(bars.length).fill(null);
      const nearHighs = new Array<boolean | null>(bars.length).fill(null);
      const extensions = new Array<number | null>(bars.length).fill(null);
      for (let i = 120; i < bars.length; i++) {
        const snap = computeIndicators(bars, i);
        const score = historicalTechnicalScore(snap).points;
        scores[i] = score;
        baseScores[i] = score;
        nearHighs[i] = snap.distanceFrom52wHigh === null ? null : snap.distanceFrom52wHigh >= -10;
        extensions[i] = snap.extensionFromMa20;
      }
      return {
        symbol: inst.symbol,
        name: inst.name,
        market: inst.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI",
        sectorCode: inst.sectorCode,
        sectorName: inst.sectorName,
        bars,
        scores,
        baseScores,
        nearHighs,
        extensions,
        regimes: bars.map(() => "UNKNOWN"),
        sectorPriceLeadership: new Array<number | null>(bars.length).fill(null),
        sectorOverheated: new Array<boolean | null>(bars.length).fill(null),
      };
    })
    .filter((s): s is Series => s !== null);
}

function applyModel(source: Series[], sectorPriceByDate: Map<string, number>, threshold: number | null) {
  const modelId = threshold === null ? "base10-no-penalty" : `sector-penalty-pl${threshold}`;
  const modelLabel = threshold === null ? "10점 baseline(페널티 없음)" : `PL≥${threshold} 과열 페널티`;
  let scoredDays = 0;
  let penaltyAppliedDays = 0;
  const bases: number[] = [];
  const adjusted: number[] = [];
  const sectorScores: number[] = [];
  const series = source.map((s): Series => {
    const scores = new Array<number | null>(s.scores.length).fill(null);
    const sectorPriceLeadership = new Array<number | null>(s.scores.length).fill(null);
    const sectorOverheated = new Array<boolean | null>(s.scores.length).fill(null);
    for (let i = 0; i < s.scores.length; i++) {
      const base = s.baseScores[i];
      if (base === null || base === undefined) continue;
      const date = s.bars[i]?.tradeDate;
      const pl = date ? sectorPriceByDate.get(`${date}|${s.sectorCode}`) ?? null : null;
      const sectorAdjusted = adjustSectorPenaltyScore(base, pl, threshold);
      scores[i] = sectorAdjusted.score;
      sectorPriceLeadership[i] = pl;
      sectorOverheated[i] = sectorAdjusted.overheated;
      scoredDays++;
      if (sectorAdjusted.penaltyApplied) penaltyAppliedDays++;
      bases.push(base);
      adjusted.push(scores[i]!);
      if (pl !== null) sectorScores.push(pl);
    }
    return { ...s, scores, sectorPriceLeadership, sectorOverheated };
  });
  return {
    series,
    summary: {
      modelId,
      modelLabel,
      priceLeadershipOverheatThreshold: threshold,
      scoredDays,
      penaltyAppliedDays,
      penaltyAppliedRate: scoredDays ? (penaltyAppliedDays / scoredDays) * 100 : null,
      avgBaseScore9p5: mean(bases),
      avgAdjustedScore10: mean(adjusted),
      avgSectorPriceLeadership: mean(sectorScores),
    },
  };
}

function filterTrades(
  trades: SectorPenaltyTrade[],
  split: "ALL" | "OOS",
  market: "ALL" | Market,
  oosStart: string | null,
) {
  return trades.filter(
    (t) =>
      (split === "ALL" || (oosStart !== null && t.signalDate >= oosStart)) &&
      (market === "ALL" || t.market === market),
  );
}

function summarize(
  scenario: SectorPenaltyScenario,
  trades: SectorPenaltyTrade[],
  split: "ALL" | "OOS",
  market: "ALL" | Market,
): SectorPenaltyMetricRow {
  const returns = trades.map((t) => t.ret);
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  const excess = trades.map((t) => t.excessReturn).filter(finite);
  const excessWins = excess.filter((r) => r > 0);
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  const lossSum = losses.reduce((a, b) => a + b, 0);
  const winSum = wins.reduce((a, b) => a + b, 0);
  return {
    scenario: scenario.id,
    label: scenario.label,
    modelId: scenario.modelId,
    modelLabel: scenario.modelLabel,
    split,
    market,
    priceLeadershipOverheatThreshold: scenario.priceLeadershipOverheatThreshold,
    entryThreshold: scenario.entryThreshold,
    entryScore10: scenario.entryThreshold / 10,
    upsideExitThreshold: scenario.upsideExitThreshold,
    upsideExitScore10: scenario.upsideExitThreshold / 10,
    downsideExitThreshold: scenario.downsideExitThreshold,
    downsideExitScore10: scenario.downsideExitThreshold / 10,
    maxHoldingDays: scenario.maxHoldingDays,
    trades: trades.length,
    avgReturn: mean(returns),
    medianReturn: median(returns),
    winRate: trades.length ? (wins.length / trades.length) * 100 : null,
    avgExcessReturn: mean(excess),
    medianExcessReturn: median(excess),
    excessWinRate: excess.length ? (excessWins.length / excess.length) * 100 : null,
    payoff: avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null,
    profitFactor: lossSum < 0 ? winSum / -lossSum : null,
    averageHoldingDays: mean(trades.map((t) => t.holdingDays)),
    timeExitRate: pct(trades, (t) => t.reason === "TIME"),
    upsideExitRate: pct(trades, (t) => t.reason === "UPSIDE_SCORE"),
    downsideExitRate: pct(trades, (t) => t.reason === "DOWNSIDE_SCORE"),
    avgSignalScore: mean(trades.map((t) => t.signalScore)),
    avgBaseScore9p5: mean(trades.map((t) => t.baseScore9p5).filter(finite)),
    avgSectorPriceLeadership: mean(trades.map((t) => t.sectorPriceLeadership).filter(finite)),
    penaltyAppliedRate: pct(trades, (t) => t.sectorPenaltyApplied),
    tradesWithSectorScoreRate: pct(trades, (t) => t.sectorPriceLeadership !== null),
    worstReturn: returns.length ? Math.min(...returns) : null,
    avgMae: mean(trades.map((t) => t.mae).filter(finite)),
    avgMfe: mean(trades.map((t) => t.mfe).filter(finite)),
    portfolioTotalReturn: null,
    portfolioCagr: null,
    portfolioMdd: null,
    portfolioSharpe: null,
    activeDayRate: null,
    avgActivePositions: null,
    peakActivePositions: 0,
  };
}

function best(rows: SectorPenaltyMetricRow[], split: "ALL" | "OOS", metric: "avgExcessReturn" | "portfolioSharpe") {
  return rows
    .filter((r) => r.split === split && r.market === "ALL" && r.trades >= 20 && r[metric] !== null)
    .sort((a, b) => (b[metric] ?? -Infinity) - (a[metric] ?? -Infinity))[0] ?? null;
}

export function runSectorPenaltyBacktest(
  dataset: MarketDataset,
  options: SectorPenaltyBacktestOptions = {},
): SectorPenaltyBacktestResult | null {
  const limit = Math.max(1, Math.round(options.limit ?? 613));
  const cost = Math.max(0, options.roundTripCostBps ?? 0);
  const entries = normalize(options.entryThresholds, [65, 75]);
  const ups = normalize(options.upsideExitThresholds, [95, 90, 85]).sort((a, b) => b - a);
  const downs = normalize(options.downsideExitThresholds, [35, 30, 25]).sort((a, b) => b - a);
  const holds = normalizeDays(options.maxHoldingDays, [20, 30, 40]);
  const overheatThresholds = normalize(options.priceLeadershipOverheatThresholds, [70, 75, 80, 85]);
  const includeNoPenaltyBaseline = options.includeNoPenaltyBaseline ?? true;
  const source = baseSeries(dataset, limit);
  if (!source.length) return null;

  const sectorPriceByDate = buildSectorPriceLeadershipMap(dataset);
  const allDates = [...new Set(source.flatMap((s) => s.bars.map((b) => b.tradeDate)))].sort();
  const oosStart = allDates[Math.max(0, Math.floor(allDates.length * 0.8))] ?? null;
  const benchmarkMaps = {
    KOSPI: dataset.indexSeries.find((s) => s.indexCode === "KOSPI")?.bars
      ? new Map(dataset.indexSeries.find((s) => s.indexCode === "KOSPI")!.bars.map((b) => [b.tradeDate, b]))
      : undefined,
    KOSDAQ: dataset.indexSeries.find((s) => s.indexCode === "KOSDAQ")?.bars
      ? new Map(dataset.indexSeries.find((s) => s.indexCode === "KOSDAQ")!.bars.map((b) => [b.tradeDate, b]))
      : undefined,
  } as Record<Market, Map<string, DailyPrice> | undefined>;

  const scoreModels: SectorPenaltyScoreModelSummary[] = [];
  const rows: SectorPenaltyMetricRow[] = [];
  const thresholds: Array<number | null> = [
    ...(includeNoPenaltyBaseline ? [null] : []),
    ...overheatThresholds,
  ];

  for (const threshold of thresholds) {
    const { series, summary } = applyModel(source, sectorPriceByDate, threshold);
    scoreModels.push(summary);
    const scenarios = scenariosFor(summary.modelId, summary.modelLabel, threshold, entries, ups, downs, holds);
    for (const scenario of scenarios) {
      const trades = series.flatMap((s) => simulateScenario(s, scenario, cost, benchmarkMaps));
      for (const split of ["ALL", "OOS"] as const) {
        for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
          const group = filterTrades(trades, split, market, oosStart);
          rows.push(summarize(scenario, group, split, market));
        }
      }
    }
  }

  const defaultRows = rows.filter(
    (r) =>
      r.priceLeadershipOverheatThreshold === 80 &&
      r.entryThreshold === 75 &&
      r.upsideExitThreshold === 90 &&
      r.downsideExitThreshold === 30 &&
      r.maxHoldingDays === 30,
  );

  return {
    version: SECTOR_PENALTY_BACKTEST_VERSION,
    from: allDates[0] ?? "",
    to: allDates.at(-1) ?? "",
    symbolCount: source.length,
    sectorCount: new Set(source.map((s) => s.sectorCode)).size,
    scoreMax: 10,
    sectorSlotPoints: 0.5,
    sectorPenaltyPoints: 0.5,
    defaultScenario: {
      entryThreshold: 75,
      entryScore10: 7.5,
      upsideExitThreshold: 90,
      upsideExitScore10: 9,
      downsideExitThreshold: 30,
      downsideExitScore10: 3,
      maxHoldingDays: 30,
      priceLeadershipOverheatThreshold: 80,
    },
    compared: {
      entryThresholds: entries,
      upsideExitThresholds: ups,
      downsideExitThresholds: downs,
      maxHoldingDays: holds,
      priceLeadershipOverheatThresholds: overheatThresholds,
      includeNoPenaltyBaseline,
    },
    scoreModels,
    rows,
    defaultRows,
    bestRows: {
      allByAvgExcess: best(rows, "ALL", "avgExcessReturn"),
      oosByAvgExcess: best(rows, "OOS", "avgExcessReturn"),
      allBySharpe: best(rows, "ALL", "portfolioSharpe"),
      oosBySharpe: best(rows, "OOS", "portfolioSharpe"),
    },
    notes: [
      "V8은 기존 Vf 9.5점에 섹터 Price Leadership이 존재하는 날에만 기본 슬롯 0.5점을 더해 10점 만점으로 전환하고, 같은 날짜의 섹터 Price Leadership이 과열 기준 이상이면 그 0.5점을 제거한다. 섹터 Price Leadership이 없으면 Vf 9.5점 base를 그대로 사용한다.",
      "기본 전략은 75 Onset 진입, 상승청산 90, 하락청산 30, 최대보유 30영업일, 가격손절 없음이다.",
      "비교 조합은 65/75 Onset, 상승청산 95/90/85, 하락청산 35/30/25, 최대보유 20/30/40영업일이다.",
      "섹터 과열 기준은 Price Leadership 70/75/80/85를 모두 비교하고, 페널티 없는 10점 baseline도 함께 계산한다. baseline 역시 PL이 없는 날에는 0.5점 슬롯을 부여하지 않는다.",
      "진입/청산은 기존 V6 방식과 동일하게 신호일 종가 기준 점수 교차를 확인하고 다음 거래일 시가에 진입/점수청산한다. 최대보유 청산은 계획 만기일 종가 기준이다.",
      "전략 조합 비교 속도를 위해 이번 V8 산출물의 포트폴리오 복리 지표는 null로 두고, 거래별 수익률·초과수익률·손익비·보유기간·청산사유 중심으로 비교한다.",
    ],
  };
}
