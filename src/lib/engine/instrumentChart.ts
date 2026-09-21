import type { MarketDataset } from "./dataset";
import { historicalInstrumentScore } from "./historicalInstrumentScore";
import { DEFAULT_SCORING_CONFIG, vfGrade, type ScoringConfig } from "./scoring";

export type InstrumentChartRange = "120" | "all";

/** Restrict output dates, never the input history used by indicators. */
export function instrumentChartPoint(
  ds: MarketDataset,
  symbol: string,
  index: number,
  cfg: ScoringConfig,
) {
  const bars = ds.bars[symbol] ?? [];
  const score = historicalInstrumentScore(ds, symbol, index, cfg);
  return {
    tradeDate: bars[index]!.tradeDate,
    close: bars[index]!.close,
    volume: bars[index]!.volume,
    historicalTechnicalPoints: score.points,
    historicalTechnical: score,
  };
}

export function compactChartSeries(
  ds: MarketDataset,
  symbol: string,
  range: InstrumentChartRange = "120",
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
) {
  const bars = ds.bars[symbol] ?? [];
  const start = range === "all" ? 0 : Math.max(0, bars.length - 120);
  return bars
    .slice(start)
    .map((_, offset) => instrumentChartPoint(ds, symbol, start + offset, cfg));
}

export type InstrumentChart = ReturnType<typeof compactChartSeries>;

export function chartScoreHistory(chart: InstrumentChart) {
  return chart.slice(-60).map((point) => ({
    tradeDate: point.tradeDate,
    technicalPoints: point.historicalTechnicalPoints,
    grade: vfGrade(
      point.historicalTechnicalPoints === null ? null : point.historicalTechnicalPoints * 10,
    ),
  }));
}

/** Yield between batches so the already-visible summary remains responsive. */
export async function buildCompactChart(
  ds: MarketDataset,
  symbol: string,
  range: InstrumentChartRange,
  cfg: ScoringConfig,
) {
  const bars = ds.bars[symbol] ?? [];
  const chart: InstrumentChart = [];
  for (let i = range === "all" ? 0 : Math.max(0, bars.length - 120); i < bars.length;) {
    const end = Math.min(i + 5, bars.length);
    for (; i < end; i++) chart.push(instrumentChartPoint(ds, symbol, i, cfg));
    if (i < bars.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { chart, history: chartScoreHistory(chart) };
}
