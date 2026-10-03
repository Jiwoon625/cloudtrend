import calendarEvidence from "./octoberShadowCalendarEvidence.json";
import { hashSeriesValue, MODEL_ACCOUNTING_START, type ModelCalendar } from "./modelSeries";
import { validDate } from "./date";

/** Reviewed exchange calendar data, not price-derived inferred business days. */
export const OCTOBER_CALENDAR_EVIDENCE = Object.freeze(calendarEvidence);

/** Freeze only observed coverage; future exchange changes do not rewrite completed history. */
export async function octoberModelCalendar(
  market: "KR" | "US",
  throughDate: string,
): Promise<ModelCalendar> {
  if (
    !validDate(throughDate) ||
    throughDate < MODEL_ACCOUNTING_START ||
    throughDate > OCTOBER_CALENDAR_EVIDENCE.coverageEnd
  )
    throw new Error(
      "Verified exchange calendar does not cover this date; extend reviewed calendar evidence before recording",
    );
  const holidays: readonly string[] = OCTOBER_CALENDAR_EVIDENCE[market].holidays;
  const regularSessions: string[] = [];
  for (
    let at = Date.parse(`${MODEL_ACCOUNTING_START}T00:00:00Z`);
    at <= Date.parse(`${throughDate}T00:00:00Z`);
    at += 86400000
  ) {
    const date = new Date(at).toISOString().slice(0, 10),
      day = new Date(at).getUTCDay();
    if (day !== 0 && day !== 6 && !holidays.includes(date)) regularSessions.push(date);
  }
  return {
    market,
    coverageStart: MODEL_ACCOUNTING_START,
    coverageEnd: throughDate,
    regularSessions,
    sourceHash: await hashSeriesValue({
      market,
      coverageStart: MODEL_ACCOUNTING_START,
      coverageEnd: throughDate,
      regularSessions,
      sources: OCTOBER_CALENDAR_EVIDENCE[market].sources,
    }),
  };
}

function exchangeTimeAt(market: "KR" | "US", date: string, time: string) {
  if (!validDate(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error("Invalid exchange session time");
  const zone = market === "KR" ? "Asia/Seoul" : "America/New_York";
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((part) => part.type === "timeZoneName")?.value;
  const match = offset?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) throw new Error("Exchange timezone offset unavailable");
  const offsetMinutes =
    (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(
    Date.parse(`${date}T00:00:00Z`) + (hours! * 60 + minutes! - offsetMinutes) * 60000,
  )
    .toISOString()
    .replace(".000Z", "Z");
}
function krHours(date: string) {
  if (OCTOBER_CALENDAR_EVIDENCE.KR.pendingHoursDates.includes(date))
    throw new Error("KR special-session hours await exchange confirmation");
  return (
    (OCTOBER_CALENDAR_EVIDENCE.KR.specialHours as Record<string, { open: string; close: string }>)[
      date
    ] ?? { open: "09:00", close: "15:30" }
  );
}
export function regularOpenAt(market: "KR" | "US", date: string) {
  return exchangeTimeAt(market, date, market === "KR" ? krHours(date).open : "09:30");
}
export function regularCloseAt(market: "KR" | "US", date: string) {
  const time =
    market === "KR"
      ? krHours(date).close
      : OCTOBER_CALENDAR_EVIDENCE.US.earlyCloses.includes(date)
        ? "13:00"
        : "16:00";
  return exchangeTimeAt(market, date, time);
}
