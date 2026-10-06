import {
  OCTOBER_CALENDAR_EVIDENCE,
  regularCloseAt,
  regularOpenAt,
} from "./octoberShadowCalendar";
import { validDate } from "./date";

const krDate = (at: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));

function isKrRegularSession(date: string) {
  if (!validDate(date)) return false;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const holidays: readonly string[] = OCTOBER_CALENDAR_EVIDENCE.KR.holidays;
  return day !== 0 && day !== 6 && !holidays.includes(date);
}

export function nextKrRegularSession(afterDate: string): string | null {
  if (!validDate(afterDate)) throw new Error("Invalid KR session date");
  for (
    let at = Date.parse(`${afterDate}T00:00:00Z`) + 86400000;
    at <= Date.parse(`${OCTOBER_CALENDAR_EVIDENCE.coverageEnd}T00:00:00Z`);
    at += 86400000
  ) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (isKrRegularSession(date)) return date;
  }
  return null;
}

/**
 * Official KR Shadow decision window:
 * completed session T -> full KRX refresh on the next regular-session morning
 * -> decision strictly before that next session opens.
 * Same-evening screening is preview only.
 */
export function isKrOfficialShadowDecision(
  sessionDate: string,
  availableAt: string,
  decisionAt: string,
): boolean {
  if (
    !validDate(sessionDate) ||
    !Number.isFinite(Date.parse(availableAt)) ||
    !Number.isFinite(Date.parse(decisionAt))
  )
    return false;
  const next = nextKrRegularSession(sessionDate);
  if (!next) return false;
  const available = Date.parse(availableAt);
  const decision = Date.parse(decisionAt);
  return (
    available >= Date.parse(regularCloseAt("KR", sessionDate)) &&
    available <= decision &&
    krDate(availableAt) === next &&
    krDate(decisionAt) === next &&
    decision < Date.parse(regularOpenAt("KR", next))
  );
}
