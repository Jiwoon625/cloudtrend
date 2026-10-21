import calendarEvidence from "./assistantActualTradeCalendarEvidence.json";

/** KR direct-trade date gate retains its independently reviewed 2028 horizon. */
export const KR_SESSION_START = calendarEvidence.coverageStart;
export const KR_SESSION_END = "2028-12-31";
const CLOSED = new Set([
  ...calendarEvidence.KR.holidays,
  "2028-01-26",
  "2028-01-27",
  "2028-01-28",
  "2028-03-01",
  "2028-04-12",
  "2028-05-01",
  "2028-05-02",
  "2028-05-05",
  "2028-06-06",
  "2028-08-15",
  "2028-10-02",
  "2028-10-03",
  "2028-10-04",
  "2028-10-05",
  "2028-10-09",
  "2028-12-25",
  "2028-12-29",
]);

export function isReviewedKrSession(date: string): boolean {
  if (date < KR_SESSION_START || date > KR_SESSION_END || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return false;
  const day = new Date(date + "T00:00:00.000Z").getUTCDay();
  return day !== 0 && day !== 6 && !CLOSED.has(date);
}
