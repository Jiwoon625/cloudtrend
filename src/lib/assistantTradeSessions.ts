import calendarEvidence from "./ledger/octoberShadowCalendarEvidence.json";

/** KR direct-trade date gate uses the same reviewed calendar evidence as US. */
export const KR_SESSION_START = calendarEvidence.coverageStart;
export const KR_SESSION_END = calendarEvidence.coverageEnd;
const CLOSED = new Set(calendarEvidence.KR.holidays);
export function isReviewedKrSession(date: string): boolean {
  if (date < KR_SESSION_START || date > KR_SESSION_END || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return false;
  const day = new Date(date + "T00:00:00.000Z").getUTCDay();
  return day !== 0 && day !== 6 && !CLOSED.has(date);
}
