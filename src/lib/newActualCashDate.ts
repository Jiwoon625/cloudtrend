/** Cash allocation is recorded on the Korean operating day, independently of exchange sessions. */
export function newActualCashDay(now: Date | string = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  return ["year", "month", "day"]
    .map((part) => parts.find((p) => p.type === part)?.value)
    .join("-");
}
