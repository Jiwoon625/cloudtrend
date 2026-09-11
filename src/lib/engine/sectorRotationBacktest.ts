import type { MarketDataset } from "./dataset";
import { DEFAULT_ROTATION_WEIGHTS } from "./sectorRotation";
import { buildFullUniverseSectorDataset } from "./sectorRotationFullUniverse";
import { THEME_SECTORS } from "./sectors";
import type { DailyPrice, Instrument } from "./types";

export type SectorRankGroup = "TOP" | "MID" | "BOTTOM";

export interface EpisodeStats {
  episodes: number;
  avgDays: number | null;
  medianDays: number | null;
  p25Days: number | null;
  p75Days: number | null;
  maxDays: number | null;
}

export interface GroupResidencyStat extends EpisodeStats {
  group: SectorRankGroup;
  label: string;
}

export interface SectorResidencyStat {
  sectorCode: string;
  sectorName: string;
  topEpisodes: number;
  topAvgDays: number | null;
  topMedianDays: number | null;
  bufferedTopEpisodes: number;
  bufferedTopAvgDays: number | null;
  bufferedTopMedianDays: number | null;
  top20dSurvivalRate: number | null;
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

export interface TransitionRow {
  from: SectorRankGroup;
  top: number;
  mid: number;
  bottom: number;
  observations: number;
}

export interface TransitionStat {
  horizon: number;
  rows: TransitionRow[];
}

export interface TopEntryPerformanceStat {
  horizon: number;
  observations: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  avgExcessReturn: number | null;
  medianExcessReturn: number | null;
  excessWinRate: number | null;
}

export interface SectorRotationBacktestResult {
  from: string;
  to: string;
  tradingDays: number;
  sectorCount: number;
  sectorNames: string[];
  topRange: string;
  midRange: string;
  bottomRange: string;
  groupResidency: GroupResidencyStat[];
  strictTop: EpisodeStats;
  bufferedTop: EpisodeStats;
  topReentryGap: EpisodeStats;
  survival: SurvivalStat[];
  transitions: TransitionStat[];
  sectorResidency: SectorResidencyStat[];
  topEntryCount: number;
  topEntryPerformance: TopEntryPerformanceStat[];
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
  turnover1: number;
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
  turnover1: number;
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
  turnoverShareDiff: number;
  bothBuy5: number | null;
}

interface DailyRankRow extends LevelScore {
  rank: number;
  rotationMomentum: number | null;
  rotationScore: number;
  group: SectorRankGroup;
}

interface DailyRanking {
  date: string;
  marketIndex: number;
  rows: DailyRankRow[];
}

interface Episode {
  sectorCode: string;
  sectorName: string;
  group: SectorRankGroup;
  startDate: string;
  endDate: string;
  startMarketIndex: number;
  endMarketIndex: number;
  duration: number;
  leftCensored: boolean;
  rightCensored: boolean;
}

const MIN_LEVEL_INDEX = 120;
const MOMENTUM_LOOKBACK = 5;
const TOP_MAX_RANK = 4;
const MID_MAX_RANK = 10;
const BUFFERED_TOP_EXIT_RANK = 6;
const SURVIVAL_HORIZONS = [5, 10, 20, 40];
const TRANSITION_HORIZONS = [1, 5];

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function quantile(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const position = ((sorted.length - 1) * percentile) / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function median(values: number[]): number | null {
  return quantile(values, 50);
}

function episodeStats(episodes: Episode[]): EpisodeStats {
  const completed = episodes.filter((e) => !e.leftCensored && !e.rightCensored);
  const days = completed.map((e) => e.duration);
  return {
    episodes: completed.length,
    avgDays: mean(days),
    medianDays: median(days),
    p25Days: quantile(days, 25),
    p75Days: quantile(days, 75),
    maxDays: days.length ? Math.max(...days) : null,
  };
}

function statsFromDurations(days: number[]): EpisodeStats {
  return {
    episodes: days.length,
    avgDays: mean(days),
    medianDays: median(days),
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
  const foreign = nullablePrefix(bars.map((b) => b.foreignNetBuyValue));
  const institution = nullablePrefix(bars.map((b) => b.institutionNetBuyValue));
  return {
    instrument,
    bars,
    dateIndex: new Map(bars.map((b, i) => [b.tradeDate, i])),
    closePrefix: prefix(bars.map((b) => b.close)),
    turnoverPrefix: prefix(bars.map((b) => b.tradingValue)),
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
    turnover1: bar.tradingValue,
    turnover5: turnoverAvg(5),
    turnover20: turnoverAvg(20),
    aboveMa20: ma20 === null ? null : bar.close > ma20,
    aboveMa60: ma60 === null ? null : bar.close > ma60,
    aboveMa120: ma120 === null ? null : bar.close > ma120,
    maAligned: ma20 === null || ma60 === null || ma120 === null ? null : ma20 > ma60 && ma60 > ma120,
    nearHigh: Number.isFinite(high) ? bar.close >= high * 0.95 : null,
    advancing: bar.close > prepared.bars[index - 1]!.close,
    foreign5: nullableWindowSum(
      prepared.foreignPrefix,
      prepared.foreignMissingPrefix,
      index,
      5,
    ),
    institution5: nullableWindowSum(
      prepared.institutionPrefix,
      prepared.institutionMissingPrefix,
      index,
      5,
    ),
  };
}

function ratio(trueCount: number, validCount: number): number | null {
  return validCount > 0 ? (trueCount / validCount) * 100 : null;
}

function addBoolean(value: boolean | null, aggregate: SectorAggregate, key: "aboveMa20" | "aboveMa60" | "aboveMa120" | "maAligned" | "nearHigh" | "advancing") {
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
    turnover1: 0,
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
  const allowed = new Set(sectorDefs.map((s) => s.code));
  const names = new Map(sectorDefs.map((s) => [s.code, s.name]));
  const aggregates = new Map<string, SectorAggregate>();

  for (const item of prepared) {
    const code = item.instrument.sectorCode;
    if (!allowed.has(code)) continue;
    const metric = memberMetric(item, date);
    if (!metric) continue;
    const agg = aggregates.get(code) ?? createAggregate(code, names.get(code) ?? item.instrument.sectorName);
    agg.memberCount++;
    if (finite(metric.r20)) agg.r20.push(metric.r20);
    if (finite(metric.r60)) agg.r60.push(metric.r60);
    if (finite(metric.r120)) agg.r120.push(metric.r120);
    agg.turnover1 += metric.turnover1;
    if (finite(metric.turnover5)) {
      agg.turnover5 += metric.turnover5;
      agg.turnover5Count++;
    }
    if (finite(metric.turnover20)) {
      agg.turnover20 += metric.turnover20;
      agg.turnover20Count++;
    }
    addBoolean(metric.aboveMa20, agg, "aboveMa20");
    addBoolean(metric.aboveMa60, agg, "aboveMa60");
    addBoolean(metric.aboveMa120, agg, "aboveMa120");
    addBoolean(metric.maAligned, agg, "maAligned");
    addBoolean(metric.nearHigh, agg, "nearHigh");
    addBoolean(metric.advancing, agg, "advancing");
    if (finite(metric.foreign5)) {
      agg.foreign5Sum += metric.foreign5;
      agg.foreign5Valid++;
    }
    if (finite(metric.institution5)) {
      agg.institution5Sum += metric.institution5;
      agg.institution5Valid++;
    }
    if (finite(metric.foreign5) && finite(metric.institution5)) {
      agg.bothBuyValid++;
      if (metric.foreign5 > 0 && metric.institution5 > 0) agg.bothBuyTrue++;
    }
    aggregates.set(code, agg);
  }

  const mr20 = periodReturn(kospiBars, marketIndex, 20);
  const mr60 = periodReturn(kospiBars, marketIndex, 60);
  const mr120 = periodReturn(kospiBars, marketIndex, 120);
  const complete = sectorDefs
    .map((def) => aggregates.get(def.code))
    .filter((x): x is SectorAggregate => x !== undefined && x.memberCount > 0);
  const total5 = complete.reduce((sum, x) => sum + (x.turnover5Count ? x.turnover5 : 0), 0);
  const total20 = complete.reduce((sum, x) => sum + (x.turnover20Count ? x.turnover20 : 0), 0);

  return complete.map((agg) => {
    const eq20 = median(agg.r20);
    const eq60 = median(agg.r60);
    const eq120 = median(agg.r120);
    return {
      sectorCode: agg.sectorCode,
      sectorName: agg.sectorName,
      rs20: finite(eq20) && finite(mr20) ? (eq20 - mr20) * 100 : null,
      rs60: finite(eq60) && finite(mr60) ? (eq60 - mr60) * 100 : null,
      rs120: finite(eq120) && finite(mr120) ? (eq120 - mr120) * 100 : null,
      turnoverShare5: total5 > 0 ? (agg.turnover5 / total5) * 100 : 0,
      turnoverShare20: total20 > 0 ? (agg.turnover20 / total20) * 100 : 0,
      relativeTurnover:
        agg.turnover5Count > 0 && agg.turnover20Count > 0 && agg.turnover20 > 0
          ? agg.turnover5 / agg.turnover20
          : null,
      advancing: ratio(agg.advancingTrue, agg.advancingValid),
      aboveMa20: ratio(agg.aboveMa20True, agg.aboveMa20Valid),
      aboveMa60: ratio(agg.aboveMa60True, agg.aboveMa60Valid),
      aboveMa120: ratio(agg.aboveMa120True, agg.aboveMa120Valid),
      maAligned: ratio(agg.maAlignedTrue, agg.maAlignedValid),
      nearHigh: ratio(agg.nearHighTrue, agg.nearHighValid),
      bothBuy5: ratio(agg.bothBuyTrue, agg.bothBuyValid),
      foreign5: agg.foreign5Valid > 0 ? agg.foreign5Sum : null,
      institution5: agg.institution5Valid > 0 ? agg.institution5Sum : null,
      turnover20Total: agg.turnover20Count > 0 && agg.turnover20 > 0 ? agg.turnover20 : null,
    };
  });
}

function percentileRatio(sortedAsc: number[], value: number | null): number | null {
  if (!finite(value) || sortedAsc.length === 0) return null;
  let below = 0;
  for (const x of sortedAsc) if (x < value) below++;
  return below / sortedAsc.length;
}

function combine(parts: Array<{ weight: number; ratio: number | null }>): number | null {
  const available = parts.filter((p) => p.ratio !== null);
  const weight = available.reduce((sum, p) => sum + p.weight, 0);
  if (weight === 0) return null;
  return (
    (available.reduce((sum, p) => sum + p.weight * (p.ratio ?? 0), 0) / weight) *
    100
  );
}

function averageRatios(values: Array<number | null>): number | null {
  const valid = values.filter(finite).map((x) => x / 100);
  return mean(valid);
}

function scoreLevel(raw: RawSectorDay[]): LevelScore[] {
  const sorted = (get: (row: RawSectorDay) => number | null) =>
    raw.map(get).filter(finite).sort((a, b) => a - b);
  const rs20s = sorted((r) => r.rs20);
  const rs60s = sorted((r) => r.rs60);
  const rs120s = sorted((r) => r.rs120);
  const foreignIntensity = (r: RawSectorDay) =>
    finite(r.foreign5) && finite(r.turnover20Total) && r.turnover20Total > 0
      ? r.foreign5 / r.turnover20Total
      : null;
  const institutionIntensity = (r: RawSectorDay) =>
    finite(r.institution5) && finite(r.turnover20Total) && r.turnover20Total > 0
      ? r.institution5 / r.turnover20Total
      : null;
  const foreigns = sorted(foreignIntensity);
  const institutions = sorted(institutionIntensity);
  const shareDiff = (r: RawSectorDay) => r.turnoverShare5 - r.turnoverShare20;
  const shares = sorted(shareDiff);

  return raw.map((r) => {
    const trend = averageRatios([r.aboveMa20, r.aboveMa60, r.aboveMa120]);
    const breadth = averageRatios([r.advancing, r.aboveMa20, r.maAligned]);
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
    const flow = combine([
      { weight: 25, ratio: percentileRatio(foreigns, foreignIntensity(r)) },
      { weight: 20, ratio: percentileRatio(institutions, institutionIntensity(r)) },
      { weight: 10, ratio: r.bothBuy5 === null ? null : r.bothBuy5 / 100 },
      { weight: 15, ratio: percentileRatio(shares, shareDiff(r)) },
      { weight: 10, ratio: null },
      { weight: 10, ratio: null },
      { weight: 10, ratio: null },
    ]);
    return {
      sectorCode: r.sectorCode,
      sectorName: r.sectorName,
      price,
      flow,
      turnoverShareDiff: shareDiff(r),
      bothBuy5: r.bothBuy5,
    };
  });
}

function groupOf(rank: number): SectorRankGroup {
  if (rank <= TOP_MAX_RANK) return "TOP";
  if (rank <= MID_MAX_RANK) return "MID";
  return "BOTTOM";
}

function buildRankHistory(
  dataset: MarketDataset,
  prepared: PreparedInstrument[],
  sectorDefs: Array<{ code: string; name: string }>,
): DailyRanking[] {
  const kospi = dataset.indexSeries.find((s) => s.indexCode === "KOSPI");
  if (!kospi || kospi.bars.length <= MIN_LEVEL_INDEX + MOMENTUM_LOOKBACK) return [];
  const levelByIndex = new Map<number, LevelScore[]>();
  const output: DailyRanking[] = [];

  for (let marketIndex = MIN_LEVEL_INDEX; marketIndex < kospi.bars.length; marketIndex++) {
    const date = kospi.bars[marketIndex]!.tradeDate;
    const raw = buildRawSectorDay(prepared, sectorDefs, date, kospi.bars, marketIndex);
    if (raw.length !== sectorDefs.length) continue;
    const level = scoreLevel(raw);
    levelByIndex.set(marketIndex, level);

    const previous = levelByIndex.get(marketIndex - MOMENTUM_LOOKBACK);
    if (!previous) continue;
    const prevByCode = new Map(previous.map((x) => [x.sectorCode, x]));
    const drafts = level.map((current) => {
      const prev = prevByCode.get(current.sectorCode);
      return {
        ...current,
        momentumParts: [
          finite(current.price) && finite(prev?.price) ? current.price - prev.price : null,
          finite(current.flow) && finite(prev?.flow) ? current.flow - prev.flow : null,
          current.turnoverShareDiff,
          finite(current.bothBuy5) && finite(prev?.bothBuy5)
            ? current.bothBuy5 - prev.bothBuy5
            : null,
        ],
      };
    });
    const momentumSeries = [0, 1, 2, 3].map((part) =>
      drafts
        .map((d) => d.momentumParts[part])
        .filter(finite)
        .sort((a, b) => a - b),
    );
    const rows = drafts
      .map((draft) => {
        const ratios = draft.momentumParts
          .map((value, part) => percentileRatio(momentumSeries[part]!, value))
          .filter(finite);
        const rotationMomentum = ratios.length ? mean(ratios)! * 100 : null;
        const weighted = [
          [DEFAULT_ROTATION_WEIGHTS.priceLeadership, draft.price] as const,
          [DEFAULT_ROTATION_WEIGHTS.moneyFlow, draft.flow] as const,
          [DEFAULT_ROTATION_WEIGHTS.rotationMomentum, rotationMomentum] as const,
        ];
        const availableWeight = weighted
          .filter(([, value]) => finite(value))
          .reduce((sum, [weight]) => sum + weight, 0);
        const rotationScore =
          availableWeight === 0
            ? 0
            : weighted.reduce(
                (sum, [weight, value]) => sum + (finite(value) ? weight * value : 0),
                0,
              ) / availableWeight;
        return {
          sectorCode: draft.sectorCode,
          sectorName: draft.sectorName,
          price: draft.price,
          flow: draft.flow,
          turnoverShareDiff: draft.turnoverShareDiff,
          bothBuy5: draft.bothBuy5,
          rotationMomentum,
          rotationScore,
        };
      })
      .sort((a, b) => b.rotationScore - a.rotationScore)
      .map((row, index) => ({ ...row, rank: index + 1, group: groupOf(index + 1) }));

    output.push({ date, marketIndex, rows });
  }
  return output;
}

function strictEpisodes(history: DailyRanking[], sectorDefs: Array<{ code: string; name: string }>): Episode[] {
  const episodes: Episode[] = [];
  for (const sector of sectorDefs) {
    let current: Episode | null = null;
    let previousMarketIndex: number | null = null;
    history.forEach((day, position) => {
      const row = day.rows.find((x) => x.sectorCode === sector.code);
      if (!row) return;
      const gap = previousMarketIndex !== null && day.marketIndex !== previousMarketIndex + 1;
      if (gap && current) {
        current.rightCensored = true;
        episodes.push(current);
        current = null;
      }
      if (!current || current.group !== row.group) {
        if (current) episodes.push(current);
        current = {
          sectorCode: sector.code,
          sectorName: sector.name,
          group: row.group,
          startDate: day.date,
          endDate: day.date,
          startMarketIndex: day.marketIndex,
          endMarketIndex: day.marketIndex,
          duration: 1,
          leftCensored: position === 0 || gap,
          rightCensored: false,
        };
      } else {
        current.endDate = day.date;
        current.endMarketIndex = day.marketIndex;
        current.duration++;
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

function bufferedTopEpisodes(history: DailyRanking[], sectorDefs: Array<{ code: string; name: string }>): Episode[] {
  const episodes: Episode[] = [];
  for (const sector of sectorDefs) {
    let current: Episode | null = null;
    let previousMarketIndex: number | null = null;
    history.forEach((day, position) => {
      const row = day.rows.find((x) => x.sectorCode === sector.code);
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
          group: "TOP",
          startDate: day.date,
          endDate: day.date,
          startMarketIndex: day.marketIndex,
          endMarketIndex: day.marketIndex,
          duration: 1,
          leftCensored: position === 0 || gap,
          rightCensored: false,
        };
      } else if (current && row.rank < BUFFERED_TOP_EXIT_RANK) {
        current.endDate = day.date;
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
  const entries = episodes.filter((e) => !e.leftCensored);
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

function transitionStat(history: DailyRanking[], horizon: number, sectorDefs: Array<{ code: string; name: string }>): TransitionStat {
  const byIndex = new Map(history.map((day) => [day.marketIndex, day]));
  const groups: SectorRankGroup[] = ["TOP", "MID", "BOTTOM"];
  const counts = new Map(groups.map((group) => [group, { TOP: 0, MID: 0, BOTTOM: 0 }]));
  for (const day of history) {
    const future = byIndex.get(day.marketIndex + horizon);
    if (!future) continue;
    const futureByCode = new Map(future.rows.map((row) => [row.sectorCode, row.group]));
    for (const sector of sectorDefs) {
      const from = day.rows.find((row) => row.sectorCode === sector.code)?.group;
      const to = futureByCode.get(sector.code);
      if (!from || !to) continue;
      counts.get(from)![to]++;
    }
  }
  const rows = groups.map((from) => {
    const value = counts.get(from)!;
    const observations = value.TOP + value.MID + value.BOTTOM;
    return {
      from,
      top: observations ? (value.TOP / observations) * 100 : 0,
      mid: observations ? (value.MID / observations) * 100 : 0,
      bottom: observations ? (value.BOTTOM / observations) * 100 : 0,
      observations,
    };
  });
  return { horizon, rows };
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
  return median(returns);
}

function performanceStats(
  strictTopEpisodes: Episode[],
  preparedBySector: Map<string, PreparedInstrument[]>,
  kospiBars: DailyPrice[],
): TopEntryPerformanceStat[] {
  const entries = strictTopEpisodes.filter((e) => !e.leftCensored);
  return SURVIVAL_HORIZONS.map((horizon) => {
    const returns: number[] = [];
    const excess: number[] = [];
    for (const entry of entries) {
      const endIndex = entry.startMarketIndex + horizon;
      if (endIndex >= kospiBars.length) continue;
      const startBar = kospiBars[entry.startMarketIndex];
      const endBar = kospiBars[endIndex];
      if (!startBar || !endBar || startBar.close <= 0) continue;
      const sectorReturn = sectorForwardReturn(
        preparedBySector,
        entry.sectorCode,
        entry.startDate,
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
      medianReturn: median(returns),
      winRate: returns.length ? (returns.filter((x) => x > 0).length / returns.length) * 100 : null,
      avgExcessReturn: mean(excess),
      medianExcessReturn: median(excess),
      excessWinRate: excess.length ? (excess.filter((x) => x > 0).length / excess.length) * 100 : null,
    };
  });
}

function topReentryGap(strictTopEpisodes: Episode[], sectorDefs: Array<{ code: string; name: string }>): EpisodeStats {
  const gaps: number[] = [];
  for (const sector of sectorDefs) {
    const starts = strictTopEpisodes
      .filter((e) => e.sectorCode === sector.code && !e.leftCensored)
      .map((e) => e.startMarketIndex)
      .sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) gaps.push(starts[i]! - starts[i - 1]!);
  }
  return statsFromDurations(gaps);
}

export function runSectorRotationBacktest(input: MarketDataset): SectorRotationBacktestResult | null {
  const dataset = buildFullUniverseSectorDataset(input);
  const kospi = dataset.indexSeries.find((s) => s.indexCode === "KOSPI");
  if (!kospi || kospi.bars.length <= MIN_LEVEL_INDEX + MOMENTUM_LOOKBACK) return null;

  const availableCodes = new Set(
    dataset.instruments.filter((i) => i.instrumentType === "STOCK").map((i) => i.sectorCode),
  );
  const sectorDefs = THEME_SECTORS.filter(
    (sector) => sector.code !== "MARKET_IDX" && sector.code !== "ETC" && availableCodes.has(sector.code),
  );
  if (sectorDefs.length === 0) return null;

  const prepared = dataset.instruments
    .filter((i) => i.instrumentType === "STOCK" && sectorDefs.some((s) => s.code === i.sectorCode))
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
  const strict = strictEpisodes(history, sectorDefs);
  const buffered = bufferedTopEpisodes(history, sectorDefs);
  const strictTop = strict.filter((e) => e.group === "TOP");

  const groupLabels: Record<SectorRankGroup, string> = {
    TOP: "상위권 1~4위",
    MID: "중위권 5~10위",
    BOTTOM: "하위권 11~14위",
  };
  const groupResidency = (["TOP", "MID", "BOTTOM"] as SectorRankGroup[]).map((group) => ({
    group,
    label: groupLabels[group],
    ...episodeStats(strict.filter((e) => e.group === group)),
  }));
  const survivalRows = SURVIVAL_HORIZONS.map((horizon) => {
    const strictResult = survival(strictTop, horizon);
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
  const sectorResidency = sectorDefs.map((sector) => {
    const sectorStrict = strictTop.filter((e) => e.sectorCode === sector.code);
    const sectorBuffered = buffered.filter((e) => e.sectorCode === sector.code);
    const strictStats = episodeStats(sectorStrict);
    const bufferedStats = episodeStats(sectorBuffered);
    return {
      sectorCode: sector.code,
      sectorName: sector.name,
      topEpisodes: strictStats.episodes,
      topAvgDays: strictStats.avgDays,
      topMedianDays: strictStats.medianDays,
      bufferedTopEpisodes: bufferedStats.episodes,
      bufferedTopAvgDays: bufferedStats.avgDays,
      bufferedTopMedianDays: bufferedStats.medianDays,
      top20dSurvivalRate: survival(sectorStrict, 20).rate,
    };
  });

  return {
    from: history[0]!.date,
    to: history[history.length - 1]!.date,
    tradingDays: history.length,
    sectorCount: sectorDefs.length,
    sectorNames: sectorDefs.map((s) => s.name),
    topRange: "1~4위",
    midRange: "5~10위",
    bottomRange: "11~14위",
    groupResidency,
    strictTop: episodeStats(strictTop),
    bufferedTop: episodeStats(buffered),
    topReentryGap: topReentryGap(strictTop, sectorDefs),
    survival: survivalRows,
    transitions: TRANSITION_HORIZONS.map((horizon) => transitionStat(history, horizon, sectorDefs)),
    sectorResidency,
    topEntryCount: strictTop.filter((e) => !e.leftCensored).length,
    topEntryPerformance: performanceStats(strictTop, preparedBySector, kospi.bars),
    notes: [
      `매 거래일 ${sectorDefs.length}개 섹터의 로테이션 점수를 재계산하고 1~4위/5~10위/11~14위로 구분했습니다.`,
      "Strict 상위권은 5위가 되는 즉시 체류 종료, Buffered 상위권은 4위 이내 진입 후 5위까지 유지하고 6위 이하에서 종료합니다.",
      "체류기간 평균·중앙값은 시작 또는 종료가 데이터 경계에 걸린 검열(censored) 에피소드를 제외해 경계 편향을 줄였습니다.",
      "Top4 신규진입 성과의 섹터 수익률은 해당 섹터 구성 종목의 중앙값 수익률이며, 초과수익은 같은 기간 KOSPI 수익률을 차감했습니다.",
      "현재 확정 섹터 매핑을 과거에도 동일하게 적용하므로 과거 시점의 실제 편입·산업분류 변경을 완전히 재현하지는 못합니다.",
      "가격리더십 40% + 자금흐름 45% + 로테이션 모멘텀 15%의 현재 CloudTrend 기본 가중치를 사용합니다.",
    ],
  };
}
