/** CloudTrend Vf — 2026-09-09 validation-finalized defaults. */
export const VF_MODEL_VERSION = 5;
export const VF_MODEL_LABEL = "Vf";

export const VF_FEATURE_WEIGHTS = {
  ICH_ABOVE_CLOUD: 1,
  ICH_TENKAN_KIJUN: 1,
  BB_BREAKOUT: 1.5,
  MA_ALIGNED: 1,
  VOLUME_SURGE: 0.5,
  NEAR_52W_HIGH: 2.5,
  FOREIGN_NET_POSITIVE: 2,
} as const;

export const VF_FEATURE_WEIGHT_TOTAL = Object.values(VF_FEATURE_WEIGHTS).reduce(
  (sum, value) => sum + value,
  0,
);

export const VF_DEFAULT_HORIZON_DAYS = 30;
export const VF_DEFAULT_ENTRY_SCORE = 60;
