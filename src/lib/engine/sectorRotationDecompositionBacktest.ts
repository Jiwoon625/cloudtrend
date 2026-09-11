import type { MarketDataset } from "./dataset";
import { DEFAULT_ROTATION_WEIGHTS } from "./sectorRotation";
import { buildFullUniverseSectorDataset } from "./sectorRotationFullUniverse";
import { THEME_SECTORS } from "./sectors";
import type { DailyPrice, Instrument } from "./types";

export type SectorScoreKind = "PRICE" | "FLOW" | "MOMENTUM" | "ROTATION";

export interface EpisodeStats {
  episodes: number;
  avgDays: number | null;
  medianDays: number | null;
  p25Days: number | null;
  p75Days: number | null;
  maxDays: number | null;
}

export interface SurvivalStat {
  horizon: number;
  strictEligible: number;
  strictSurvivors: number;
  strictRate: number | null;
  bufferedEligible: number;
  bufferedSurvivors: number;
  bufferedRate: number | null;
}

export interface TopSetRetentionStat {
  horizon: number;
  observations: number;
  avgRetained: number | null;
  avgRetentionRate: number | null;
  avgNewEntrants: number | null;
}

export interface BoundaryGapStat {
  observations: number;
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  below1Rate: number | null;
  below3Rate: number | null;
  atLeast5Rate: number | null;
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

export interface ScoreForwardCorrelationStat {
  horizon: number;
  observations: number;
  pearsonReturn: number | null;
  spearmanReturn: number | null;
  pearsonExcessReturn: number | null;
  spearmanExcessReturn: number | null;
}

export interface ScoreBucketDefinition {
  label: string;
  min: number;
  max: number;
  inclusiveMax: boolean;
}

export interface ScoreBandDiagnostic {
  label: string;
  min: number;
  max: number;
  observations: number;
  observationShare: number | null;
  uniqueSectors: number;
  top4Rate: number | null;
  entryCount: number;
  dwellStats: EpisodeStats;
  stateForwardPerformance: ForwardPerformanceStat[];
  entryForwardPerformance: ForwardPerformanceStat[];
}

export interface ScoreFamilyDiagnostic {
  kind: SectorScoreKind;
  label: string;
  strictTop: EpisodeStats;
  bufferedTop: EpisodeStats;
  topReentryGap: EpisodeStats;
  survival: SurvivalStat[];
  topSetRetention: TopSetRetentionStat[];
  boundaryGap: BoundaryGapStat;
  scoreForwardCorrelations: ScoreForwardCorrelationStat[];
  scoreBands: ScoreBandDiagnostic[];
}

export interface FlowConfirmationStat {
  top4SectorDays: number;
  combinedNetPositiveRate: number | null;
  combinedNetAndSharePositiveRate: number | null;
  bothInvestorAndSharePositiveRate: number | null;
  negativeCombinedNetRate: number | null;
  newTop4Entries: number;
  entryCombinedNetAndSharePositiveRate: number | null;
  entryBothInvestorAndSharePositiveRate: number | null;
}

export interface SectorRotationDecompositionResult {
  version: "CloudTrend V7.2";
  from: string;
  to: string;
  tradingDays: number;
  sectorCount: number;
  scoreBuckets: ScoreBucketDefinition[];
  families: ScoreFamilyDiagnostic[];
  flowConfirmation: FlowConfirmationStat;
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
  foreign5: number | null;
  institution5: number | null;
  turnoverShareDiff: number;
}

interface DailyRanking {
  date: string;
  marketIndex: number;
  byKind: Record<SectorScoreKind, RankedSector[]>;
}

interface Episode {
  sectorCode: string;
  sectorName: string;
  startMarketIndex: number;
  endMarketIndex: number;
  duration: number;
  leftCensored: boolean;
  rightCensored: boolean;
}

interface SignalRecord {
  sectorCode: string;
  date: string;
  marketIndex: number;
  score: number;
}

interface ReturnPair {
  score: number;
  returnValue: number;
  excessReturn: number;
}

const MIN_LEVEL_INDEX = 120;
const MOMENTUM_LOOKBACK = 5;
const TOP_MAX_RANK = 4;
const BUFFERED_TOP_EXIT_RANK = 6;
const SURVIVAL_HORIZONS = [5, 10, 20, 40];
const SET_RETENTION_HORIZONS = [1, 5];
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

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
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

function episodeStats(episodes: Episode[]): EpisodeStats {
  const days = episodes
    .filter((episode) => !episode.leftCensored && !episode.rightCensored)
    .map((episode) => episode.duration);
  return durationStats(days);
}

function durationStats(days: number[]): EpisodeStats {
  return {
    episodes: days.length,
    avgDays: mean(days),
    medianDays: quantile(days, 50),
    p25Days: quantile(days, 25),
    p75Days: quantile(days, 75),
    maxDays: days.length ? Math.max(...days) : null,
  };
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
  kospiBars: DailyPrice[],
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

  const mr20 = periodReturn(kospiBars, marketIndex, 20);
  const mr60 = periodReturn(kospiBars, marketIndex, 60);
  const mr120 = periodReturn(kospiBars, marketIndex, 120);
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
  const weight = available.reduce((sum, part) => sum + part.weight, 0);
  if (weight === 0) return null;
  return (available.reduce((sum, part) => sum + part.weight * (part.ratio ?? 0), 0) / weight) * 100;
}

function averageRatios(values: Array<number | null>): number | null {
  const valid = values.filter(finite).map((value) => value / 100);
  return mean(valid);
}

function scoreLevel(raw: RawSectorDay[]): Array<Omit<LevelScore, "momentum" | "rotation">> {
  const sorted = (get: (row: RawSectorDay) => number | null) =>
    raw.map(get).filter(finite).sort((a, b) => a - b);
  const rs20s = sorted((row) => row.rs20);
  const rs60s = sorted((row) => row.rs60);
  const rs120s = sorted((row) => row.rs120);
  const foreignIntensity = (row: RawSectorDay) =>
    finite(row.foreign5) && finite(row.turnover20Total) && row.turnover20Total > 0
      ? row.foreign5 / row.turnover20Total
      : null;
  const institutionIntensity = (row: RawSectorDay) =>
    finite(row.institution5) && finite(row.turnover20Total) && row.turnover20Total > 0
      ? row.institution5 / row.turnover20Total
      : null;
  const foreigns = sorted(foreignIntensity);
  const institutions = sorted(institutionIntensity);
  const shareDiff = (row: RawSectorDay) => row.turnoverShare5 - row.turnoverShare20;
  const shares = sorted(shareDiff);

  return raw.map((row) => {
    const trend = averageRatios([row.aboveMa20, row.aboveMa60, row.aboveMa120]);
    const breadth = averageRatios([row.advancing, row.aboveMa20, row.maAligned]);
    const price = combine([
      { weight: 20, ratio: percentileRatio(rs20s, row.rs20) },
      { weight: 20, ratio: percentileRatio(rs60s, row.rs60) },
      { weight: 10, ratio: percentileRatio(rs120s, row.rs120) },
      { weight: 15, ratio: trend },
      { weight: 20, ratio: breadth },
      { weight: 10, ratio: row.nearHigh === null ? null : row.nearHigh / 100 },
      {
        weight: 5,
        ratio:
          row.relativeTurnover === null
            ? null
            : Math.min(1, Math.max(0, (row.relativeTurnover - 0.7) / 0.8)),
      },
    ]);
    const flow = combine([
      { weight: 25, ratio: percentileRatio(foreigns, foreignIntensity(row)) },
      { weight: 20, ratio: percentileRatio(institutions, institutionIntensity(row)) },
      { weight: 10, ratio: row.bothBuy5 === null ? null : row.bothBuy5 / 100 },
      { weight: 15, ratio: percentileRatio(shares, shareDiff(row)) },
      { weight: 10, ratio: null },
      { weight: 10, ratio: null },
      { weight: 10, ratio: null },
    ]);
    return {
      sectorCode: row.sectorCode,
      sectorName: row.sectorName,
      price,
      flow,
      turnoverShareDiff: shareDiff(row),
      bothBuy5: row.bothBuy5,
      foreign5: row.foreign5,
      institution5: row.institution5,
    };
  });
}

function rankRows(
  rows: LevelScore[],
  getScore: (row: LevelScore) => number | null,
): RankedSector[] {
  return rows
    .map((row) => ({ row, score: getScore(row) }))
    .filter((item): item is { row: LevelScore; score: number } => finite(item.score))
    .sort((a, b) => b.score - a.score)
    .map(({ row, score }, index) => ({
      sectorCode: row.sectorCode,
      sectorName: row.sectorName,
      score,
      rank: index + 1,
      foreign5: row.foreign5,
      institution5: row.institution5,
      turnoverShareDiff: row.turnoverShareDiff,
    }));
}

function buildRankHistory(
  dataset: MarketDataset,
  prepared: PreparedInstrument[],
  sectorDefs: Array<{ code: string; name: string }>,
): DailyRanking[] {
  const kospi = dataset.indexSeries.find((series) => series.indexCode === "KOSPI");
  if (!kospi || kospi.bars.length <= MIN_LEVEL_INDEX + MOMENTUM_LOOKBACK) return [];
  const levelByIndex = new Map<number, Array<Omit<LevelScore, "momentum" | "rotation">>>();
  const output: DailyRanking[] = [];

  for (let marketIndex = MIN_LEVEL_INDEX; marketIndex < kospi.bars.length; marketIndex++) {
    const date = kospi.bars[marketIndex]!.tradeDate;
    const raw = buildRawSectorDay(prepared, sectorDefs, date, kospi.bars, marketIndex);
    if (raw.length !== sectorDefs.length) continue;
    const level = scoreLevel(raw);
    levelByIndex.set(marketIndex, level);

    const previous = levelByIndex.get(marketIndex - MOMENTUM_LOOKBACK);
    if (!previous) continue;
    const prevByCode = new Map(previous.map((row) => [row.sectorCode, row]));
    const drafts = level.map((current) => {
      const previousRow = prevByCode.get(current.sectorCode);
      return {
        ...current,
        momentumParts: [
          finite(current.price) && finite(previousRow?.price) ? current.price - previousRow.price : null,
          finite(current.flow) && finite(previousRow?.flow) ? current.flow - previousRow.flow : null,
          current.turnoverShareDiff,
          finite(current.bothBuy5) && finite(previousRow?.bothBuy5)
            ? current.bothBuy5 - previousRow.bothBuy5
            : null,
        ],
      };
    });
    const momentumSeries = [0, 1, 2, 3].map((part) =>
      drafts
        .map((draft) => draft.momentumParts[part])
        .filter(finite)
        .sort((a, b) => a - b),
    );
    const scored: LevelScore[] = drafts.map((draft) => {
      const ratios = draft.momentumParts
        .map((value, part) => percentileRatio(momentumSeries[part]!, value))
        .filter(finite);
      const momentum = ratios.length ? mean(ratios)! * 100 : null;
      const weighted = [
        [DEFAULT_ROTATION_WEIGHTS.priceLeadership, draft.price] as const,
        [DEFAULT_ROTATION_WEIGHTS.moneyFlow, draft.flow] as const,
        [DEFAULT_ROTATION_WEIGHTS.rotationMomentum, momentum] as const,
      ];
      const availableWeight = weighted
        .filter(([, value]) => finite(value))
        .reduce((sum, [weight]) => sum + weight, 0);
      const rotation =
        availableWeight === 0
          ? null
          : weighted.reduce(
              (sum, [weight, value]) => sum + (finite(value) ? weight * value : 0),
              0,
            ) / availableWeight;
      return {
        sectorCode: draft.sectorCode,
        sectorName: draft.sectorName,
        price: draft.price,
        flow: draft.flow,
        momentum,
        rotation,
        turnoverShareDiff: draft.turnoverShareDiff,
        bothBuy5: draft.bothBuy5,
        foreign5: draft.foreign5,
        institution5: draft.institution5,
      };
    });

    output.push({
      date,
      marketIndex,
      byKind: {
        PRICE: rankRows(scored, (row) => row.price),
        FLOW: rankRows(scored, (row) => row.flow),
        MOMENTUM: rankRows(scored, (row) => row.momentum),
        ROTATION: rankRows(scored, (row) => row.rotation),
      },
    });
  }
  return output;
}

function strictTopEpisodes(
  history: DailyRanking[],
  kind: SectorScoreKind,
  sectorDefs: Array<{ code: string; name: string }>,
): Episode[] {
  const episodes: Episode[] = [];
  for (const sector of sectorDefs) {
    let current: Episode | null = null;
    let previousMarketIndex: number | null = null;
    history.forEach((day, position) => {
      const row = day.byKind[kind].find((item) => item.sectorCode === sector.code);
      if (!row) return;
      const isTop = row.rank <= TOP_MAX_RANK;
      const gap = previousMarketIndex !== null && day.marketIndex !== previousMarketIndex + 1;
      if (gap && current) {
        current.rightCensored = true;
        episodes.push(current);
        current = null;
      }
      if (isTop && !current) {
        current = {
          sectorCode: sector.code,
          sectorName: sector.name,
          startMarketIndex: day.marketIndex,
          endMarketIndex: day.marketIndex,
          duration: 1,
          leftCensored: position === 0 || gap,
          rightCensored: false,
        };
      } else if (isTop && current) {
        current.endMarketIndex = day.marketIndex;
        current.duration++;
      } else if (!isTop && current) {
        episodes.push(current);
        current = null;
      }
      previousMarketIndex = day.marketIndex;
    });
    if (current) {
      current.rightCensored = true;
      episodes.push(current);
    }
  }
  return episodes;
}

function bufferedTopEpisodes(
  history: DailyRanking[],
  kind: SectorScoreKind,
  sectorDefs: Array<{ code: string; name: string }>,
): Episode[] {
  const episodes: Episode[] = [];
  for (const sector of sectorDefs) {
    let current: Episode | null = null;
    let previousMarketIndex: number | null = null;
    history.forEach((day, position) => {
      const row = day.byKind[kind].find((item) => item.sectorCode === sector.code);
      if (!row) return;
      const gap = previousMarketIndex !== null && day.marketIndex !== previousMarketIndex + 1;
      if (gap && current) {
        current.rightCensored = true;
        episodes.push(current);
        current = null;
      }
      if (!current && row.rank <= TOP_MAX_RANK) {
        current = {
          sectorCode: sector.code,
          sectorName: sector.name,
          startMarketIndex: day.marketIndex,
          endMarketIndex: day.marketIndex,
          duration: 1,
          leftCensored: position === 0 || gap,
          rightCensored: false,
        };
      } else if (current && row.rank < BUFFERED_TOP_EXIT_RANK) {
        current.endMarketIndex = day.marketIndex;
        current.duration++;
      } else if (current && row.rank >= BUFFERED_TOP_EXIT_RANK) {
        episodes.push(current);
        current = null;
      }
      previousMarketIndex = day.marketIndex;
    });
    if (current) {
      current.rightCensored = true;
      episodes.push(current);
    }
  }
  return episodes;
}

function survival(episodes: Episode[], horizon: number): { eligible: number; survivors: number; rate: number | null } {
  const entries = episodes.filter((episode) => !episode.leftCensored);
  let eligible = 0;
  let survivors = 0;
  for (const episode of entries) {
    if (episode.duration > horizon) {
      eligible++;
      survivors++;
    } else if (!episode.rightCensored) {
      eligible++;
    }
  }
  return { eligible, survivors, rate: eligible ? (survivors / eligible) * 100 : null };
}

function topSetRetention(history: DailyRanking[], kind: SectorScoreKind, horizon: number): TopSetRetentionStat {
  const byIndex = new Map(history.map((day) => [day.marketIndex, day]));
  const retained: number[] = [];
  const rates: number[] = [];
  const entrants: number[] = [];
  for (const day of history) {
    const future = byIndex.get(day.marketIndex + horizon);
    if (!future) continue;
    const currentTop = new Set(
      day.byKind[kind].filter((row) => row.rank <= TOP_MAX_RANK).map((row) => row.sectorCode),
    );
    const futureTop = new Set(
      future.byKind[kind].filter((row) => row.rank <= TOP_MAX_RANK).map((row) => row.sectorCode),
    );
    if (currentTop.size === 0 || futureTop.size === 0) continue;
    let retainedCount = 0;
    let entrantCount = 0;
    for (const code of currentTop) if (futureTop.has(code)) retainedCount++;
    for (const code of futureTop) if (!currentTop.has(code)) entrantCount++;
    retained.push(retainedCount);
    rates.push((retainedCount / currentTop.size) * 100);
    entrants.push(entrantCount);
  }
  return {
    horizon,
    observations: retained.length,
    avgRetained: mean(retained),
    avgRetentionRate: mean(rates),
    avgNewEntrants: mean(entrants),
  };
}

function boundaryGap(history: DailyRanking[], kind: SectorScoreKind): BoundaryGapStat {
  const gaps: number[] = [];
  for (const day of history) {
    const rows = day.byKind[kind];
    if (rows.length <= TOP_MAX_RANK) continue;
    const fourth = rows[TOP_MAX_RANK - 1]?.score;
    const fifth = rows[TOP_MAX_RANK]?.score;
    if (finite(fourth) && finite(fifth)) gaps.push(fourth - fifth);
  }
  return {
    observations: gaps.length,
    mean: mean(gaps),
    median: quantile(gaps, 50),
    p25: quantile(gaps, 25),
    p75: quantile(gaps, 75),
    below1Rate: gaps.length ? (gaps.filter((gap) => gap < 1).length / gaps.length) * 100 : null,
    below3Rate: gaps.length ? (gaps.filter((gap) => gap < 3).length / gaps.length) * 100 : null,
    atLeast5Rate: gaps.length ? (gaps.filter((gap) => gap >= 5).length / gaps.length) * 100 : null,
  };
}

function topReentryGap(episodes: Episode[], sectorDefs: Array<{ code: string; name: string }>): EpisodeStats {
  const gaps: number[] = [];
  for (const sector of sectorDefs) {
    const starts = episodes
      .filter((episode) => episode.sectorCode === sector.code && !episode.leftCensored)
      .map((episode) => episode.startMarketIndex)
      .sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) gaps.push(starts[i]! - starts[i - 1]!);
  }
  return durationStats(gaps);
}

function sectorForwardReturn(
  preparedBySector: Map<string, PreparedInstrument[]>,
  sectorCode: string,
  startDate: string,
  endDate: string,
): number | null {
  const returns: number[] = [];
  for (const item of preparedBySector.get(sectorCode) ?? []) {
    const start = item.dateIndex.get(startDate);
    const end = item.dateIndex.get(endDate);
    if (start === undefined || end === undefined || end <= start) continue;
    const startClose = item.bars[start]?.close;
    const endClose = item.bars[end]?.close;
    if (!finite(startClose) || !finite(endClose) || startClose <= 0) continue;
    returns.push((endClose / startClose - 1) * 100);
  }
  return quantile(returns, 50);
}

function performanceForSignals(
  signals: SignalRecord[],
  preparedBySector: Map<string, PreparedInstrument[]>,
  kospiBars: DailyPrice[],
): ForwardPerformanceStat[] {
  return SURVIVAL_HORIZONS.map((horizon) => {
    const returns: number[] = [];
    const excess: number[] = [];
    for (const signal of signals) {
      const endIndex = signal.marketIndex + horizon;
      if (endIndex >= kospiBars.length) continue;
      const startBar = kospiBars[signal.marketIndex];
      const endBar = kospiBars[endIndex];
      if (!startBar || !endBar || startBar.close <= 0) continue;
      const sectorReturn = sectorForwardReturn(
        preparedBySector,
        signal.sectorCode,
        signal.date,
        endBar.tradeDate,
      );
      if (!finite(sectorReturn)) continue;
      const marketReturn = (endBar.close / startBar.close - 1) * 100;
      returns.push(sectorReturn);
      excess.push(sectorReturn - marketReturn);
    }
    return {
      horizon,
      observations: returns.length,
      avgReturn: mean(returns),
      medianReturn: quantile(returns, 50),
      winRate: returns.length ? (returns.filter((value) => value > 0).length / returns.length) * 100 : null,
      avgExcessReturn: mean(excess),
      medianExcessReturn: quantile(excess, 50),
      excessWinRate: excess.length ? (excess.filter((value) => value > 0).length / excess.length) * 100 : null,
    };
  });
}

function returnPairs(
  history: DailyRanking[],
  kind: SectorScoreKind,
  preparedBySector: Map<string, PreparedInstrument[]>,
  kospiBars: DailyPrice[],
  horizon: number,
): ReturnPair[] {
  const pairs: ReturnPair[] = [];
  for (const day of history) {
    const endIndex = day.marketIndex + horizon;
    if (endIndex >= kospiBars.length) continue;
    const startBar = kospiBars[day.marketIndex];
    const endBar = kospiBars[endIndex];
    if (!startBar || !endBar || startBar.close <= 0) continue;
    const marketReturn = (endBar.close / startBar.close - 1) * 100;
    for (const row of day.byKind[kind]) {
      const sectorReturn = sectorForwardReturn(
        preparedBySector,
        row.sectorCode,
        day.date,
        endBar.tradeDate,
      );
      if (!finite(sectorReturn)) continue;
      pairs.push({
        score: row.score,
        returnValue: sectorReturn,
        excessReturn: sectorReturn - marketReturn,
      });
    }
  }
  return pairs;
}

function correlation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const meanX = mean(xs);
  const meanY = mean(ys);
  if (!finite(meanX) || !finite(meanY)) return null;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator === 0 ? null : covariance / denominator;
}

function ranks(values: number[]): number[] {
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

function scoreForwardCorrelations(
  history: DailyRanking[],
  kind: SectorScoreKind,
  preparedBySector: Map<string, PreparedInstrument[]>,
  kospiBars: DailyPrice[],
): ScoreForwardCorrelationStat[] {
  return SURVIVAL_HORIZONS.map((horizon) => {
    const pairs = returnPairs(history, kind, preparedBySector, kospiBars, horizon);
    const xs = pairs.map((pair) => pair.score);
    const returns = pairs.map((pair) => pair.returnValue);
    const excess = pairs.map((pair) => pair.excessReturn);
    return {
      horizon,
      observations: pairs.length,
      pearsonReturn: correlation(xs, returns),
      spearmanReturn: correlation(ranks(xs), ranks(returns)),
      pearsonExcessReturn: correlation(xs, excess),
      spearmanExcessReturn: correlation(ranks(xs), ranks(excess)),
    };
  });
}

function scoreInBucket(score: number, bucket: ScoreBucketDefinition): boolean {
  if (score < bucket.min) return false;
  if (bucket.inclusiveMax) return score <= bucket.max;
  return score < bucket.max;
}

function scoreBandEpisodes(
  history: DailyRanking[],
  kind: SectorScoreKind,
  bucket: ScoreBucketDefinition,
  sectorDefs: Array<{ code: string; name: string }>,
): Episode[] {
  const episodes: Episode[] = [];
  for (const sector of sectorDefs) {
    let current: Episode | null = null;
    let previousMarketIndex: number | null = null;
    history.forEach((day, position) => {
      const row = day.byKind[kind].find((item) => item.sectorCode === sector.code);
      if (!row) return;
      const inBucket = scoreInBucket(row.score, bucket);
      const gap = previousMarketIndex !== null && day.marketIndex !== previousMarketIndex + 1;
      if (gap && current) {
        current.rightCensored = true;
        episodes.push(current);
        current = null;
      }
      if (inBucket && !current) {
        current = {
          sectorCode: sector.code,
          sectorName: sector.name,
          startMarketIndex: day.marketIndex,
          endMarketIndex: day.marketIndex,
          duration: 1,
          leftCensored: position === 0 || gap,
          rightCensored: false,
        };
      } else if (inBucket && current) {
        current.endMarketIndex = day.marketIndex;
        current.duration++;
      } else if (!inBucket && current) {
        episodes.push(current);
        current = null;
      }
      previousMarketIndex = day.marketIndex;
    });
    if (current) {
      current.rightCensored = true;
      episodes.push(current);
    }
  }
  return episodes;
}

function signalsForBucket(
  history: DailyRanking[],
  kind: SectorScoreKind,
  bucket: ScoreBucketDefinition,
): { stateSignals: SignalRecord[]; entrySignals: SignalRecord[]; top4Count: number; sectors: Set<string> } {
  const stateSignals: SignalRecord[] = [];
  const entrySignals: SignalRecord[] = [];
  const sectors = new Set<string>();
  let top4Count = 0;
  let previousDay: DailyRanking | null = null;
  for (const day of history) {
    const previousByCode =
      previousDay && day.marketIndex === previousDay.marketIndex + 1
        ? new Map(previousDay.byKind[kind].map((row) => [row.sectorCode, row]))
        : new Map<string, RankedSector>();
    for (const row of day.byKind[kind]) {
      if (!scoreInBucket(row.score, bucket)) continue;
      const signal = { sectorCode: row.sectorCode, date: day.date, marketIndex: day.marketIndex, score: row.score };
      stateSignals.push(signal);
      sectors.add(row.sectorCode);
      if (row.rank <= TOP_MAX_RANK) top4Count++;
      const previous = previousByCode.get(row.sectorCode);
      if (!previous || !scoreInBucket(previous.score, bucket)) entrySignals.push(signal);
    }
    previousDay = day;
  }
  return { stateSignals, entrySignals, top4Count, sectors };
}

function scoreBandDiagnostics(
  history: DailyRanking[],
  kind: SectorScoreKind,
  sectorDefs: Array<{ code: string; name: string }>,
  preparedBySector: Map<string, PreparedInstrument[]>,
  kospiBars: DailyPrice[],
): ScoreBandDiagnostic[] {
  const totalObservations = history.reduce((sum, day) => sum + day.byKind[kind].length, 0);
  return SCORE_BUCKETS.map((bucket) => {
    const signals = signalsForBucket(history, kind, bucket);
    return {
      label: bucket.label,
      min: bucket.min,
      max: bucket.max,
      observations: signals.stateSignals.length,
      observationShare: totalObservations
        ? (signals.stateSignals.length / totalObservations) * 100
        : null,
      uniqueSectors: signals.sectors.size,
      top4Rate: signals.stateSignals.length
        ? (signals.top4Count / signals.stateSignals.length) * 100
        : null,
      entryCount: signals.entrySignals.length,
      dwellStats: episodeStats(scoreBandEpisodes(history, kind, bucket, sectorDefs)),
      stateForwardPerformance: performanceForSignals(
        signals.stateSignals,
        preparedBySector,
        kospiBars,
      ),
      entryForwardPerformance: performanceForSignals(
        signals.entrySignals,
        preparedBySector,
        kospiBars,
      ),
    };
  });
}

function flowConfirmation(history: DailyRanking[]): FlowConfirmationStat {
  let top4SectorDays = 0;
  let combinedNetPositive = 0;
  let combinedNetAndSharePositive = 0;
  let bothInvestorAndSharePositive = 0;
  let negativeCombinedNet = 0;
  let newTop4Entries = 0;
  let entryCombinedNetAndSharePositive = 0;
  let entryBothInvestorAndSharePositive = 0;
  let previousDay: DailyRanking | null = null;

  for (const day of history) {
    const previousTop =
      previousDay && day.marketIndex === previousDay.marketIndex + 1
        ? new Set(
            previousDay.byKind.FLOW
              .filter((row) => row.rank <= TOP_MAX_RANK)
              .map((row) => row.sectorCode),
          )
        : new Set<string>();
    for (const row of day.byKind.FLOW.filter((item) => item.rank <= TOP_MAX_RANK)) {
      const combined =
        finite(row.foreign5) || finite(row.institution5)
          ? (row.foreign5 ?? 0) + (row.institution5 ?? 0)
          : null;
      const positiveCombined = finite(combined) && combined > 0;
      const positiveShare = row.turnoverShareDiff > 0;
      const bothPositive = finite(row.foreign5) && finite(row.institution5) && row.foreign5 > 0 && row.institution5 > 0;
      top4SectorDays++;
      if (positiveCombined) combinedNetPositive++;
      if (positiveCombined && positiveShare) combinedNetAndSharePositive++;
      if (bothPositive && positiveShare) bothInvestorAndSharePositive++;
      if (finite(combined) && combined < 0) negativeCombinedNet++;
      if (!previousTop.has(row.sectorCode)) {
        newTop4Entries++;
        if (positiveCombined && positiveShare) entryCombinedNetAndSharePositive++;
        if (bothPositive && positiveShare) entryBothInvestorAndSharePositive++;
      }
    }
    previousDay = day;
  }

  return {
    top4SectorDays,
    combinedNetPositiveRate: top4SectorDays ? (combinedNetPositive / top4SectorDays) * 100 : null,
    combinedNetAndSharePositiveRate: top4SectorDays
      ? (combinedNetAndSharePositive / top4SectorDays) * 100
      : null,
    bothInvestorAndSharePositiveRate: top4SectorDays
      ? (bothInvestorAndSharePositive / top4SectorDays) * 100
      : null,
    negativeCombinedNetRate: top4SectorDays ? (negativeCombinedNet / top4SectorDays) * 100 : null,
    newTop4Entries,
    entryCombinedNetAndSharePositiveRate: newTop4Entries
      ? (entryCombinedNetAndSharePositive / newTop4Entries) * 100
      : null,
    entryBothInvestorAndSharePositiveRate: newTop4Entries
      ? (entryBothInvestorAndSharePositive / newTop4Entries) * 100
      : null,
  };
}

function labelForKind(kind: SectorScoreKind): string {
  if (kind === "PRICE") return "Price Leadership";
  if (kind === "FLOW") return "Money Flow";
  if (kind === "MOMENTUM") return "Rotation Momentum";
  return "Rotation Score";
}

function familyDiagnostic(
  history: DailyRanking[],
  kind: SectorScoreKind,
  sectorDefs: Array<{ code: string; name: string }>,
  preparedBySector: Map<string, PreparedInstrument[]>,
  kospiBars: DailyPrice[],
): ScoreFamilyDiagnostic {
  const strict = strictTopEpisodes(history, kind, sectorDefs);
  const buffered = bufferedTopEpisodes(history, kind, sectorDefs);
  const survivalRows = SURVIVAL_HORIZONS.map((horizon) => {
    const strictResult = survival(strict, horizon);
    const bufferedResult = survival(buffered, horizon);
    return {
      horizon,
      strictEligible: strictResult.eligible,
      strictSurvivors: strictResult.survivors,
      strictRate: strictResult.rate,
      bufferedEligible: bufferedResult.eligible,
      bufferedSurvivors: bufferedResult.survivors,
      bufferedRate: bufferedResult.rate,
    };
  });

  return {
    kind,
    label: labelForKind(kind),
    strictTop: episodeStats(strict),
    bufferedTop: episodeStats(buffered),
    topReentryGap: topReentryGap(strict, sectorDefs),
    survival: survivalRows,
    topSetRetention: SET_RETENTION_HORIZONS.map((horizon) =>
      topSetRetention(history, kind, horizon),
    ),
    boundaryGap: boundaryGap(history, kind),
    scoreForwardCorrelations: scoreForwardCorrelations(
      history,
      kind,
      preparedBySector,
      kospiBars,
    ),
    scoreBands: scoreBandDiagnostics(history, kind, sectorDefs, preparedBySector, kospiBars),
  };
}

export function runSectorRotationDecompositionBacktest(input: MarketDataset): SectorRotationDecompositionResult | null {
  const dataset = buildFullUniverseSectorDataset(input);
  const kospi = dataset.indexSeries.find((series) => series.indexCode === "KOSPI");
  if (!kospi || kospi.bars.length <= MIN_LEVEL_INDEX + MOMENTUM_LOOKBACK) return null;

  const availableCodes = new Set(
    dataset.instruments
      .filter((instrument) => instrument.instrumentType === "STOCK")
      .map((instrument) => instrument.sectorCode),
  );
  const sectorDefs = THEME_SECTORS.filter(
    (sector) => sector.code !== "MARKET_IDX" && sector.code !== "ETC" && availableCodes.has(sector.code),
  );
  if (sectorDefs.length === 0) return null;

  const prepared = dataset.instruments
    .filter(
      (instrument) =>
        instrument.instrumentType === "STOCK" && sectorDefs.some((sector) => sector.code === instrument.sectorCode),
    )
    .map((instrument) => prepareInstrument(instrument, dataset.bars[instrument.symbol] ?? []))
    .filter((item) => item.bars.length > 1);
  const preparedBySector = new Map<string, PreparedInstrument[]>();
  for (const item of prepared) {
    const list = preparedBySector.get(item.instrument.sectorCode) ?? [];
    list.push(item);
    preparedBySector.set(item.instrument.sectorCode, list);
  }

  const history = buildRankHistory(dataset, prepared, sectorDefs);
  if (history.length === 0) return null;

  return {
    version: "CloudTrend V7.2",
    from: history[0]!.date,
    to: history[history.length - 1]!.date,
    tradingDays: history.length,
    sectorCount: sectorDefs.length,
    scoreBuckets: SCORE_BUCKETS,
    families: SCORE_KINDS.map((kind) =>
      familyDiagnostic(history, kind, sectorDefs, preparedBySector, kospi.bars),
    ),
    flowConfirmation: flowConfirmation(history),
    notes: [
      `V7.2는 매 거래일 ${sectorDefs.length}개 섹터의 Price Leadership, Money Flow, Rotation Momentum, Rotation Score를 0~100점대 상대점수로 계산합니다.`,
      "점수대별 분포는 섹터-거래일 기준입니다. 예를 들어 70~80점 관측치 100개는 특정 섹터가 여러 날짜에 반복 관측된 값을 포함합니다.",
      "점수대 체류기간은 같은 섹터가 같은 점수 구간에 연속으로 머문 거래일 수이며, 데이터 시작·종료 경계에 걸린 에피소드는 평균·중앙값에서 제외합니다.",
      "점수대별 수익률은 해당 점수 구간에 머무른 모든 섹터-거래일 기준 수익률과, 새로 그 점수 구간에 진입한 시점 기준 수익률을 분리해 제공합니다.",
      "상관계수는 점수와 향후 섹터 중앙값 수익률 및 KOSPI 대비 초과수익률 사이의 Pearson/Spearman 계수입니다. 상관관계는 인과관계를 의미하지 않습니다.",
      "섹터 수익률은 해당 섹터 구성 종목의 중앙값 수익률이며, 현재 확정 섹터 매핑을 과거에도 동일하게 적용합니다.",
    ],
  };
}
