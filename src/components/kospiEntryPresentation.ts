import type { ScreeningRow } from "@/lib/engine/pipeline";
import { KOSPI_ENTRY_POLICY, isKospiEntryReady } from "@/lib/engine/kospiEntryConfirmation";

export function kospiMarketGateLabel(status: string | undefined): string {
  switch (status) {
    case "RISK_ON":
      return "Risk-On";
    case "NEUTRAL":
      return "Neutral";
    case "RISK_OFF":
      return "Risk-Off(하락장)";
    default:
      return "Unknown(미확인)";
  }
}

export function kospiEntryStateLabel(entry: ScreeningRow["kospiEntry"]): string {
  if (!entry) return "확인 기록 없음 · 진입 제외";
  switch (entry.state) {
    case "pending":
      return "하루 확인 대기";
    case "confirmed":
      if (isKospiEntryReady(entry)) return "하루 확인 완료 · 시장국면 통과";
      return entry.date < KOSPI_ENTRY_POLICY.effectiveConfirmationDate ||
        entry.version !== KOSPI_ENTRY_POLICY.version
        ? "과거 확인 참고 · 운영 진입 제외"
        : "확인 기록 미충족 · 진입 제외";
    case "rejected":
      return "확인 탈락 · 진입 제외 · 새 Onset 필요";
    case "unobservable":
      return "확인 불가 · 진입 제외 · 새 Onset 필요";
    case "none":
      return "확인 대상 없음";
  }
}

/** Display stored dated evidence; an old permissive/undated gate is never a fallback. */
export function kospiMarketGateDisplay(
  evidence: import("@/lib/engine/kospiMarketGate").KospiMarketGateEvidence | null | undefined,
  expectedDate: string,
): import("@/lib/engine/kospiMarketGate").KospiMarketGateEvidence {
  if (evidence && evidence.date === expectedDate) {
    const incomplete =
      evidence.status === "UNKNOWN" ||
      evidence.incomplete ||
      evidence.issues.length > 0 ||
      evidence.evaluatedCount !== 4;
    return { ...evidence, status: incomplete ? "UNKNOWN" : evidence.status, incomplete };
  }
  return {
    date: expectedDate,
    status: "UNKNOWN",
    issues: [
      evidence
        ? `시장자료 기준일 불일치 · 저장 ${evidence.date} / 필요 ${expectedDate}`
        : "날짜별 시장자료 없음",
    ],
    benchmarkAboveMa60: null,
    benchmarkAboveCloud: null,
    vkospiBelow30: null,
    foreignNet5dPositive: null,
    metCount: 0,
    evaluatedCount: 0,
    incomplete: true,
    benchmarkDate: evidence?.benchmarkDate ?? null,
    vkospi: null,
    volatilitySource: null,
    marketForeignNet5d: null,
    marketForeignDates: [],
  };
}

export function kospiVolatilitySourceLabel(
  source: import("@/lib/engine/dataset").KospiVolatilitySource | null,
): string {
  switch (source) {
    case "VKOSPI":
      return "VKOSPI";
    case "REALIZED_VOLATILITY_KOSPI":
      return "KOSPI 실현변동성 대용치";
    case "REALIZED_VOLATILITY_KOSPI_KOSDAQ_70_30":
      return "KOSPI·KOSDAQ 70:30 실현변동성 대용치";
    case "MOCK_VKOSPI":
      return "모의 VKOSPI";
    default:
      return "출처 미확인";
  }
}
