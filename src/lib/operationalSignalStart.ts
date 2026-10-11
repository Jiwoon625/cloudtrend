import { validDate } from "./ledger/date";

/** Market-session dates, never the browser clock or a KST conversion of a US session. */
export const OPERATIONAL_SIGNAL_START = "2026-10-12";
export const OPERATIONAL_START_NOTICE =
  "신규 운용은 2026-10-12 신호부터 시작합니다. 이전 신호는 신규 진입·청산 후보에 포함하지 않습니다.";
export const BEFORE_OPERATIONAL_START = "신규 운용 시작 전 · 과거 신호";
export const PRE_START_ORIGIN = "시작 전 원신호 · 신규 운용 승계 안 함";

export function isOperationalSignalDate(date: string | null | undefined): boolean {
  return typeof date === "string" && validDate(date) && date >= OPERATIONAL_SIGNAL_START;
}

export function isOperationalSignalOrigin(
  date: string | null | undefined,
  originDate: string | null | undefined,
): boolean {
  return (
    isOperationalSignalDate(date) && isOperationalSignalDate(originDate) && originDate! <= date!
  );
}

export function operationalEntryStartNotice(
  date: string | null | undefined,
  originDate?: string | null,
  requiresOrigin = false,
): string | null {
  if (!isOperationalSignalDate(date)) return BEFORE_OPERATIONAL_START;
  if (originDate == null && requiresOrigin) return "원신호 시점 미확인 · 진입 제외";
  if (originDate != null && !isOperationalSignalOrigin(date, originDate)) return PRE_START_ORIGIN;
  return null;
}
