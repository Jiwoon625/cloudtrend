import type { ScreeningRow } from "./engine/pipeline";
import { isOperationalEntry } from "./engine/operationalStrategy";
import { entrySuppressionReason, type DomesticPositionContext } from "./positionSignalContext";
import { stockAssessmentDisplay } from "./stockAssessmentDisplay";
import { getDisplayWarnings } from "./warningDisplay";

export interface CompactStockStatus {
  primary: string;
  secondary: string;
  tone: "normal" | "warn" | "danger" | "positive";
}
const brief = (reason: string) => (reason.length > 22 ? `${reason.slice(0, 21)}…` : reason);

/** Stock-list copy only. Never feeds entry eligibility, order generation or ledgers. */
export function getCompactStockStatus(
  row: ScreeningRow,
  context: DomesticPositionContext | null | undefined,
  asOfDate: string,
  tradeDates?: readonly string[],
): CompactStockStatus {
  const a = stockAssessmentDisplay(row, asOfDate, tradeDates);
  const suppression = entrySuppressionReason(
    context,
    row.instrument.symbol,
    row.kospiEntry?.originDate ?? asOfDate,
  );
  const entry = row.kospiEntry?.date === asOfDate ? row.kospiEntry : undefined;
  const pending = (row.pendingRules?.length ?? 0) > 0 || row.hardFilterStatus === "PENDING";
  const issues = [...(row.failedRules ?? []), ...(entry?.issues ?? [])];
  const prefix = a.rawOnset ? "8.0 신규 돌파 · " : "";
  if (!a.current)
    return {
      primary: suppression === "held" ? "보유 · 판단 미확인" : "판단 미확인",
      secondary: "기준일 가격 확인 필요",
      tone: "warn",
    };
  if (suppression === "held") {
    if (a.exit.startsWith("보유 시 기술청산 조건 충족"))
      return {
        primary: "보유 · 청산 조건 충족",
        secondary: a.exit.split(" · ")[1]!,
        tone: "danger",
      };
    if (a.exit === "기술청산 판단 미확인")
      return { primary: "보유 · 청산 판단 미확인", secondary: "기술점수 확인 필요", tone: "warn" };
    return {
      primary: "보유 · 기술청산 없음",
      secondary: a.rawOnset ? "8.0 신규 돌파 · 추가 진입 제외" : "추가 진입 제외",
      tone: "normal",
    };
  }
  if (suppression === "sold")
    return {
      primary: "매도한 신호 · 재진입 제외",
      secondary: a.rawOnset ? "8.0 신규 돌파 (참고)" : "새 신호 확인 필요",
      tone: "normal",
    };
  if (
    row.hardFilterStatus === "FAIL" ||
    (row.failedRules?.length ?? 0) > 0 ||
    entry?.state === "rejected"
  ) {
    const reason = issues.some((s) => s.includes("RISK_OFF"))
      ? "시장 RISK_OFF"
      : issues.some((s) => s.includes("RSAccel") && s.includes("0 이하"))
        ? "RSAccel 미충족"
        : issues.some((s) => s.includes("V8 8점 미만"))
          ? "확인일 8점 미만"
          : brief(row.failedRules?.[0] ?? "확인 조건 미충족");
    return {
      primary: `${prefix}진입 제외`,
      secondary: `${reason}${pending ? " · 자료 대기" : ""}`,
      tone: "danger",
    };
  }
  if (pending)
    return { primary: `${prefix}진입 미확정`, secondary: "필수 자료 확인 대기", tone: "warn" };
  if (isOperationalEntry(row, asOfDate))
    return {
      primary: `${prefix}${context ? "진입 준비" : "진입 조건 충족"}`,
      secondary: context ? "체결 전 조건 재확인" : "보유정보 확인 필요",
      tone: "positive",
    };
  if (row.kospiEntry?.state === "confirmed" && row.kospiEntry.date !== asOfDate)
    return { primary: "기한 지난 확인 · 진입 제외", secondary: "새 Onset 필요", tone: "normal" };
  if (entry?.state === "pending")
    return { primary: `${prefix}하루 확인 대기`, secondary: "다음 거래일 종가 확인", tone: "warn" };
  if (entry?.state === "unobservable" || a.score === null || a.rawOnset === null)
    return {
      primary: `${prefix}진입 판단 미확인`,
      secondary: issues.some((s) => s.includes("시장국면 미확인"))
        ? "시장국면 미확인"
        : "연속 점수·확인 자료 부족",
      tone: "warn",
    };
  return {
    primary: a.rawOnset ? "8.0 신규 돌파 · 진입 미확정" : "관찰",
    secondary: a.rawOnset ? "진입 조건 상세 확인" : "새 8.0 돌파 없음",
    tone: "normal",
  };
}

/** Exit conditions for unheld stocks are detail-only, not a sell warning in this list. */
export function getCompactStockWarnings(row: ScreeningRow): string[] {
  return getDisplayWarnings(row).filter((warning) => !/Exit|청산/i.test(warning));
}
