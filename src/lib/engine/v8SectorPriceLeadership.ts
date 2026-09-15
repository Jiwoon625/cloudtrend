import { percentile, periodReturn, sma } from "./indicators";
import type { MarketDataset } from "./dataset";

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);
const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)]! + sorted[Math.ceil(mid)]!) / 2;
};
const ratio = (yes: number, valid: number) => (valid > 0 ? (yes / valid) * 100 : null);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function averageTradingValue(values: number[], endIndex: number, period: number) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= endIndex; i++) sum += values[i]!;
  return sum / period;
}

function indexForDate(bars: Array<{ tradeDate: string }>, tradeDate: string) {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i]!.tradeDate === tradeDate) return i;
  return -1;
}

function percentileRatio(sortedAsc: number[], value: number | null) {
  if (!finite(value) || sortedAsc.length === 0) return null;
  return percentile(sortedAsc, value) / 100;
}

function combine(parts: Array<{ weight: number; ratio: number | null }>) {
  const available = parts.filter((part) => part.ratio !== null);
  const weight = available.reduce((sum, part) => sum + part.weight, 0);
  if (weight === 0) return null;
  return (available.reduce((sum, part) => sum + part.weight * (part.ratio ?? 0), 0) / weight) * 100;
}

interface SectorAggregate {
  r20: number[];
  r60: number[];
  r120: number[];
  turnover5: number;
  turnover20: number;
  turnover5Valid: number;
  turnover20Valid: number;
  advancingYes: number;
  advancingValid: number;
  aboveMa20Yes: number;
  aboveMa20Valid: number;
  aboveMa60Yes: number;
  aboveMa60Valid: number;
  aboveMa120Yes: number;
  aboveMa120Valid: number;
  maAlignedYes: number;
  maAlignedValid: number;
  nearHighYes: number;
  nearHighValid: number;
}

function emptyAggregate(): SectorAggregate {
  return {
    r20: [], r60: [], r120: [], turnover5: 0, turnover20: 0,
    turnover5Valid: 0, turnover20Valid: 0, advancingYes: 0, advancingValid: 0,
    aboveMa20Yes: 0, aboveMa20Valid: 0, aboveMa60Yes: 0, aboveMa60Valid: 0,
    aboveMa120Yes: 0, aboveMa120Valid: 0, maAlignedYes: 0, maAlignedValid: 0,
    nearHighYes: 0, nearHighValid: 0,
  };
}

function addFlag(
  aggregate: SectorAggregate,
  yesKey: "advancingYes" | "aboveMa20Yes" | "aboveMa60Yes" | "aboveMa120Yes" | "maAlignedYes" | "nearHighYes",
  validKey: "advancingValid" | "aboveMa20Valid" | "aboveMa60Valid" | "aboveMa120Valid" | "maAlignedValid" | "nearHighValid",
  value: boolean | null,
) {
  if (value === null) return;
  aggregate[validKey] += 1;
  if (value) aggregate[yesKey] += 1;
}

/** V8 Final technical score's 0.5-point Sector Price Leadership snapshot. */
export function computeV8SectorPriceLeadership(
  dataset: MarketDataset,
  offset = 0,
): Map<string, number> {
  const benchmark = dataset.indexSeries.find((series) => series.indexCode === "KOSPI");
  if (!benchmark) return new Map();
  const benchmarkIndex = benchmark.bars.length - 1 - offset;
  if (benchmarkIndex < 120) return new Map();
  const targetDate = benchmark.bars[benchmarkIndex]!.tradeDate;
  const benchmarkCloses = benchmark.bars.map((bar) => bar.close);
  const market20 = periodReturn(benchmarkCloses, benchmarkIndex, 20);
  const market60 = periodReturn(benchmarkCloses, benchmarkIndex, 60);
  const market120 = periodReturn(benchmarkCloses, benchmarkIndex, 120);
  const aggregates = new Map<string, SectorAggregate>();

  for (const instrument of dataset.instruments) {
    if (
      instrument.instrumentType !== "STOCK" || !instrument.isActive ||
      instrument.sectorCode === "MARKET_IDX" || instrument.sectorCode === "ETC"
    ) continue;
    const bars = dataset.bars[instrument.symbol] ?? [];
    const index = indexForDate(bars, targetDate);
    if (index < 120) continue;
    const previous = bars[index - 1];
    if (!previous) continue;
    const closes = bars.map((bar) => bar.close);
    const tradingValues = bars.map((bar) => bar.tradingValue);
    const aggregate = aggregates.get(instrument.sectorCode) ?? emptyAggregate();
    const r20 = periodReturn(closes, index, 20);
    const r60 = periodReturn(closes, index, 60);
    const r120 = periodReturn(closes, index, 120);
    if (finite(r20)) aggregate.r20.push(r20);
    if (finite(r60)) aggregate.r60.push(r60);
    if (finite(r120)) aggregate.r120.push(r120);

    const ma20 = sma(closes, 20, index);
    const ma60 = sma(closes, 60, index);
    const ma120 = sma(closes, 120, index);
    const close = bars[index]!.close;
    addFlag(aggregate, "advancingYes", "advancingValid", close > previous.close);
    addFlag(aggregate, "aboveMa20Yes", "aboveMa20Valid", ma20 === null ? null : close > ma20);
    addFlag(aggregate, "aboveMa60Yes", "aboveMa60Valid", ma60 === null ? null : close > ma60);
    addFlag(aggregate, "aboveMa120Yes", "aboveMa120Valid", ma120 === null ? null : close > ma120);
    addFlag(aggregate, "maAlignedYes", "maAlignedValid", ma20 === null || ma60 === null || ma120 === null ? null : ma20 > ma60 && ma60 > ma120);
    const highWindow = bars.slice(Math.max(0, index - 249), index + 1);
    const high52 = highWindow.length >= 60 ? Math.max(...highWindow.map((bar) => bar.high)) : null;
    addFlag(aggregate, "nearHighYes", "nearHighValid", high52 === null ? null : close >= high52 * 0.95);
    const turnover5 = averageTradingValue(tradingValues, index, 5);
    const turnover20 = averageTradingValue(tradingValues, index, 20);
    if (finite(turnover5)) { aggregate.turnover5 += turnover5; aggregate.turnover5Valid += 1; }
    if (finite(turnover20)) { aggregate.turnover20 += turnover20; aggregate.turnover20Valid += 1; }
    aggregates.set(instrument.sectorCode, aggregate);
  }

  const raw = [...aggregates.entries()].map(([sectorCode, aggregate]) => {
    const equal20 = median(aggregate.r20);
    const equal60 = median(aggregate.r60);
    const equal120 = median(aggregate.r120);
    return {
      sectorCode,
      rs20: finite(equal20) && finite(market20) ? (equal20 - market20) * 100 : null,
      rs60: finite(equal60) && finite(market60) ? (equal60 - market60) * 100 : null,
      rs120: finite(equal120) && finite(market120) ? (equal120 - market120) * 100 : null,
      advancing: ratio(aggregate.advancingYes, aggregate.advancingValid),
      aboveMa20: ratio(aggregate.aboveMa20Yes, aggregate.aboveMa20Valid),
      aboveMa60: ratio(aggregate.aboveMa60Yes, aggregate.aboveMa60Valid),
      aboveMa120: ratio(aggregate.aboveMa120Yes, aggregate.aboveMa120Valid),
      maAligned: ratio(aggregate.maAlignedYes, aggregate.maAlignedValid),
      nearHigh: ratio(aggregate.nearHighYes, aggregate.nearHighValid),
      relativeTurnover:
        aggregate.turnover5Valid > 0 && aggregate.turnover20Valid > 0 && aggregate.turnover20 > 0
          ? aggregate.turnover5 / aggregate.turnover20 : null,
    };
  });

  const rs20 = raw.map((row) => row.rs20).filter(finite).sort((a, b) => a - b);
  const rs60 = raw.map((row) => row.rs60).filter(finite).sort((a, b) => a - b);
  const rs120 = raw.map((row) => row.rs120).filter(finite).sort((a, b) => a - b);
  const scores = new Map<string, number>();
  for (const row of raw) {
    const trend = [row.aboveMa20, row.aboveMa60, row.aboveMa120].filter(finite).map((value) => value / 100);
    const breadth = [row.advancing, row.aboveMa20, row.maAligned].filter(finite).map((value) => value / 100);
    const score = combine([
      { weight: 20, ratio: percentileRatio(rs20, row.rs20) },
      { weight: 20, ratio: percentileRatio(rs60, row.rs60) },
      { weight: 10, ratio: percentileRatio(rs120, row.rs120) },
      { weight: 15, ratio: mean(trend) },
      { weight: 20, ratio: mean(breadth) },
      { weight: 10, ratio: row.nearHigh === null ? null : row.nearHigh / 100 },
      { weight: 5, ratio: row.relativeTurnover === null ? null : clamp01((row.relativeTurnover - 0.7) / 0.8) },
    ]);
    if (finite(score)) scores.set(row.sectorCode, score);
  }
  return scores;
}
