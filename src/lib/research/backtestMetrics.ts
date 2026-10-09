import { validDate } from "../ledger/date";

export interface BacktestNavPoint {
  date: string;
  nav: string | number | null;
  valuationStatus?: "COMPLETE" | "STALE" | "MISSING";
}

/** Returns fractions, not percentage points. No terminal forced liquidation. */
export function fullPeriodBacktestMetrics(input: {
  initialCapital: string | number;
  startDate: string;
  dailyNAV: readonly BacktestNavPoint[];
}) {
  if (!validDate(input.startDate)) throw new Error("Invalid backtest start date");
  const initial = Number(input.initialCapital);
  if (!Number.isFinite(initial) || initial <= 0) throw new Error("Invalid initial capital");
  let previous = "";
  let peak = initial;
  let mdd = 0;
  let missing = 0;
  let stale = 0;
  for (const point of input.dailyNAV) {
    if (!validDate(point.date) || point.date < input.startDate || point.date <= previous)
      throw new Error("Backtest NAV must have unique, increasing actual dates");
    previous = point.date;
    if (point.valuationStatus === "STALE") stale++;
    if (
      point.nav === null ||
      point.valuationStatus === "MISSING" ||
      !Number.isFinite(Number(point.nav)) ||
      Number(point.nav) < 0
    ) {
      missing++;
      continue;
    }
    const nav = Number(point.nav);
    peak = Math.max(peak, nav);
    mdd = Math.min(mdd, nav / peak - 1);
  }
  const last = input.dailyNAV.at(-1);
  const days = last
    ? (Date.parse(`${last.date}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) /
      86_400_000
    : 0;
  const complete = Boolean(last) && missing === 0 && days > 0;
  const final = last?.nav === null || last?.nav === undefined ? null : Number(last.nav);
  return {
    status: complete ? (stale ? "COMPLETE_WITH_STALE_MARKS" : "COMPLETE") : "INCOMPLETE",
    startDate: input.startDate,
    endDate: last?.date ?? null,
    observations: input.dailyNAV.length,
    elapsedCalendarDays: days,
    annualization: "ACTUAL_DAYS_365_2425" as const,
    initialCapital: input.initialCapital,
    finalNAV: final,
    cumulativeReturn: complete ? final! / initial - 1 : null,
    cagr: complete ? Math.pow(final! / initial, 365.2425 / days) - 1 : null,
    mdd: complete ? mdd : null,
    missingValuationCount: missing,
    staleValuationCount: stale,
    terminalValuation: "LAST_SESSION_CLOSE_NO_FORCED_LIQUIDATION" as const,
  };
}
