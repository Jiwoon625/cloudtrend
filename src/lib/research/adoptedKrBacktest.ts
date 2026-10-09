import { simulateStrategy } from "../portfolioLedgers";
import type { DailyPrice, Market } from "../engine/types";
import type { KospiMarketGateEvidence } from "../engine/kospiMarketGate";
import { KOSPI_CONSISTENCY_VERSION } from "../engine/kospiEntryConfirmation";
import type { ScreeningSnapshot } from "../screeningSnapshot";
import { validDate } from "../ledger/date";

export interface AdoptedKrBacktestInput {
  snapshots: ScreeningSnapshot[];
  /** Use observedBars, preserving zero-volume/zero-price and absent-open evidence. */
  bars: Record<string, DailyPrice[]>;
  markets: Record<string, Market>;
  marketDates: string[];
  marketGates: Record<string, KospiMarketGateEvidence>;
  startDate: string;
  throughDate: string;
  scope: "MIXED" | "KOSPI" | "KOSDAQ";
  initialCapital?: number;
  fingerprint?: string;
  marketLiquidCounts?: Record<string, number>;
}

/** Current adopted rules on real historical dates. Never opens or writes a frozen model series. */
export function runAdoptedKrBacktest(input: AdoptedKrBacktestInput) {
  if (
    !validDate(input.startDate) ||
    !validDate(input.throughDate) ||
    input.startDate > input.throughDate
  )
    throw new Error("Invalid KR research period");
  if (
    !input.marketDates.length ||
    new Set(input.marketDates).size !== input.marketDates.length ||
    input.marketDates.some((date) => !validDate(date))
  )
    throw new Error("Unique verified KR market sessions are required");
  const marketDates = [...input.marketDates].sort();
  if (!marketDates.includes(input.startDate) || !marketDates.includes(input.throughDate))
    throw new Error("KR research boundaries must be covered market sessions");
  if (new Set(input.snapshots.map((snapshot) => snapshot.asOfDate)).size !== input.snapshots.length)
    throw new Error("Resolve duplicate snapshots before historical replay");
  for (const snapshot of input.snapshots) {
    if (!validDate(snapshot.asOfDate)) throw new Error("Invalid historical snapshot date");
    if (snapshot.asOfDate < input.startDate || snapshot.asOfDate > input.throughDate) continue;
    for (const entry of snapshot.entries) {
      if (input.markets[entry.symbol] !== "KOSPI") continue;
      if (entry.kospiEntry && entry.kospiEntry.version !== KOSPI_CONSISTENCY_VERSION)
        throw new Error("KOSPI research snapshots must use CURRENT_RULES_RESEARCH context");
    }
  }
  for (const rows of Object.values(input.bars)) {
    if (
      rows.some(
        (bar, index) =>
          !validDate(bar.tradeDate) || (index > 0 && rows[index - 1]!.tradeDate >= bar.tradeDate),
      )
    )
      throw new Error("Price rows must be deduplicated and chronological before replay");
  }
  const ledger = simulateStrategy(
    {
      initialCapital: input.initialCapital ?? 100_000_000,
      maxPositions: 30,
      sectorCap: 0.3,
      roundTripCostRate: 0.003,
    },
    input.snapshots,
    input.bars,
    input.markets,
    input.fingerprint ?? "",
    marketDates,
    input.marketGates,
    {
      version: "kr-annual-signal-year-research-v2",
      startDate: input.startDate,
      throughDate: input.throughDate,
      scope: input.scope,
      entryBudgetPolicy: "ANNUAL_PRIOR_CLOSE_NAV",
    },
    input.marketLiquidCounts,
  );
  const history = ledger.researchHistory!;
  return {
    ledger,
    dailyNAV: history.dailyNAV,
    yearlyBudgets: history.yearlyBudgets,
    trades: ledger.trades,
    evidence: {
      policy: "kr-annual-signal-year-research-v2" as const,
      scope: input.scope,
      accountRole:
        input.scope === "MIXED" ? "ADOPTED_SHARED_KR_30" : "INDEPENDENT_30_SLOT_DIAGNOSTIC",
      entryBudgetPolicy: "ANNUAL_PRIOR_CLOSE_NAV" as const,
      initialCapital: input.initialCapital ?? 100_000_000,
      startDate: input.startDate,
      throughDate: input.throughDate,
      sourceFingerprint: input.fingerprint ?? "",
      exitTiming: history.exitTiming,
      historicalReconstruction: true,
    },
  };
}

export type AdoptedKrBacktestResult = ReturnType<typeof runAdoptedKrBacktest>;
