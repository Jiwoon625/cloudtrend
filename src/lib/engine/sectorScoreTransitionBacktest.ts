import type { MarketDataset } from "./dataset";
import { DEFAULT_ROTATION_WEIGHTS } from "./sectorRotation";
import { buildFullUniverseSectorDataset } from "./sectorRotationFullUniverse";
import { THEME_SECTORS } from "./sectors";
import type { DailyPrice, Instrument } from "./types";

export type SectorScoreKind = "PRICE" | "FLOW" | "MOMENTUM" | "ROTATION";
export type TransitionDirection = "UP" | "DOWN";

export interface ScoreBucketDefinition {
  label: string;
  min: number;
  max: number;
  inclusiveMax: boolean;
}

export interface ForwardPerformanceStat {
  horizon: number;
  observations: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  avgExcessReturn: number | null;
  medianExcessReturn: number | null;
  excessWinRate: number | null;
}

export interface ScoreBandTransitionStat {
  kind: SectorScoreKind;
  fromBand: string;
  toBand: string;
  direction: TransitionDirection;
  observations: number;
  uniqueSectors: number;
  avgPrevScore: number | null;
  avgCurrentScore: number | null;
  avgScoreDelta: number | null;
  medianScoreDelta: number | null;
  fromTop4Rate: number | null;
  toTop4Rate: number | null;
  forwardPerformance: ForwardPerformanceStat[];
}

export interface TransitionMatrixCell {
  kind: SectorScoreKind;
  fromBand: string;
  toBand: string;
  direction: TransitionDirection;
  observations: number;
  shareOfFromBandTransitions: number | null;
}

export interface TransitionSignalStat {
  kind: SectorScoreKind;
  signalId: string;
  label: string;
  observations: number;
  uniqueSectors: number;
  avgScoreDelta: number | null;
  medianScoreDelta: number | null;
  toTop4Rate: number | null;
  forwardPerformance: ForwardPerformanceStat[];
}

export interface ScoreTransitionFamilyDiagnostic {
  kind: SectorScoreKind;
  label: string;
  transitionStats: ScoreBandTransitionStat[];
  transitionMatrix: TransitionMatrixCell[];
  signalStats: TransitionSignalStat[];
}

export interface SectorScoreTransitionBacktestResult {
  version: "CloudTrend V7.3";
  from: string;
  to: string;
  tradingDays: number;
  sectorCount: number;
  scoreBuckets: ScoreBucketDefinition[];
  families: ScoreTransitionFamilyDiagnostic[];
  notes: string[];
}

interface PreparedInstrument {
  instrument: Instrument;
  bars: DailyPrice[];
  dateIndex: Map<string, number>;
  closePrefix: number[];
  turnoverPrefix: number[];
  foreignPrefix: number[];
  foreignMissingPrefix: number[];
  institutionPrefix: number[];
  institutionMissingPrefix: number[];
  rollingHigh250: number[];
}

interface MemberMetric {
  r20: number | null;
  r60: number | null;
  r120: number | null;
  turnover5: number | null;
  turnover20: number | null;
  aboveMa20: boolean | null;
  aboveMa60: boolean | null;
  aboveMa120: boolean | null;
  maAligned: boolean | null;
  nearHigh: boolean | null;
  advancing: boolean | null;
  foreign5: number | null;
  institution5: number | null;
}

interface SectorAggregate {
  sectorCode: string;
  sectorName: string;
  memberCount: number;
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
  foreign5Sum: number;
  foreign5Valid: number;
  institution5Sum: number;
  institution5Valid: number;
  bothBuyTrue: number;
  bothBuyValid: number;
}

interface RawSectorDay {
  sectorCode: string;
  sectorName: string;
  rs20: number | null;
  rs60: number | null;
  rs120: number | null;
  turnoverShare5: number;
  turnoverShare20: number;
  relativeTurnover: number | null;
  advancing: number | null;
  aboveMa20: number | null;
  aboveMa60: number | null;
  aboveMa120: number | null;
  maAligned: number | null;
  nearHigh: number | null;
  bothBuy5: number | null;
  foreign5: number | null;
  institution5: number | null;
  turnover20Total: number | null;
}

interface LevelScore {
  sectorCode: string;
  sectorName: string;
  price: number | null;
  flow: number | null;
  momentum: number | null;
  rotation: number | null;
  turnoverShareDiff: number;
  bothBuy5: number | null;
  foreign5: number | null;
  institution5: number | null;
}

interface RankedSector {
  sectorCode: string;
  sectorName: string;
  score: number;
  rank: number;
}

interface DailyRanking {
  date: string;
  marketIndex: number;
  byKind: Record<SectorScoreKind, RankedSector[]>;
}

interface ReturnSample {
  returnValue: number;
  excessReturn: number;
}

interface TransitionEvent {
  kind: SectorScoreKind;
  sectorCode: string;
  sectorName: string;
  marketIndex: number;
  fromBand: ScoreBucketDefinition;
  toBand: ScoreBucketDefinition;
  direction: TransitionDirection;
  prevScore: number;
  currentScore: number;
  prevRank: number;
  currentRank: number;
  forward: Record<number, ReturnSample | null>;
}

const MIN_LEVEL_INDEX = 120;
const MOMENTUM_LOOKBACK = 5;
const TOP_MAX_RANK = 4;
const HORIZONS = [5, 10, 20, 40];
const SCORE_KINDS: SectorScoreKind[] = ["PRICE", "FLOW", "MOMENTUM", "ROTATION"];
const SCORE_BUCKETS: ScoreBucketDefinition[] = [
  { label: "0~20", min: 0, max: 20, inclusiveMax: false },
  { label: "20~40", min: 20, max: 40, inclusiveMax: false },
  { label: "40~60", min: 40, max: 60, inclusiveMax: false },
  { label: "60~70", min: 60, max: 70, inclusiveMax: false },
  { label: "70~80", min: 70, max: 80, inclusiveMax: false },
  { label: "80~90", min: 80, max: 90, inclusiveMax: false },
  { label: "90~100", min: 90, max: 100, inclusiveMax: true },
];

const KIND_LABEL: Record<SectorScoreKind, string> = {
  PRICE: "Price Leadership",
  FLOW: "Money Flow",
  MOMENTUM: "Rotation Momentum",
  ROTATION: "Rotation Score",
};

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const position = ((sorted.length - 1) * percentile) / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function prefix(values: number[]): number[] {
  const out = new Array<number>(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) out[i + 1] = out[i]! + values[i]!;
  return out;
}

function nullablePrefix(values: Array<number | null>): { sum: number[]; missing: number[] } {
  const sum = new Array<number>(values.length + 1).fill(0);
  const missing = new Array<number>(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    sum[i + 1] = sum[i]! + (finite(value) ? value : 0);
    missing[i + 1] = missing[i]! + (finite(value) ? 0 : 1);
  }
  return { sum, missing };
}

function windowSum(sum: number[], endIndex: number, period: number): number | null {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  return sum[endIndex + 1]! - sum[start]!;
}

function nullableWindowSum(
  sum: number[],
  missing: number[],
  endIndex: number,
  period: number,
): number | null {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  if (missing[endIndex + 1]! - missing[start]! > 0) return null;
  return sum[endIndex + 1]! - sum[start]!;
}

function rollingHigh(bars: DailyPrice[], window = 250, minimum = 60): number[] {
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

function prepareInstrument(instrument: Instrument, bars: DailyPrice[]): PreparedInstrument {
  const foreign = nullablePrefix(bars.map((bar) => bar.foreignNetBuyValue));
  const institution = nullablePrefix(bars.map((bar) => bar.institutionNetBuyValue));
  return {
    instrument,
    bars,
    dateIndex: new Map(bars.map((bar, index) => [bar.tradeDate, index])),
    closePrefix: prefix(bars.map((bar) => bar.close)),
    turnoverPrefix: prefix(bars.map((bar) => bar.tradingValue)),
    foreignPrefix: foreign.sum,
    foreignMissingPrefix: foreign.missing,
    institutionPrefix: institution.sum,
    institutionMissingPrefix: institution.missing,
    rollingHigh250: rollingHigh(bars),
  };
}

function periodReturn(bars: DailyPrice[], endIndex: number, period: number): number | null {
  const past = bars[endIndex - period]?.close;
  const current = bars[endIndex]?.close;
  if (!finite(past) || !finite(current) || past === 0) return null;
  return current / past - 1;
}

function forwardReturn(bars: DailyPrice[], startIndex: number, horizon: number): number | null {
  const start = bars[startIndex]?.close;
  const end = bars[startIndex + horizon]?.close;
  if (!finite(start) || !finite(end) || start === 0) return null;
  return end / start - 1;
}

function memberMetric(prepared: PreparedInstrument, date: string): MemberMetric | null {
  const index = prepared.dateIndex.get(date);
  if (index === undefined || index < 1) return null;
  const bar = prepared.bars[index]!;
  const avg = (period: number) => {
    const value = windowSum(prepared.closePrefix, index, period);
    return value === null ? null : value / period;
  };
  const turnoverAvg = (period: number) => {
    const value = windowSum(prepared.turnoverPrefix, index, period);
    return value === null ? null : value / period;
  };
  const ma20 = avg(20);
  const ma60 = avg(60);
  const ma120 = avg(120);
  const high = prepared.rollingHigh250[index];
  return {
    r20: periodReturn(prepared.bars, index, 20),
    r60: periodReturn(prepared.bars, index, 60),
    r120: periodReturn(prepared.bars, index, 120),
    turnover5: turnoverAvg(5),
    turnover20: turnoverAvg(20),
    aboveMa20: ma20 === null ? null : bar.close > ma20,
    aboveMa60: ma60 === null ? null : bar.close > ma60,
    aboveMa120: ma120 === null ? null : bar.close > ma120,
    maAligned: ma20 === null || ma60 === null || ma120 === null ? null : ma20 > ma60 && ma60 > ma120,
    nearHigh: Number.isFinite(high) ? bar.close >= high * 0.95 : null,
    advancing: bar.close > prepared.bars[index - 1]!.close,
    foreign5: nullableWindowSum(prepared.foreignPrefix, prepared.foreignMissingPrefix, index, 5),
    institution5: nullableWindowSum(
      prepared.institutionPrefix,
      prepared.institutionMissingPrefix,
      index,
      5,
    ),
  };
}

function ratio(trueCount: number, validCount: number): number | null {
  return validCount ? (trueCount / validCount) * 100 : null;
}

function addBoolean(
  value: boolean | null,
  aggregate: SectorAggregate,
  key: "aboveMa20" | "aboveMa60" | "aboveMa120" | "maAligned" | "nearHigh" | "advancing",
) {
  if (value === null) return;
  const trueKey = `${key}True` as keyof SectorAggregate;
  const validKey = `${key}Valid` as keyof SectorAggregate;
  (aggregate[trueKey] as number) += value ? 1 : 0;
  (aggregate[validKey] as number) += 1;
}

function createAggregate(code: string, name: string): SectorAggregate {
  return {
    sectorCode: code,
    sectorName: name,
    memberCount: 0,
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
    foreign5Sum: 0,
    foreign5Valid: 0,
    institution5Sum: 0,
    institution5Valid: 0,
    bothBuyTrue: 0,
    bothBuyValid: 0,
  };
}

function buildRawSectorDay(
  prepared: PreparedInstrument[],
  sectorDefs: Array<{ code: string; name: string }>,
  date: string,
  benchmarkBars: DailyPrice[],
  marketIndex: number,
): RawSectorDay[] {
  const allowed = new Set(sectorDefs.map((sector) => sector.code));
  const names = new Map(sectorDefs.map((sector) => [sector.code, sector.name]));
  const aggregates = new Map<string, SectorAggregate>();

  for (const item of prepared) {
    const code = item.instrument.sectorCode;
    if (!allowed.has(code)) continue;
    const metric = memberMetric(item, date);
    if (!metric) continue;
    const aggregate = aggregates.get(code) ?? createAggregate(code, names.get(code) ?? item.instrument.sectorName);
    aggregate.memberCount++;
    if (finite(metric.r20)) aggregate.r20.push(metric.r20);
    if (finite(metric.r60)) aggregate.r60.push(metric.r60);
    if (finite(metric.r120)) aggregate.r120.push(metric.r120);
    if (finite(metric.turnover5)) {
      aggregate.turnover5 += metric.turnover5;
      aggregate.turnover5Count++;
    }
    if (finite(metric.turnover20)) {
      aggregate.turnover20 += metric.turnover20;
      aggregate.turnover20Count++;
    }
    addBoolean(metric.aboveMa20, aggregate, "aboveMa20");
    addBoolean(metric.aboveMa60, aggregate, "aboveMa60");
    addBoolean(metric.aboveMa120, aggregate, "aboveMa120");
    addBoolean(metric.maAligned, aggregate, "maAligned");
    addBoolean(metric.nearHigh, aggregate, "nearHigh");
    addBoolean(metric.advancing, aggregate, "advancing");
    if (finite(metric.foreign5)) {
      aggregate.foreign5Sum += metric.foreign5;
      aggregate.foreign5Valid++;
    }
    if (finite(metric.institution5)) {
      aggregate.institution5Sum += metric.institution5;
      aggregate.institution5Valid++;
    }
    if (finite(metric.foreign5) && finite(metric.institution5)) {
      aggregate.bothBuyValid++;
      if (metric.foreign5 > 0 && metric.institution5 > 0) aggregate.bothBuyTrue++;
    }
    aggregates.set(code, aggregate);
  }

  const mr20 = periodReturn(benchmarkBars, marketIndex, 20);
  const mr60 = periodReturn(benchmarkBars, marketIndex, 60);
  const mr120 = periodReturn(benchmarkBars, marketIndex, 120);
  const complete = sectorDefs
    .map((sector) => aggregates.get(sector.code))
    .filter((value): value is SectorAggregate => value !== undefined && value.memberCount > 0);
  const total5 = complete.reduce((sum, aggregate) => sum + (aggregate.turnover5Count ? aggregate.turnover5 : 0), 0);
  const total20 = complete.reduce((sum, aggregate) => sum + (aggregate.turnover20Count ? aggregate.turnover20 : 0), 0);

  return complete.map((aggregate) => {
    const eq20 = quantile(aggregate.r20, 50);
    const eq60 = quantile(aggregate.r60, 50);
    const eq120 = quantile(aggregate.r120, 50);
    return {
      sectorCode: aggregate.sectorCode,
      sectorName: aggregate.sectorName,
      rs20: finite(eq20) && finite(mr20) ? (eq20 - mr20) * 100 : null,
      rs60: finite(eq60) && finite(mr60) ? (eq60 - mr60) * 100 : null,
      rs120: finite(eq120) && finite(mr120) ? (eq120 - mr120) * 100 : null,
      turnoverShare5: total5 > 0 ? (aggregate.turnover5 / total5) * 100 : 0,
      turnoverShare20: total20 > 0 ? (aggregate.turnover20 / total20) * 100 : 0,
      relativeTurnover:
        aggregate.turnover5Count > 0 && aggregate.turnover20Count > 0 && aggregate.turnover20 > 0
          ? aggregate.turnover5 / aggregate.turnover20
          : null,
      advancing: ratio(aggregate.advancingTrue, aggregate.advancingValid),
      aboveMa20: ratio(aggregate.aboveMa20True, aggregate.aboveMa20Valid),
      aboveMa60: ratio(aggregate.aboveMa60True, aggregate.aboveMa60Valid),
      aboveMa120: ratio(aggregate.aboveMa120True, aggregate.aboveMa120Valid),
      maAligned: ratio(aggregate.maAlignedTrue, aggregate.maAlignedValid),
      nearHigh: ratio(aggregate.nearHighTrue, aggregate.nearHighValid),
      bothBuy5: ratio(aggregate.bothBuyTrue, aggregate.bothBuyValid),
      foreign5: aggregate.foreign5Valid > 0 ? aggregate.foreign5Sum : null,
      institution5: aggregate.institution5Valid > 0 ? aggregate.institution5Sum : null,
      turnover20Total:
        aggregate.turnover20Count > 0 && aggregate.turnover20 > 0 ? aggregate.turnover20 : null,
    };
  });
}

function percentileRatio(sortedAsc: number[], value: number | null): number | null {
  if (!finite(value) || sortedAsc.length === 0) return null;
  let below = 0;
  for (const item of sortedAsc) if (item < value) below++;
  return below / sortedAsc.length;
}

function combine(parts: Array<{ weight: number; ratio: number | null }>): number | null {
  const available = parts.filter((part) => part.ratio !== null);
  const totalWeight = available.reduce((sum, part) => sum + part.weight, 0);
  if (totalWeight === 0) return null;
  return (available.reduce((sum, part) => sum + part.weight * (part.ratio ?? 0), 0) / totalWeight) * 100;
}

function averageRatios(values: Array<number | null>): number | null {
  const valid = values.filter(finite).map((value) => value / 100);
  return mean(valid);
}

function scoreLevel(raw: RawSectorDay[]): Array<Omit<LevelScore, "momentum" | "rotation">> {
  const sorted = (get: (row: RawSectorDay) => number | null) =>
    raw.map(get).filter(finite).sort((a, b) => a - b);
  const rs20 = sorted((row) => row.rs20);
  const rs60 = sorted((row) => row.rs60);
  const rs120 = sorted((row) => row.rs120);
  const foreignFlow = sorted((row) =>
    finite(row.foreign5) && finite(row.turnover20Total) && row.turnover20Total !== 0
      ? row.foreign5 / row.turnover20Total
      : null,
  );
  const institutionFlow = sorted((row) =>
    finite(row.institution5) && finite(row.turnover20Total) && row.turnover20Total !== 0
      ? row.institution5 / row.turnover20Total
      : null,
  );
  const turnoverShareDiff = sorted((row) => row.turnoverShare5 - row.turnoverShare20);

  return raw.map((row) => {
    const trendState = averageRatios([row.aboveMa20, row.aboveMa60, row.aboveMa120]);
    const priceBreadth = averageRatios([row.advancing, row.aboveMa20, row.maAligned]);
    const relativeTurnoverRatio = finite(row.relativeTurnover)
      ? Math.max(0, Math.min(1, (row.relativeTurnover - 0.7) / 0.8))
      : null;
    const foreignRatio =
      finite(row.foreign5) && finite(row.turnover20Total) && row.turnover20Total !== 0
        ? percentileRatio(foreignFlow, row.foreign5 / row.turnover20Total)
        : null;
    const institutionRatio =
      finite(row.institution5) && finite(row.turnover20Total) && row.turnover20Total !== 0
        ? percentileRatio(institutionFlow, row.institution5 / row.turnover20Total)
        : null;
    const shareDiff = row.turnoverShare5 - row.turnoverShare20;

    return {
      sectorCode: row.sectorCode,
      sectorName: row.sectorName,
      price: combine([
        { weight: 20, ratio: percentileRatio(rs20, row.rs20) },
        { weight: 20, ratio: percentileRatio(rs60, row.rs60) },
        { weight: 10, ratio: percentileRatio(rs120, row.rs120) },
        { weight: 15, ratio: trendState },
        { weight: 20, ratio: priceBreadth },
        { weight: 10, ratio: finite(row.nearHigh) ? row.nearHigh / 100 : null },
        { weight: 5, ratio: relativeTurnoverRatio },
      ]),
      flow: combine([
        { weight: 25, ratio: foreignRatio },
        { weight: 20, ratio: institutionRatio },
        { weight: 10, ratio: finite(row.bothBuy5) ? row.bothBuy5 / 100 : null },
        { weight: 15, ratio: percentileRatio(turnoverShareDiff, shareDiff) },
      ]),
      turnoverShareDiff: shareDiff,
      bothBuy5: row.bothBuy5,
      foreign5: row.foreign5,
      institution5: row.institution5,
    };
  });
}

function addMomentumAndRotation(
  current: Array<Omit<LevelScore, "momentum" | "rotation">>,
  previous: Array<Omit<LevelScore, "momentum" | "rotation">> | undefined,
): LevelScore[] {
  const previousBySector = new Map(previous?.map((row) => [row.sectorCode, row]) ?? []);
  const diffs = current.map((row) => {
    const prev = previousBySector.get(row.sectorCode);
    return {
      sectorCode: row.sectorCode,
      priceDiff: finite(row.price) && finite(prev?.price) ? row.price - prev.price : null,
      flowDiff: finite(row.flow) && finite(prev?.flow) ? row.flow - prev.flow : null,
      shareDiff: finite(prev?.turnoverShareDiff) ? row.turnoverShareDiff - prev.turnoverShareDiff : null,
      bothBuyDiff: finite(row.bothBuy5) && finite(prev?.bothBuy5) ? row.bothBuy5 - prev.bothBuy5 : null,
    };
  });
  const sortedPrice = diffs.map((row) => row.priceDiff).filter(finite).sort((a, b) => a - b);
  const sortedFlow = diffs.map((row) => row.flowDiff).filter(finite).sort((a, b) => a - b);
  const sortedShare = diffs.map((row) => row.shareDiff).filter(finite).sort((a, b) => a - b);
  const sortedBothBuy = diffs.map((row) => row.bothBuyDiff).filter(finite).sort((a, b) => a - b);
  const diffBySector = new Map(diffs.map((row) => [row.sectorCode, row]));

  return current.map((row) => {
    const diff = diffBySector.get(row.sectorCode);
    const momentum = diff
      ? combine([
          { weight: 35, ratio: percentileRatio(sortedPrice, diff.priceDiff) },
          { weight: 35, ratio: percentileRatio(sortedFlow, diff.flowDiff) },
          { weight: 15, ratio: percentileRatio(sortedShare, diff.shareDiff) },
          { weight: 15, ratio: percentileRatio(sortedBothBuy, diff.bothBuyDiff) },
        ])
      : null;
    const rotation = combine([
      { weight: DEFAULT_ROTATION_WEIGHTS.priceLeadership, ratio: finite(row.price) ? row.price / 100 : null },
      { weight: DEFAULT_ROTATION_WEIGHTS.moneyFlow, ratio: finite(row.flow) ? row.flow / 100 : null },
      {
        weight: DEFAULT_ROTATION_WEIGHTS.rotationMomentum,
        ratio: finite(momentum) ? momentum / 100 : null,
      },
    ]);
    return { ...row, momentum, rotation };
  });
}

function rankedByKind(rows: LevelScore[], kind: SectorScoreKind): RankedSector[] {
  const scoreOf = (row: LevelScore) => {
    if (kind === "PRICE") return row.price;
    if (kind === "FLOW") return row.flow;
    if (kind === "MOMENTUM") return row.momentum;
    return row.rotation;
  };
  return rows
    .map((row) => ({ sectorCode: row.sectorCode, sectorName: row.sectorName, score: scoreOf(row) }))
    .filter((row): row is { sectorCode: string; sectorName: string; score: number } => finite(row.score))
    .sort((a, b) => b.score - a.score)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function bucketForScore(score: number): ScoreBucketDefinition | null {
  return SCORE_BUCKETS.find(
    (bucket) => score >= bucket.min && (score < bucket.max || (bucket.inclusiveMax && score <= bucket.max)),
  ) ?? null;
}

function direction(from: ScoreBucketDefinition, to: ScoreBucketDefinition): TransitionDirection | null {
  if (to.min > from.min) return "UP";
  if (to.min < from.min) return "DOWN";
  return null;
}

function sectorForwardReturn(
  preparedBySector: Map<string, PreparedInstrument[]>,
  sectorCode: string,
  startDate: string,
  endDate: string,
): number | null {
  const members = preparedBySector.get(sectorCode) ?? [];
  const returns: number[] = [];
  for (const member of members) {
    const startIndex = member.dateIndex.get(startDate);
    const endIndex = member.dateIndex.get(endDate);
    if (startIndex === undefined || endIndex === undefined) continue;
    const start = member.bars[startIndex]?.close;
    const end = member.bars[endIndex]?.close;
    if (finite(start) && finite(end) && start !== 0) returns.push(end / start - 1);
  }
  return quantile(returns, 50);
}

function summarizePerformance(events: TransitionEvent[], horizon: number): ForwardPerformanceStat {
  const samples = events.map((event) => event.forward[horizon]).filter((sample): sample is ReturnSample => sample !== null);
  const returns = samples.map((sample) => sample.returnValue);
  const excess = samples.map((sample) => sample.excessReturn);
  return {
    horizon,
    observations: samples.length,
    avgReturn: mean(returns),
    medianReturn: quantile(returns, 50),
    winRate: returns.length ? returns.filter((value) => value > 0).length / returns.length : null,
    avgExcessReturn: mean(excess),
    medianExcessReturn: quantile(excess, 50),
    excessWinRate: excess.length ? excess.filter((value) => value > 0).length / excess.length : null,
  };
}

function summarizeTransitions(events: TransitionEvent[], kind: SectorScoreKind): ScoreBandTransitionStat[] {
  const groups = new Map<string, TransitionEvent[]>();
  for (const event of events) {
    if (event.kind !== kind) continue;
    const key = `${event.fromBand.label}->${event.toBand.label}`;
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }
  return [...groups.values()]
    .map((list) => ({
      kind,
      fromBand: list[0]!.fromBand.label,
      toBand: list[0]!.toBand.label,
      direction: list[0]!.direction,
      observations: list.length,
      uniqueSectors: new Set(list.map((event) => event.sectorCode)).size,
      avgPrevScore: mean(list.map((event) => event.prevScore)),
      avgCurrentScore: mean(list.map((event) => event.currentScore)),
      avgScoreDelta: mean(list.map((event) => event.currentScore - event.prevScore)),
      medianScoreDelta: quantile(list.map((event) => event.currentScore - event.prevScore), 50),
      fromTop4Rate: list.filter((event) => event.prevRank <= TOP_MAX_RANK).length / list.length,
      toTop4Rate: list.filter((event) => event.currentRank <= TOP_MAX_RANK).length / list.length,
      forwardPerformance: HORIZONS.map((horizon) => summarizePerformance(list, horizon)),
    }))
    .sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === "UP" ? -1 : 1;
      if (a.fromBand !== b.fromBand) return SCORE_BUCKETS.findIndex((x) => x.label === a.fromBand) - SCORE_BUCKETS.findIndex((x) => x.label === b.fromBand);
      return SCORE_BUCKETS.findIndex((x) => x.label === a.toBand) - SCORE_BUCKETS.findIndex((x) => x.label === b.toBand);
    });
}

function transitionMatrix(events: TransitionEvent[], kind: SectorScoreKind): TransitionMatrixCell[] {
  const byFrom = new Map<string, number>();
  const groups = new Map<string, TransitionEvent[]>();
  for (const event of events) {
    if (event.kind !== kind) continue;
    byFrom.set(event.fromBand.label, (byFrom.get(event.fromBand.label) ?? 0) + 1);
    const key = `${event.fromBand.label}->${event.toBand.label}`;
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }
  return [...groups.values()]
    .map((list) => {
      const fromTotal = byFrom.get(list[0]!.fromBand.label) ?? 0;
      return {
        kind,
        fromBand: list[0]!.fromBand.label,
        toBand: list[0]!.toBand.label,
        direction: list[0]!.direction,
        observations: list.length,
        shareOfFromBandTransitions: fromTotal > 0 ? list.length / fromTotal : null,
      };
    })
    .sort((a, b) => {
      const fromDiff = SCORE_BUCKETS.findIndex((x) => x.label === a.fromBand) - SCORE_BUCKETS.findIndex((x) => x.label === b.fromBand);
      if (fromDiff !== 0) return fromDiff;
      return SCORE_BUCKETS.findIndex((x) => x.label === a.toBand) - SCORE_BUCKETS.findIndex((x) => x.label === b.toBand);
    });
}

function summarizeSignal(
  kind: SectorScoreKind,
  signalId: string,
  label: string,
  events: TransitionEvent[],
  predicate: (event: TransitionEvent) => boolean,
): TransitionSignalStat {
  const selected = events.filter((event) => event.kind === kind && predicate(event));
  return {
    kind,
    signalId,
    label,
    observations: selected.length,
    uniqueSectors: new Set(selected.map((event) => event.sectorCode)).size,
    avgScoreDelta: mean(selected.map((event) => event.currentScore - event.prevScore)),
    medianScoreDelta: quantile(selected.map((event) => event.currentScore - event.prevScore), 50),
    toTop4Rate: selected.length ? selected.filter((event) => event.currentRank <= TOP_MAX_RANK).length / selected.length : null,
    forwardPerformance: HORIZONS.map((horizon) => summarizePerformance(selected, horizon)),
  };
}

function signalStats(events: TransitionEvent[], kind: SectorScoreKind): TransitionSignalStat[] {
  return [
    summarizeSignal(kind, "ANY_UP", "모든 상향 점수대 전환", events, (event) => event.direction === "UP"),
    summarizeSignal(
      kind,
      "BELOW_40_TO_40_PLUS",
      "40점 미만에서 40점 이상 진입",
      events,
      (event) => event.prevScore < 40 && event.currentScore >= 40,
    ),
    summarizeSignal(
      kind,
      "BELOW_60_TO_60_PLUS",
      "60점 미만에서 60점 이상 진입",
      events,
      (event) => event.prevScore < 60 && event.currentScore >= 60,
    ),
    summarizeSignal(
      kind,
      "BAND_40_60_TO_60_PLUS",
      "40~60점대에서 60점 이상 진입",
      events,
      (event) => event.fromBand.label === "40~60" && event.currentScore >= 60,
    ),
    summarizeSignal(
      kind,
      "BELOW_70_TO_70_PLUS",
      "70점 미만에서 70점 이상 진입",
      events,
      (event) => event.prevScore < 70 && event.currentScore >= 70,
    ),
    summarizeSignal(
      kind,
      "BELOW_80_TO_80_PLUS",
      "80점 미만에서 80점 이상 진입",
      events,
      (event) => event.prevScore < 80 && event.currentScore >= 80,
    ),
    summarizeSignal(
      kind,
      "UP_TWO_OR_MORE_BANDS",
      "2개 이상 점수대 상향 점프",
      events,
      (event) => event.direction === "UP" && event.toBand.min - event.fromBand.min >= 20,
    ),
    summarizeSignal(
      kind,
      "DOWN_FROM_60_PLUS",
      "60점 이상에서 60점 미만 이탈",
      events,
      (event) => event.prevScore >= 60 && event.currentScore < 60,
    ),
    summarizeSignal(
      kind,
      "DOWN_FROM_70_PLUS",
      "70점 이상에서 70점 미만 이탈",
      events,
      (event) => event.prevScore >= 70 && event.currentScore < 70,
    ),
  ];
}

function findBenchmark(dataset: MarketDataset): DailyPrice[] | null {
  const index = dataset.indexSeries.find(
    (item) =>
      item.indexCode === "KOSPI" ||
      item.indexName.toUpperCase().includes("KOSPI") ||
      item.indexName.includes("코스피"),
  );
  return index?.bars?.length ? index.bars : null;
}

function buildTransitions(
  dailyRankings: DailyRanking[],
  preparedBySector: Map<string, PreparedInstrument[]>,
  benchmarkBars: DailyPrice[],
): TransitionEvent[] {
  const events: TransitionEvent[] = [];
  for (const kind of SCORE_KINDS) {
    const previous = new Map<string, RankedSector>();
    for (const day of dailyRankings) {
      const endDates = new Map<number, string>();
      for (const horizon of HORIZONS) {
        const endDate = benchmarkBars[day.marketIndex + horizon]?.tradeDate;
        if (endDate) endDates.set(horizon, endDate);
      }
      for (const current of day.byKind[kind]) {
        const prev = previous.get(current.sectorCode);
        previous.set(current.sectorCode, current);
        if (!prev) continue;
        const fromBand = bucketForScore(prev.score);
        const toBand = bucketForScore(current.score);
        if (!fromBand || !toBand || fromBand.label === toBand.label) continue;
        const move = direction(fromBand, toBand);
        if (!move) continue;
        const forward: Record<number, ReturnSample | null> = {};
        for (const horizon of HORIZONS) {
          const endDate = endDates.get(horizon);
          const benchmarkReturn = forwardReturn(benchmarkBars, day.marketIndex, horizon);
          const sectorReturn = endDate
            ? sectorForwardReturn(preparedBySector, current.sectorCode, day.date, endDate)
            : null;
          forward[horizon] = finite(sectorReturn) && finite(benchmarkReturn)
            ? { returnValue: sectorReturn, excessReturn: sectorReturn - benchmarkReturn }
            : null;
        }
        events.push({
          kind,
          sectorCode: current.sectorCode,
          sectorName: current.sectorName,
          marketIndex: day.marketIndex,
          fromBand,
          toBand,
          direction: move,
          prevScore: prev.score,
          currentScore: current.score,
          prevRank: prev.rank,
          currentRank: current.rank,
          forward,
        });
      }
    }
  }
  return events;
}

export function runSectorScoreTransitionBacktest(
  input: MarketDataset,
): SectorScoreTransitionBacktestResult | null {
  const dataset = buildFullUniverseSectorDataset(input);
  const benchmarkBars = findBenchmark(dataset);
  if (!benchmarkBars || benchmarkBars.length < MIN_LEVEL_INDEX + MOMENTUM_LOOKBACK + 2) return null;

  const sectorDefs = THEME_SECTORS.filter((sector) => sector.code !== "MARKET_IDX" && sector.code !== "ETC");
  const prepared = dataset.instruments
    .filter(
      (instrument) =>
        instrument.instrumentType === "STOCK" &&
        instrument.sectorCode !== "MARKET_IDX" &&
        instrument.sectorCode !== "ETC",
    )
    .map((instrument) => {
      const bars = dataset.bars[instrument.symbol] ?? [];
      return bars.length ? prepareInstrument(instrument, bars) : null;
    })
    .filter((value): value is PreparedInstrument => value !== null);

  const preparedBySector = new Map<string, PreparedInstrument[]>();
  for (const item of prepared) {
    const list = preparedBySector.get(item.instrument.sectorCode) ?? [];
    list.push(item);
    preparedBySector.set(item.instrument.sectorCode, list);
  }

  const scoreLevelsByMarketIndex = new Map<number, Array<Omit<LevelScore, "momentum" | "rotation">>>();
  const dailyRankings: DailyRanking[] = [];

  for (let marketIndex = MIN_LEVEL_INDEX; marketIndex < benchmarkBars.length; marketIndex++) {
    const date = benchmarkBars[marketIndex]?.tradeDate;
    if (!date) continue;
    const raw = buildRawSectorDay(prepared, sectorDefs, date, benchmarkBars, marketIndex);
    if (raw.length < 4) continue;
    const level = scoreLevel(raw);
    scoreLevelsByMarketIndex.set(marketIndex, level);
    const withMomentum = addMomentumAndRotation(
      level,
      scoreLevelsByMarketIndex.get(marketIndex - MOMENTUM_LOOKBACK),
    );
    const byKind = Object.fromEntries(
      SCORE_KINDS.map((kind) => [kind, rankedByKind(withMomentum, kind)]),
    ) as Record<SectorScoreKind, RankedSector[]>;
    if (SCORE_KINDS.every((kind) => byKind[kind].length >= 4)) {
      dailyRankings.push({ date, marketIndex, byKind });
    }
  }

  if (!dailyRankings.length) return null;
  const events = buildTransitions(dailyRankings, preparedBySector, benchmarkBars);
  const families: ScoreTransitionFamilyDiagnostic[] = SCORE_KINDS.map((kind) => ({
    kind,
    label: KIND_LABEL[kind],
    transitionStats: summarizeTransitions(events, kind),
    transitionMatrix: transitionMatrix(events, kind),
    signalStats: signalStats(events, kind),
  }));

  return {
    version: "CloudTrend V7.3",
    from: dailyRankings[0]!.date,
    to: dailyRankings[dailyRankings.length - 1]!.date,
    tradingDays: dailyRankings.length,
    sectorCount: new Set(prepared.map((item) => item.instrument.sectorCode)).size,
    scoreBuckets: SCORE_BUCKETS,
    families,
    notes: [
      "V7.3은 전일 점수대와 당일 점수대가 달라진 경우만 전환 이벤트로 기록합니다.",
      "전환일의 당일 종가 기준으로 이후 5/10/20/40거래일 섹터 중앙수익률과 KOSPI 대비 초과수익률을 계산합니다.",
      "섹터 수익률은 해당 섹터 구성 종목의 중앙값 수익률이며, 현재 확정 섹터 매핑을 전체 과거 기간에 적용합니다.",
      "점수 산출은 V7.2 분해 백테스트와 같은 입력 변수 체계와 기본 가중치 40/45/15를 사용합니다.",
    ],
  };
}
