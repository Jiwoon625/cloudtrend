/** Classify only a recorded collection timestamp, never calculation or wall clock. */
export function screeningSession(collectedAt: string | null | undefined) {
  if (
    !collectedAt ||
    !/(Z|[+-]\d{2}:\d{2})$/.test(collectedAt) ||
    !Number.isFinite(Date.parse(collectedAt))
  )
    return "수집시각 미확인";
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(collectedAt)),
  );
  return hour < 12 ? "오전 수집" : "오후·저녁 수집";
}
