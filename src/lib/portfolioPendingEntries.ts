import calendarEvidence from "./ledger/octoberShadowCalendarEvidence.json";
import { validDate } from "./ledger/date";
import type { ActualExecution, Candidate, StrategyLedger } from "./portfolioLedgers";

export interface ReviewedKrEntryCalendar {
  coverageStart: string;
  coverageEnd: string;
  holidays: readonly string[];
}

const reviewedCalendar: ReviewedKrEntryCalendar = {
  coverageStart: calendarEvidence.coverageStart,
  coverageEnd: calendarEvidence.coverageEnd,
  holidays: calendarEvidence.KR.holidays,
};

export interface KrPendingEntry {
  key: string;
  symbol: string;
  name: string;
  market: Candidate["market"];
  signalDate: string;
  expectedEntryDate: string | null;
  timing: "TODAY" | "UPCOMING" | "AWAITING_DATA" | "UNKNOWN";
  label: string;
  decision: string;
  actualFilled: boolean;
  actualLabel: string;
}

function nextVerifiedSession(afterDate: string, calendar: ReviewedKrEntryCalendar | null) {
  if (
    !calendar ||
    !validDate(afterDate) ||
    !validDate(calendar.coverageStart) ||
    !validDate(calendar.coverageEnd) ||
    afterDate < calendar.coverageStart ||
    afterDate >= calendar.coverageEnd
  )
    return null;
  const holidays = new Set(calendar.holidays);
  const isSession = (date: string) => {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day !== 0 && day !== 6 && !holidays.has(date);
  };
  // A non-session signal cannot establish a verified next-session entry.
  if (!isSession(afterDate)) return null;
  for (
    let at = Date.parse(`${afterDate}T00:00:00Z`) + 86400000;
    at <= Date.parse(`${calendar.coverageEnd}T00:00:00Z`);
    at += 86400000
  ) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (isSession(date)) return date;
  }
  return null;
}

function isWaitingForOpen(candidate: Candidate) {
  if (candidate.entryDate !== null || candidate.price !== null) return false;
  if (candidate.market === "KOSDAQ") return candidate.decision === "다음 거래일 대기";
  return (
    candidate.market === "KOSPI" &&
    candidate.entryState === "confirmed" &&
    candidate.confirmationDate === candidate.signalDate &&
    /^다음 거래가능일 대기(?: ·|$)/.test(candidate.decision)
  );
}

/**
 * Read-only display projection from the saved historical strategy ledger.
 * This never creates fills, changes cash/holdings, or seeds a prospective Shadow series.
 * Dates use reviewed calendar coverage only; an old pending signal is never rolled forward.
 */
export function buildKrPendingEntryPreview(
  strategy: StrategyLedger | null | undefined,
  options: {
    today?: string;
    calendar?: ReviewedKrEntryCalendar | null;
    actualExecutions?: readonly ActualExecution[];
  } = {},
): { rows: KrPendingEntry[]; todayCount: number; unknownDateCount: number } {
  const today = options.today ?? new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const calendar = options.calendar === undefined ? reviewedCalendar : options.calendar;
  const trades = strategy?.trades ?? [];
  const rows: KrPendingEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of strategy?.candidates ?? []) {
    if (
      seen.has(candidate.key) ||
      !isWaitingForOpen(candidate) ||
      trades.some(
        (trade) =>
          trade.id === candidate.key ||
          (trade.symbol === candidate.symbol &&
            (trade.signalDate === candidate.signalDate || trade.status === "OPEN")),
      )
    )
      continue;
    seen.add(candidate.key);
    const expectedEntryDate = nextVerifiedSession(candidate.signalDate, calendar);
    const timing =
      !expectedEntryDate || !validDate(today)
        ? "UNKNOWN"
        : expectedEntryDate === today
          ? "TODAY"
          : expectedEntryDate < today
            ? "AWAITING_DATA"
            : "UPCOMING";
    const actualFilled = (options.actualExecutions ?? []).some(
      (execution) =>
        execution.side === "BUY" &&
        execution.signalKey === candidate.key &&
        execution.symbol === candidate.symbol &&
        validDate(execution.date) &&
        execution.date >= candidate.signalDate &&
        Number.isFinite(execution.shares) &&
        execution.shares > 0 &&
        Number.isFinite(execution.price) &&
        execution.price > 0,
    );
    rows.push({
      key: candidate.key,
      symbol: candidate.symbol,
      name: candidate.name,
      market: candidate.market,
      signalDate: candidate.signalDate,
      expectedEntryDate,
      timing,
      label:
        timing === "TODAY"
          ? "오늘 진입 예정 · 시가 미확인"
          : timing === "UPCOMING"
            ? "진입 예정 · 시가 미확인"
            : timing === "AWAITING_DATA"
              ? "예정일 경과 · 시가 자료 대기"
              : "진입 예정일 미확인 · 거래일 확인 필요",
      decision: candidate.decision,
      actualFilled,
      actualLabel: actualFilled ? "실제 체결 기록 있음" : "이 신호의 실제 체결 미기록",
    });
  }
  rows.sort((a, b) => b.signalDate.localeCompare(a.signalDate) || a.symbol.localeCompare(b.symbol));
  return {
    rows,
    todayCount: rows.filter((row) => row.timing === "TODAY").length,
    unknownDateCount: rows.filter((row) => row.expectedEntryDate === null).length,
  };
}
