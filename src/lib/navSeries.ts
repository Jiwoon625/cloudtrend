export const NAV_SERIES = {
  A0_QUARTER_PRIMARY: { color: "#3b82f6", dash: undefined },
  A2_QUARTER_SHADOW: { color: "#a855f7", dash: undefined },
  B3_BETA_SHADOW: { color: "#0d9488", dash: undefined },
  SPY_BENCHMARK: { color: "#d97706", dash: "7 4" },
  KOSPI_SHADOW: { color: "#3b82f6", dash: undefined },
  KOSPI_BENCHMARK: { color: "#d97706", dash: "7 4" },
} as const;

export function navSeriesStyle(id: string) {
  return NAV_SERIES[id as keyof typeof NAV_SERIES] ?? { color: "#64748b", dash: undefined };
}
