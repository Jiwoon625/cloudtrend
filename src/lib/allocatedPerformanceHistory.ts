import {
  projectNewActualPool,
  validateNewActualMetadata,
  type NewActualCurrency,
  type NewActualExecution,
  type NewActualMetadata,
} from "./newActualPortfolio";
import { ACTUAL_PERFORMANCE_START } from "./ledger/actualPerformance";
import { validDate } from "./ledger/date";
import type { Quote } from "./portfolioLedgers";

export type DatedActualPrice = { symbol: string; date: string; close: number };
export interface AllocatedPerformanceHistory {
  version: 1;
  currency: NewActualCurrency;
  sourceRevision: number;
  sourceHash: string;
  calculatedAt: string;
  throughDate: string;
  points: Array<{
    date: string;
    nav: string | null;
    cash: string | null;
    netContributions: string | null;
    pnl: string | null;
    returnPercent: string | null;
    issues: string[];
  }>;
}

/** Reconstruct only explicitly allocated actual fills. No MODEL cash, FX, or inferred fills. */
export function buildAllocatedPerformanceHistory(input: {
  currency: NewActualCurrency;
  executions: NewActualExecution[];
  metadata: NewActualMetadata;
  sourceRevision: number;
  sourceHash: string;
  calculatedAt: string;
  throughDate: string;
  dates: string[];
  prices: DatedActualPrice[];
}): AllocatedPerformanceHistory {
  validateNewActualMetadata(input.metadata);
  if (
    !validDate(input.throughDate) ||
    !Number.isSafeInteger(input.sourceRevision) ||
    input.sourceRevision < 1 ||
    !input.sourceHash
  )
    throw new Error("Invalid actual history identity");
  const executions = new Map(input.executions.map((e) => [e.id, e]));
  if (
    executions.size !== input.executions.length ||
    Object.keys(input.metadata.assignments).some((id) => !executions.has(id))
  )
    throw new Error("Invalid actual history assignment");
  const prices = new Map<string, Map<string, number>>();
  for (const p of input.prices) {
    if (!validDate(p.date)) throw new Error("Invalid actual price date");
    const day = prices.get(p.date) ?? new Map<string, number>();
    if (day.has(p.symbol) && day.get(p.symbol) !== p.close)
      throw new Error("Conflicting dated actual prices");
    day.set(p.symbol, p.close);
    prices.set(p.date, day);
  }
  const dates = [...new Set(input.dates)]
    .filter((d) => d >= ACTUAL_PERFORMANCE_START && d <= input.throughDate)
    .sort();
  if (dates.some((d) => !validDate(d))) throw new Error("Invalid actual history date");
  const points = dates.map((date) => {
    const fills = input.executions.filter((e) => e.date <= date);
    const ids = new Set(fills.map((e) => e.id));
    const metadata = {
      ...input.metadata,
      assignments: Object.fromEntries(
        Object.entries(input.metadata.assignments).filter(([id]) => ids.has(id)),
      ),
      cashEvents: input.metadata.cashEvents.filter((e) => e.date <= date),
    };
    const quotes: Record<string, Quote> = {};
    for (const e of fills) {
      const close = prices.get(date)?.get(e.symbol);
      if (close !== undefined && Number.isFinite(close) && close > 0)
        quotes[`${e.market}:${e.symbol}`] = { price: close, date, exitSignal: null };
    }
    const pool = projectNewActualPool({
      currency: input.currency,
      executions: fills,
      metadata,
      quotes,
      today: date,
      cashToday: date,
      valuationDate: date,
    });
    return {
      date,
      nav: pool.nav,
      cash: pool.cash,
      netContributions: pool.netContributions,
      pnl: pool.totalPnl,
      returnPercent: pool.returnPercent,
      issues: pool.issues,
    };
  });
  return {
    version: 1,
    currency: input.currency,
    sourceRevision: input.sourceRevision,
    sourceHash: input.sourceHash,
    calculatedAt: input.calculatedAt,
    throughDate: input.throughDate,
    points,
  };
}
