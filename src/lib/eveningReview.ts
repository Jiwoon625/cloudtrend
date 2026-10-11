import type {
  DashboardIndexRow,
  DashboardMarketSignals,
  DashboardSignal,
} from "./dashboardOperations";
import { isOperationalSignalDate, operationalEntryStartNotice } from "./operationalSignalStart";

type ReviewRow = DashboardSignal & Partial<Pick<DashboardIndexRow, "kospiEntry" | "etfEntry">>;

export function eveningReviewStartNotice(row: ReviewRow) {
  const origin = row.market === "ETF" ? row.etfEntry?.originDate : row.kospiEntry?.originDate;
  const state = row.market === "ETF" ? row.etfEntry?.entryState : row.kospiEntry?.state;
  const requiresOrigin = state === "pending" || state === "confirmed" || state === "data_pending";
  return (
    row.operationalEntryNotice ?? operationalEntryStartNotice(row.date, origin, requiresOrigin)
  );
}

/** Read-only review selection. These rows never establish trading eligibility. */
export function isEveningReviewCandidate(row: ReviewRow, market: DashboardMarketSignals) {
  if (
    !market.holdingsKnown ||
    row.held ||
    row.date !== market.date ||
    !isOperationalSignalDate(row.date) ||
    eveningReviewStartNotice(row)
  )
    return false;
  if (row.market === "ETF") {
    const evidence = row.etfAssessment;
    return Boolean(evidence?.current && evidence.isStrategyTarget && evidence.technical !== null);
  }
  const evidence = row.assessment;
  return Boolean(
    evidence?.current &&
    row.kospiEntry?.state !== "rejected" &&
    !evidence.failed.length &&
    (evidence.rawOnset || (evidence.score !== null && evidence.score >= 8)),
  );
}

/** Missing KRX fields are skipped only in the explicitly selected partial-review view. */
export function matchesEtfReviewMinimum(
  value: number | null,
  minimum: number,
  partialReview: boolean,
) {
  return minimum <= 0 || (value === null ? partialReview : value >= minimum);
}
