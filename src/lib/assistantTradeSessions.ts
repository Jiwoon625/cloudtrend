/**
 * KRX date gate, extracted from exchange_calendars 4.13.1 XKRX exchange
 * schedule (2026-10-12 through 2028-12-31). Calendar updates are mandatory
 * before this coverage ends; special ad hoc KRX closures require amendment.
 * Never infer an exchange session from weekdays alone.
 */
export const KR_SESSION_START = "2026-10-12";
export const KR_SESSION_END = "2028-12-31";
const CLOSED = new Set([
  "2026-12-25", "2026-12-31",
  "2027-01-01","2027-02-08","2027-02-09","2027-03-01",
  "2027-05-05","2027-05-13","2027-08-16",
  "2027-09-14","2027-09-15","2027-09-16",
  "2027-10-04","2027-10-11","2027-12-27","2027-12-31",
  "2028-01-26","2028-01-27","2028-01-28","2028-03-01",
  "2028-05-01","2028-05-02","2028-05-05","2028-06-06",
  "2028-08-15","2028-10-02","2028-10-03","2028-10-04",
  "2028-10-05","2028-10-09","2028-12-25","2028-12-29",
]);
export function isReviewedKrSession(date: string): boolean {
  if (date < KR_SESSION_START || date > KR_SESSION_END || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return false;
  const day = new Date(date + "T00:00:00.000Z").getUTCDay();
  return day !== 0 && day !== 6 && !CLOSED.has(date);
}
