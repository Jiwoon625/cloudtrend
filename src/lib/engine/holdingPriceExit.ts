import { decimal, format, multiply } from "../ledger/decimal";
import type { DailyPrice } from "./types";
import { validDate } from "../ledger/date";

/** Separate prospective policy: callers must opt in; frozen research contracts do not. */
export const HOLDING_PRICE_EXIT_POLICY = Object.freeze({
  enabled: true,
  version: "holding-price-exit-k4-e4-v1",
  effectiveDate: "2026-10-15",
  kospiRatio: "0.92",
  etfRatio: "0.90",
} as const);

export interface HoldingPriceExitState {
  historyComplete?: boolean;
  policyVersion: typeof HOLDING_PRICE_EXIT_POLICY.version;
  peak: string | null;
  peakDate: string | null;
  throughDate: string | null;
  signalDate: string | null;
  signalClose: string | null;
  signalThreshold: string | null;
}
export interface HoldingPriceExitInput {
  market: "KOSPI" | "ETF";
  date: string;
  entryDate: string;
  entryPrice: string | null;
  quantity: string;
  /** Entire remaining acquisition cost, including actual entry fees. */
  costBasis: string | null;
  close: string | null;
  confirmedClose: boolean;
  /** Complete since entry, or a previously persisted complete peak. */
  historyComplete: boolean;
  state?: HoldingPriceExitState | null | undefined;
}
const positive = (value: string | null): bigint | null => {
  if (value === null) return null;
  try {
    const n = decimal(value);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
};
export function evaluateHoldingPriceExit(input: HoldingPriceExitInput) {
  if (!validDate(input.date) || !validDate(input.entryDate))
    throw new Error("Valid holding observation dates required");
  const state: HoldingPriceExitState = input.state
    ? { ...input.state }
    : {
        policyVersion: HOLDING_PRICE_EXIT_POLICY.version,
        peak: null,
        peakDate: null,
        throughDate: null,
        signalDate: null,
        signalClose: null,
        signalThreshold: null,
      };
  if (state.policyVersion !== HOLDING_PRICE_EXIT_POLICY.version)
    throw new Error("Holding exit policy mismatch");
  if (state.throughDate && input.date < state.throughDate)
    throw new Error("Holding exit observations must be chronological");
  if (
    state.signalDate &&
    (state.signalDate < HOLDING_PRICE_EXIT_POLICY.effectiveDate ||
      state.signalDate < input.entryDate ||
      state.signalDate > input.date)
  )
    throw new Error("Invalid holding exit signal date");
  const quantity = positive(input.quantity),
    cost = positive(input.costBasis);
  const entry = positive(input.entryPrice),
    close = positive(input.close);
  let peak = positive(state.peak);
  if (entry && (!peak || entry > peak)) {
    peak = entry;
    state.peakDate = input.entryDate;
  }
  if (input.confirmedClose && close && input.date >= input.entryDate) {
    if (!peak || close > peak) {
      peak = close;
      state.peakDate = input.date;
    }
    state.throughDate = input.date;
  }
  state.peak = peak ? format(peak) : null;
  if (input.market === "ETF")
    state.historyComplete =
      input.historyComplete && state.historyComplete !== false && input.confirmedClose && !!close;
  const basisKnown =
    input.market === "KOSPI" ? !!quantity && !!cost : !!peak && state.historyComplete === true;
  const threshold = !basisKnown
    ? null
    : input.market === "KOSPI"
      ? format((cost! * decimal("0.92")) / quantity!)
      : format(multiply(peak!, decimal("0.90")));
  const eligible =
    HOLDING_PRICE_EXIT_POLICY.enabled &&
    input.date >= HOLDING_PRICE_EXIT_POLICY.effectiveDate &&
    input.date >= input.entryDate;
  const ready = eligible && basisKnown && input.confirmedClose && !!close;
  // Compare exact ratios before display rounding; equality is a signal.
  const hit =
    ready &&
    (input.market === "KOSPI"
      ? close! * quantity! * 100n <= cost! * decimal("1") * 92n
      : close! * 100n <= peak! * 90n);
  if (hit && !state.signalDate) {
    state.signalDate = input.date;
    state.signalClose = input.close;
    state.signalThreshold = threshold;
  }
  return {
    state,
    threshold,
    reason: state.signalDate ? (input.market === "KOSPI" ? "K4" : "E4") : null,
    status: state.signalDate
      ? "EXIT_PENDING"
      : !eligible
        ? "NOT_EFFECTIVE"
        : ready
          ? "HOLD"
          : "BASIS_PENDING",
  } as const;
}

/** Replay observations only through the decision date, retaining the first exit intent. */
export function replayHoldingPriceExit(
  holding: Omit<HoldingPriceExitInput, "date" | "close" | "confirmedClose" | "historyComplete">,
  bars: DailyPrice[],
  throughDate: string,
  requiredDates: string[],
) {
  const rows = bars
    .filter((b) => b.tradeDate >= holding.entryDate && b.tradeDate <= throughDate)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  if (new Set(rows.map((b) => b.tradeDate)).size !== rows.length)
    throw new Error("Holding exits require normalized unique daily prices");
  let state = holding.state;
  let complete =
    !!holding.state?.throughDate || rows.some((b) => b.tradeDate === holding.entryDate);
  let result: ReturnType<typeof evaluateHoldingPriceExit> | null = null;
  for (const bar of rows) {
    if (state?.throughDate && bar.tradeDate <= state.throughDate) continue;
    const validClose = Number.isFinite(bar.close) && bar.close > 0;
    complete =
      complete &&
      validClose &&
      !requiredDates.some(
        (date) =>
          date >= holding.entryDate &&
          (!holding.state?.throughDate || date > holding.state.throughDate) &&
          date <= bar.tradeDate &&
          !rows.some((b) => b.tradeDate === date),
      );
    result = evaluateHoldingPriceExit({
      ...holding,
      state,
      date: bar.tradeDate,
      close: validClose ? bar.close.toFixed(8) : null,
      confirmedClose: validClose,
      historyComplete: complete,
    });
    state = result.state;
  }
  return result;
}
