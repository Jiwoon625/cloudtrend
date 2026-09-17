/** CloudTrend V8 Final — strict 10-point operating model. */
export const VF_MODEL_VERSION = 8;
export const VF_MODEL_LABEL = "V8 Final";

export const VF_FEATURE_WEIGHTS = {
  ICH_ABOVE_CLOUD: 1,
  ICH_TENKAN_KIJUN: 1,
  BB_BREAKOUT: 1.5,
  MA_ALIGNED: 1,
  VOLUME_SURGE: 0.5,
  NEAR_52W_HIGH: 2.5,
  FOREIGN_NET_POSITIVE: 2,
  SECTOR_PRICE_LEADERSHIP: 0.5,
} as const;

export const VF_FEATURE_WEIGHT_TOTAL = Object.values(VF_FEATURE_WEIGHTS).reduce(
  (sum, value) => sum + value,
  0,
);

/** V8 Final sector Price Leadership overheat threshold. PL >= 80 loses the 0.5-point slot. */
export const VF_SECTOR_PL_OVERHEAT_THRESHOLD = 80;

/** Raw 0~10 operating-score thresholds. */
export const VF_ENTRY_RAW_SCORE = 8;

/** Legacy V8 exit thresholds retained for non-KOSDAQ/backward-compatible consumers. */
export const VF_UPSIDE_EXIT_RAW_SCORE = 9.5;
export const VF_DOWNSIDE_EXIT_RAW_SCORE = 2.5;

/**
 * KOSDAQ operating exit validated by the 2026-09-17 3-FOS + untouched study.
 * Entry remains the 8.0 onset. The signal is a crossing event, not a persistent state.
 */
export const KOSDAQ_UPSIDE_EXIT_RAW_SCORE = 9;
export const KOSDAQ_DOWNSIDE_EXIT_RAW_SCORE = 3;
export const VF_DEFAULT_HORIZON_DAYS = 60;
export const KOSDAQ_MAX_HOLDING_DAYS = 60;

export type KosdaqOperationalExitSignal = "UP90" | "DOWN30" | null;

export function getKosdaqOperationalExitSignal(
  previousScore: number | null,
  currentScore: number | null,
  entryOnset = false,
): KosdaqOperationalExitSignal {
  if (previousScore === null || currentScore === null || entryOnset) return null;
  if (previousScore < KOSDAQ_UPSIDE_EXIT_RAW_SCORE && currentScore >= KOSDAQ_UPSIDE_EXIT_RAW_SCORE)
    return "UP90";
  if (
    previousScore > KOSDAQ_DOWNSIDE_EXIT_RAW_SCORE &&
    currentScore <= KOSDAQ_DOWNSIDE_EXIT_RAW_SCORE
  )
    return "DOWN30";
  return null;
}
/** Legacy percent-scale consumers use 80 for the 8.0/10 KOSDAQ Onset threshold. */
export const VF_DEFAULT_ENTRY_SCORE = 80;
