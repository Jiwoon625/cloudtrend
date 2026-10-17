import { entryDecisionLabel, findEntryDecision, type EntryDecision } from "./actualEntryDecisions";
import type { DashboardMarketSignals, DashboardSignal } from "./dashboardOperations";
/** Actual presentation only. Never write screenings, Shadow, fills, cash or reservations. */
export function projectActualEntryDecisions(
  markets: DashboardMarketSignals[],
  entries: EntryDecision[] | null,
): DashboardMarketSignals[] {
  return markets.map((group) => {
    const annotate = (r: DashboardSignal): DashboardSignal => {
      if (r.held || r.actualState === "HELD" || r.actualState === "CONSUMED") return r;
      const decision = findEntryDecision(
        entries ?? undefined,
        r.market,
        r.symbol,
        r.signalOriginDate ?? r.date,
      );
      return decision ? { ...r, entryDecision: decision } : r;
    };
    const onsets = group.onsets.map(annotate);
    return {
      ...group,
      onsets: entries === null ? [] : onsets.filter((r) => !r.entryDecision),
      onsetCount:
        entries === null
          ? null
          : group.onsetCount === null
            ? null
            : onsets.filter((r) => !r.entryDecision).length,
      notPurchased: onsets
        .filter((r) => r.entryDecision)
        .map((r) => ({ ...r, reason: `${entryDecisionLabel(r.entryDecision!)} · ${r.reason}` })),
      ...(group.conditions ? { conditions: group.conditions.map(annotate) } : {}),
      ...(group.pending ? { pending: group.pending.map(annotate) } : {}),
      ...(group.assessments ? { assessments: group.assessments.map(annotate) } : {}),
    };
  });
}
