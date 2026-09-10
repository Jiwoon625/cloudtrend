import { computeIndicators } from "./indicators";
import {
  HISTORICAL_TECHNICAL_MAX,
  historicalTechnicalScore,
  type ScoringConfig,
} from "./scoring";
import type { MarketDataset } from "./dataset";
import type { AnalysisResult } from "./pipeline";

export const V6_ENTRY_ONSET_60 = 60;
export const V6_PRIORITY_ONSET_70 = 70;
export const V6_MOMENTUM_PEAK = 80;
export const V6_MOMENTUM_BREAK = 60;

export type V6MomentumStatus = "ENTRY_60" | "ENTRY_70" | "MOMENTUM_RISK" | null;

export interface V6MomentumSignal {
  status: V6MomentumStatus;
  currentScore: number | null;
  previousScore: number | null;
  onset60: boolean;
  onset70: boolean;
  momentumRisk: boolean;
  priorEpisodePeak: number | null;
}

/**
 * Full 9.5-point score -> 0~100 display scale.
 * Missing component data stays null; V6 never rescales a partial score.
 */
export function normalizedFullScore(rawScore: number | null | undefined): number | null {
  if (rawScore === null || rawScore === undefined || !Number.isFinite(rawScore)) return null;
  return (rawScore / HISTORICAL_TECHNICAL_MAX) * 100;
}

/**
 * Momentum risk persists while the stock remains below 60 after a completed 60+ episode
 * that reached 80+. A later recovery above 60 starts a new episode and clears the old risk.
 */
export function classifyV6Momentum(scores: Array<number | null>): V6MomentumSignal {
  const last = scores.length - 1;
  const currentScore = last >= 0 ? scores[last] ?? null : null;
  const previousScore = last > 0 ? scores[last - 1] ?? null : null;
  const onset60 =
    currentScore !== null && previousScore !== null && previousScore < 60 && currentScore >= 60;
  const onset70 =
    currentScore !== null && previousScore !== null && previousScore < 70 && currentScore >= 70;

  let momentumRisk = false;
  let priorEpisodePeak: number | null = null;
  if (currentScore !== null && currentScore < V6_MOMENTUM_BREAK) {
    let dropIndex = -1;
    for (let i = last; i >= 1; i--) {
      const cur = scores[i];
      const prev = scores[i - 1];
      if (cur === null || prev === null) continue;
      if (cur < V6_MOMENTUM_BREAK && prev >= V6_MOMENTUM_BREAK) {
        dropIndex = i;
        break;
      }
    }

    if (dropIndex >= 1) {
      let peak = -Infinity;
      let sawKnown = false;
      for (let j = dropIndex - 1; j >= 0; j--) {
        const score = scores[j];
        if (score === null) break;
        if (score < V6_MOMENTUM_BREAK) break;
        sawKnown = true;
        peak = Math.max(peak, score);
      }
      priorEpisodePeak = sawKnown ? peak : null;
      momentumRisk = priorEpisodePeak !== null && priorEpisodePeak >= V6_MOMENTUM_PEAK;
    }
  }

  const status: V6MomentumStatus = momentumRisk
    ? "MOMENTUM_RISK"
    : onset70
      ? "ENTRY_70"
      : onset60
        ? "ENTRY_60"
        : null;

  return {
    status,
    currentScore,
    previousScore,
    onset60,
    onset70,
    momentumRisk,
    priorEpisodePeak,
  };
}

function fullScoreHistory(
  ds: MarketDataset,
  symbol: string,
  cfg: ScoringConfig,
): Array<number | null> {
  const bars = ds.bars[symbol] ?? [];
  return bars.map((_, i) => {
    const raw = historicalTechnicalScore(computeIndicators(bars, i), cfg).points;
    return normalizedFullScore(raw);
  });
}

/** Apply V6 operational labels without changing the underlying score or ranking. */
export function applyV6MomentumStatuses(
  analysis: AnalysisResult,
  ds: MarketDataset,
  cfg: ScoringConfig,
): AnalysisResult {
  for (const row of analysis.rows) {
    if (row.instrument.instrumentType !== "STOCK") continue;
    const signal = classifyV6Momentum(fullScoreHistory(ds, row.instrument.symbol, cfg));
    if (signal.status === "MOMENTUM_RISK") row.actionLabelText = "모멘텀 위험";
    else if (signal.status === "ENTRY_70") row.actionLabelText = "우선진입후보";
    else if (signal.status === "ENTRY_60") row.actionLabelText = "진입후보";
  }
  return analysis;
}
