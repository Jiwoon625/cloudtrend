import type { MarketDataset } from "./dataset";
import type { DailyPrice } from "./types";

export const V8_SCORE_AVAILABILITY_VERSION = "v8-score-availability-v1" as const;

export interface V8ScoreAvailabilityBucket {
  totalDays: number;
  scoredDays: number;
  unavailableDays: number;
  warmupBefore120Days: number;
  high52wWarmupDays: number;
  foreign20dMissingDays: number;
  otherTechnicalMissingDays: number;
}

export interface V8ScoreAvailabilityReport extends V8ScoreAvailabilityBucket {
  version: typeof V8_SCORE_AVAILABILITY_VERSION;
  selectedSymbols: number;
  includedSymbols: number;
  excludedShortSeries: number;
  excludedShortSeriesRows: number;
  postWarmupCandidateDays: number;
  postWarmupUnavailableDays: number;
  scoredRatePct: number | null;
  postWarmupScoredRatePct: number | null;
  byYear: Record<string, V8ScoreAvailabilityBucket>;
  policy: {
    fullVfRequiresAllRules: true;
    missingForeignWindow: string;
    reasonPrecedence: string[];
  };
}

function bucket(): V8ScoreAvailabilityBucket {
  return {
    totalDays: 0,
    scoredDays: 0,
    unavailableDays: 0,
    warmupBefore120Days: 0,
    high52wWarmupDays: 0,
    foreign20dMissingDays: 0,
    otherTechnicalMissingDays: 0,
  };
}

function hasMissingForeign20d(bars: DailyPrice[], endIndex: number) {
  if (endIndex < 19) return true;
  for (let i = endIndex - 19; i <= endIndex; i++) {
    if (bars[i]?.foreignNetBuyValue === null || bars[i]?.foreignNetBuyValue === undefined) return true;
  }
  return false;
}

function hasUnavailableVolumeSignal(bars: DailyPrice[], endIndex: number) {
  const refStart = endIndex - 20;
  const refEnd = endIndex - 1;
  if (refStart < 0) return true;
  let positive = 0;
  let sum = 0;
  for (let i = refStart; i <= refEnd; i++) {
    const volume = bars[i]?.volume ?? 0;
    if (volume > 0) positive++;
    sum += volume;
  }
  if (positive * 2 < 20 || sum <= 0) return true;
  const bar = bars[endIndex];
  return !bar || !Number.isFinite(bar.high - bar.low) || bar.high - bar.low <= 0;
}

function mark(
  root: V8ScoreAvailabilityBucket,
  year: V8ScoreAvailabilityBucket,
  key: keyof Pick<
    V8ScoreAvailabilityBucket,
    "warmupBefore120Days" | "high52wWarmupDays" | "foreign20dMissingDays" | "otherTechnicalMissingDays"
  >,
) {
  root.unavailableDays++;
  year.unavailableDays++;
  root[key]++;
  year[key]++;
}

export function buildV8ScoreAvailabilityReport(
  dataset: MarketDataset,
  limit = 613,
): V8ScoreAvailabilityReport {
  const selected = [...dataset.instruments]
    .filter((inst) => inst.instrumentType === "STOCK")
    .sort(
      (a, b) =>
        (dataset.bars[b.symbol]?.at(-1)?.tradingValue ?? 0) -
        (dataset.bars[a.symbol]?.at(-1)?.tradingValue ?? 0),
    )
    .slice(0, Math.max(1, Math.round(limit)));

  const totals = bucket();
  const byYear: Record<string, V8ScoreAvailabilityBucket> = {};
  let includedSymbols = 0;
  let excludedShortSeries = 0;
  let excludedShortSeriesRows = 0;

  for (const inst of selected) {
    const bars = dataset.bars[inst.symbol] ?? [];
    if (bars.length < 130) {
      excludedShortSeries++;
      excludedShortSeriesRows += bars.length;
      continue;
    }
    includedSymbols++;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]!;
      const yearKey = bar.tradeDate.slice(0, 4) || "UNKNOWN";
      const year = (byYear[yearKey] ??= bucket());
      totals.totalDays++;
      year.totalDays++;

      if (i < 120) {
        mark(totals, year, "warmupBefore120Days");
        continue;
      }
      if (i < 251) {
        mark(totals, year, "high52wWarmupDays");
        continue;
      }
      if (hasMissingForeign20d(bars, i)) {
        mark(totals, year, "foreign20dMissingDays");
        continue;
      }
      if (hasUnavailableVolumeSignal(bars, i)) {
        mark(totals, year, "otherTechnicalMissingDays");
        continue;
      }

      totals.scoredDays++;
      year.scoredDays++;
    }
  }

  const postWarmupCandidateDays =
    totals.totalDays - totals.warmupBefore120Days - totals.high52wWarmupDays;
  const postWarmupUnavailableDays =
    totals.foreign20dMissingDays + totals.otherTechnicalMissingDays;

  return {
    version: V8_SCORE_AVAILABILITY_VERSION,
    selectedSymbols: selected.length,
    includedSymbols,
    excludedShortSeries,
    excludedShortSeriesRows,
    ...totals,
    postWarmupCandidateDays,
    postWarmupUnavailableDays,
    scoredRatePct: totals.totalDays ? (totals.scoredDays / totals.totalDays) * 100 : null,
    postWarmupScoredRatePct: postWarmupCandidateDays
      ? (totals.scoredDays / postWarmupCandidateDays) * 100
      : null,
    byYear,
    policy: {
      fullVfRequiresAllRules: true,
      missingForeignWindow:
        "foreignNetBuyValue is not coerced to zero; any null inside the rolling 20D window makes the Vf score unavailable",
      reasonPrecedence: [
        "warmupBefore120Days",
        "high52wWarmupDays",
        "foreign20dMissingDays",
        "otherTechnicalMissingDays",
      ],
    },
  };
}
