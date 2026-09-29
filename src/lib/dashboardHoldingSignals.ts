import { getHeldOperationalExitSignal } from "@/lib/engine/operationalStrategy";
import type { ScreeningRow } from "@/lib/engine/pipeline";
import type { PortfolioState } from "@/lib/portfolioStoreCore";
import type { DashboardSummary } from "@/lib/screeningCacheContract";

function heldSymbols(portfolio: PortfolioState | null): Set<string> {
  return new Set(
    (portfolio?.trades ?? [])
      .filter((trade) => trade.status === "OPEN" && trade.shares > 0)
      .map((trade) => trade.symbol),
  );
}

function asHeldRow(row: ScreeningRow, held: Set<string>): ScreeningRow {
  if (!held.has(row.instrument.symbol)) return row;
  const exitSignal = getHeldOperationalExitSignal(
    row.instrument.market,
    row.operatingScore10,
    row.scoreDelta1d,
  );
  return {
    ...row,
    kosdaq80Onset: false,
    kospi80Onset: false,
    kospiEightPointEntry: false,
    exitSignal: exitSignal ?? row.exitSignal,
  };
}

/**
 * Dashboard caches are holding-agnostic by design. At render time, reconcile entry signals
 * with the user's current portfolio so an already-held position never appears as a fresh Onset.
 * If the same score transition also crosses an exit threshold, the held position is shown as Exit.
 */
export function applyHoldingSignalPriority(
  summary: DashboardSummary,
  portfolio: PortfolioState | null,
): DashboardSummary {
  const held = heldSymbols(portfolio);
  if (held.size === 0) return summary;

  const suppressedKosdaq = summary.onsetRows.filter((row) => held.has(row.instrument.symbol));
  const suppressedKospi = summary.kospiEntryRows.filter((row) => held.has(row.instrument.symbol));
  const promoted = [...suppressedKosdaq, ...suppressedKospi]
    .map((row) => asHeldRow(row, held))
    .filter((row) => row.exitSignal !== null);

  const existingExitSymbols = new Set(summary.exitRows.map((row) => row.instrument.symbol));
  const addedExits = promoted.filter((row) => !existingExitSymbols.has(row.instrument.symbol));
  const exitRows = [...summary.exitRows, ...addedExits]
    .map((row) => asHeldRow(row, held))
    .sort((a, b) => (b.operatingScore10 ?? -Infinity) - (a.operatingScore10 ?? -Infinity))
    .slice(0, 30);

  const addedUpside = addedExits.filter(
    (row) => row.exitSignal === "UP95" || row.exitSignal === "UP90",
  ).length;
  const addedDownside = addedExits.filter((row) => row.exitSignal === "DOWN30").length;

  return {
    ...summary,
    counts: {
      ...summary.counts,
      kosdaq80Onsets: Math.max(0, summary.counts.kosdaq80Onsets - suppressedKosdaq.length),
      kospiEightPointEntries: Math.max(
        0,
        summary.counts.kospiEightPointEntries - suppressedKospi.length,
      ),
      upsideExits: summary.counts.upsideExits + addedUpside,
      downsideExits: summary.counts.downsideExits + addedDownside,
    },
    onsetRows: summary.onsetRows
      .filter((row) => !held.has(row.instrument.symbol))
      .map((row) => asHeldRow(row, held)),
    kospiEntryRows: summary.kospiEntryRows
      .filter((row) => !held.has(row.instrument.symbol))
      .map((row) => asHeldRow(row, held)),
    exitRows,
    top: summary.top.map((row) => asHeldRow(row, held)),
  };
}
