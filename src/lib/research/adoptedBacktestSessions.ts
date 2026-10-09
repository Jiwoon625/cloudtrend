/** Verbatim session-only extraction from adoptedBacktestInput.ts. No market engine imports. */
import { validDate } from "../ledger/date";

export function assertOrderedSessions(sessions: unknown): asserts sessions is string[] {
  if (
    !Array.isArray(sessions) ||
    !sessions.length ||
    sessions.some(
      (date, index) =>
        typeof date !== "string" || !validDate(date) || (index > 0 && date <= sessions[index - 1]),
    )
  )
    throw new Error("Manifest requires nonempty, unique, increasing actual sessions");
}

export function selectBacktestSessions(
  sessions: string[],
  start: string,
  through: string,
  smokeSessions?: number,
) {
  assertOrderedSessions(sessions);
  if (
    !validDate(start) ||
    !validDate(through) ||
    start > through ||
    !sessions.includes(start) ||
    !sessions.includes(through)
  )
    throw new Error("Selected boundaries must be covered actual market sessions");
  const selected = sessions.filter((date) => date >= start && date <= through);
  if (smokeSessions !== undefined) {
    if (!Number.isInteger(smokeSessions) || smokeSessions < 20 || smokeSessions > 60)
      throw new Error("Smoke requires 20 through 60 sessions");
    if (selected.length < smokeSessions) throw new Error("Not enough selected sessions for smoke");
    return selected.slice(0, smokeSessions);
  }
  return selected;
}
