import { validDate } from "./ledger/date";

type Clock = "Asia/Seoul" | "America/New_York";
/** UTC bounds of a date-only record. Midnight is resolved with IANA DST rules. */
export function actualDateWindow(date: string, timeZone: Clock) {
  if (!validDate(date)) throw new Error("Invalid cash timing date");
  function midnight(day: string) {
    const target = Date.parse(`${day}T00:00:00Z`);
    let instant = target;
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const parts = formatter.formatToParts(new Date(instant));
      const part = (type: string) => parts.find((p) => p.type === type)!.value;
      const local = Date.parse(
        `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}Z`,
      );
      if (local === target) return instant;
      instant += target - local;
    }
    throw new Error("Cash timing timezone resolution failed");
  }
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return { start: midnight(date), end: midnight(next) };
}
/** Diagnostic upper bound only: never assigns effective timestamps or authorizes cash. */
export function couldCashTimingExplainShortfall(
  changes: { date: string; change: bigint; timeZone: Clock }[],
): boolean {
  const bounds = changes
    .filter((entry) => entry.change !== 0n)
    .map((entry) => {
      const window = actualDateWindow(entry.date, entry.timeZone);
      return { at: entry.change > 0n ? window.start : window.end, change: entry.change };
    });
  // End is exclusive: a debit before midnight cannot use a credit starting at that midnight.
  bounds.sort((a, b) => a.at - b.at || Number(a.change >= 0n) - Number(b.change >= 0n));
  let bestPossibleCash = 0n;
  for (const { change } of bounds) {
    bestPossibleCash += change;
    if (bestPossibleCash < 0n) return false;
  }
  return true;
}
