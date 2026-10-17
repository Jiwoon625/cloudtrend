import type { DashboardMarketSignals, DashboardSignal } from "./dashboardOperations";
import { isEveningReviewCandidate } from "./eveningReview";

export type InboxKind = "exits" | "notPurchased" | "onsets" | "pending" | "raw";
export function dashboardInbox(markets: DashboardMarketSignals[]) {
  const found = new Map<string, DashboardSignal & { inboxKind: InboxKind }>();
  // Actual exits take precedence; a raw signal never implies an executable entry.
  for (const kind of ["exits", "notPurchased", "onsets", "pending", "raw"] as const) {
    for (const market of markets) {
      const rows =
        kind === "raw"
          ? (market.assessments ?? []).filter((row) => isEveningReviewCandidate(row, market))
          : (market[kind] ?? []);
      for (const row of rows) {
        const key = `${row.market}:${row.symbol}`;
        if (!found.has(key)) found.set(key, { ...row, inboxKind: kind });
      }
    }
  }
  return [...found.values()];
}
