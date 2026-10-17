import { octoberModelCalendar, regularCloseAt } from "./ledger/octoberShadowCalendar";
import type { NewActualCurrency } from "./newActualPortfolio";

/** A dated closing mark must match the latest completed, reviewed exchange session. */
export async function newActualValuationDate(currency: NewActualCurrency, now: string) {
  const instant = Date.parse(now);
  if (!Number.isFinite(instant)) return null;
  const market = currency === "USD" ? "US" : "KR";
  const today = new Date(instant).toLocaleDateString("en-CA", {
    timeZone: market === "US" ? "America/New_York" : "Asia/Seoul",
  });
  try {
    const calendar = await octoberModelCalendar(market, today);
    for (const date of [...calendar.regularSessions].reverse()) {
      if (Date.parse(regularCloseAt(market, date)) <= instant) return date;
    }
  } catch {
    // Unreviewed dates or unknown special hours must never certify an old mark.
  }
  return null;
}
