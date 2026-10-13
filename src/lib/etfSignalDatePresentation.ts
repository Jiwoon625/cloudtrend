import type { ScreeningRow } from "./engine/pipeline";
import { etfPartialEvidence } from "./etfPartialEvidence";

/** Dates are display evidence only; unknown is never converted into a zero-signal claim. */
export function etfSignalDateLabels(row: ScreeningRow, asOfDate: string) {
  const e = etfPartialEvidence(row, asOfDate),
    s = row.etfStrategy;
  const unknown = { origin: "미확인", confirmation: "미확인" };
  if (!e.current || !s) return unknown;
  const dated = (date: string | null) =>
    !!date &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date &&
    date <= asOfDate;
  if (
    (s.originDate !== null && !dated(s.originDate)) ||
    (s.confirmationDate !== null && !dated(s.confirmationDate)) ||
    (s.originDate && s.confirmationDate && s.confirmationDate <= s.originDate)
  )
    return unknown;
  const origin = s.originDate ?? (e.rawOnset === false ? "없음" : "미확인");
  const confirmation =
    s.confirmationDate ??
    (s.entryState === "pending" && s.originDate && s.dataStatus === "ready" && e.rawOnset === true
      ? "다음 정규 거래일 종가"
      : e.rawOnset === false && s.entryState === "none"
        ? "없음"
        : "미확인");
  return { origin, confirmation };
}
