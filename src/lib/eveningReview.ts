import type {
  DashboardIndexRow,
  DashboardMarketSignals,
  DashboardSignal,
} from "./dashboardOperations";
import { isOperationalSignalDate, operationalEntryStartNotice } from "./operationalSignalStart";

type ReviewRow = Pick<
  DashboardSignal,
  "date" | "market" | "held" | "assessment" | "etfAssessment" | "operationalEntryNotice"
> &
  Partial<Pick<DashboardIndexRow, "kospiEntry" | "etfEntry">>;

export function eveningReviewStartNotice(row: ReviewRow) {
  const origin = row.market === "ETF" ? row.etfEntry?.originDate : row.kospiEntry?.originDate;
  const state = row.market === "ETF" ? row.etfEntry?.entryState : row.kospiEntry?.state;
  const requiresOrigin = state === "pending" || state === "confirmed" || state === "data_pending";
  return (
    row.operationalEntryNotice ?? operationalEntryStartNotice(row.date, origin, requiresOrigin)
  );
}

/** Optional technical reference scope. Never a raw-signal or trading-eligibility count. */
export function isTechnicalReviewReference(
  row: ReviewRow,
  market: Pick<DashboardMarketSignals, "date" | "holdingsKnown">,
) {
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

/** Today's recorded raw signal, including signals rejected by subsequent entry gates.
 * Holdings and entry eligibility are deliberately separate from raw-signal evidence.
 */
export function isEveningReviewCandidate(
  row: ReviewRow,
  market: Pick<DashboardMarketSignals, "date" | "holdingsKnown">,
) {
  if (row.date !== market.date || !isOperationalSignalDate(row.date)) return false;
  return row.market === "ETF"
    ? row.etfAssessment?.current === true && row.etfAssessment.rawOnset === true
    : row.assessment?.current === true && row.assessment.rawOnset === true;
}

/** Missing or old cached projection fields stay unknown; never force a screening refresh. */
export function isReviewOnsetUnknown(
  row: ReviewRow,
  market: Pick<DashboardMarketSignals, "date" | "holdingsKnown">,
) {
  if (row.date !== market.date || !isOperationalSignalDate(row.date)) return true;
  if (row.market === "ETF")
    return (
      !row.etfAssessment ||
      (row.etfAssessment.isStrategyTarget === true &&
        (!row.etfAssessment.current || row.etfAssessment.rawOnset == null))
    );
  return !row.assessment?.current || row.assessment.rawOnset == null;
}

/** Missing KRX fields are skipped only in the explicitly selected partial-review view. */
export function matchesEtfReviewMinimum(
  value: number | null,
  minimum: number,
  partialReview: boolean,
) {
  return minimum <= 0 || (value === null ? partialReview : value >= minimum);
}
