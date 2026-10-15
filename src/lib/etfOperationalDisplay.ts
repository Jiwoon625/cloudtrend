import type { ScreeningRow } from "./engine/pipeline";
import { etfPartialEvidence } from "./etfPartialEvidence";
import {
  isOperationalSignalDate,
  BEFORE_OPERATIONAL_START,
  operationalEntryStartNotice,
} from "./operationalSignalStart";

/** Display only; retain original strategy observations and never generate orders. */
export function etfDataJudgment(row: ScreeningRow, date: string): string | null {
  const evidence = etfPartialEvidence(row, date);
  if (!evidence.current) return "기준일 자료 미확인 · 재계산 필요";
  if (evidence.krxPending) return "KRX 자료 대기 · 신호 판단 보류";
  if (row.etfStrategy?.entryState === "data_pending" || evidence.score === null)
    return "필수 자료 미확인 · 신호 판단 보류";
  return null;
}

export function etfOperationalDisplay(
  row: ScreeningRow,
  date: string,
  held: boolean | undefined,
  sold = false,
  priceExit?: { reason: string | null; signalDate: string | null; status?: string } | undefined,
): string {
  if (!isOperationalSignalDate(date)) return BEFORE_OPERATIONAL_START;
  if (held && priceExit?.reason && priceExit.signalDate && priceExit.signalDate <= date)
    return `${priceExit.reason} · ${priceExit.signalDate} 종가 신호 · 다음 거래 가능 시가 청산 대기`;
  const missing = etfDataJudgment(row, date);
  if (!etfPartialEvidence(row, date).current || etfPartialEvidence(row, date).krxPending)
    return missing!;
  const s = row.etfStrategy!;
  if (held === undefined) return "보유 미확인 · 청산 판정 대기";
  if (held)
    return s.exit === "MA60"
      ? "다음 시가 청산"
      : priceExit?.status && /확인 대기|불일치|조회 실패/.test(priceExit.status)
        ? `보유 · 가격청산 자료 확인 대기 · ${priceExit.status}`
      : s.exit === "DATA_UNAVAILABLE"
        ? "데이터 오류 · 청산 점검"
        : "보유 · 추가 매수 없음";
  if (missing) return missing;
  const originNotice = operationalEntryStartNotice(
    date,
    s.originDate,
    s.entryState === "pending" || s.entryState === "confirmed" || s.onset,
  );
  if (originNotice) return originNotice;
  if (sold) return "청산한 신호 · 재진입 제외";
  if (s.entryState === "rejected") return "하루 확인 탈락";
  if (!s.eligible) return "대상·데이터 점검";
  if (s.entryState === "pending") return "하루 확인 대기";
  if (s.onset) return "진입 준비 · 다음 시가 진입";
  return s.score !== null && s.score >= 80 ? "80 이상 유지" : "관찰";
}
