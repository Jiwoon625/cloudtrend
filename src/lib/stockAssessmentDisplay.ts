import type { ScreeningRow } from "./engine/pipeline";
import { getHeldOperationalExitSignal, isOperationalEntry } from "./engine/operationalStrategy";

export interface StockAssessmentDisplay {
  current: boolean;
  score: number | null;
  grade: ScreeningRow["grade"] | null;
  previousScore: number | null;
  volumeRatio20: number | null;
  rawOnset: boolean | null;
  conditions: string[];
  pending: string[];
  failed: string[];
  finalEntry: string;
  exit: string;
}
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const value = (n: number) => Number(n.toFixed(2)).toString();

/** Read-only presentation of completed screening evidence. Never consumed by trading rules. */
export function stockAssessmentDisplay(
  row: ScreeningRow,
  asOfDate: string,
  tradeDates?: readonly string[],
): StockAssessmentDisplay {
  const current =
    row.snapshot.tradeDate === asOfDate && finite(row.snapshot.close) && row.snapshot.close > 0;
  const score = current && finite(row.operatingScore10) ? row.operatingScore10 : null;
  const previousDate = tradeDates
    ?.filter((d) => d < asOfDate)
    .sort()
    .at(-1);
  const previousDated =
    !row.previousOperatingScoreDate ||
    !previousDate ||
    row.previousOperatingScoreDate === previousDate;
  const previousScore =
    score !== null && previousDated
      ? finite(row.previousOperatingScore10)
        ? row.previousOperatingScore10
        : finite(row.scoreDelta1d)
          ? score - row.scoreDelta1d / 10
          : null
      : null;
  const rawOnset =
    score !== null && previousScore !== null ? previousScore < 8 && score >= 8 : null;
  const conditions = [
    score === null
      ? "기술점수 산정 불가"
      : `기술점수 ${value(score)}/10 · ${row.grade}등급 (기술 기준)`,
    rawOnset === null
      ? "8.0점 신규 돌파 미확인"
      : `8.0점 신규 돌파 ${rawOnset ? "충족" : "미충족"} · ${value(previousScore!)} → ${value(score!)}`,
  ];
  const entry = row.kospiEntry;
  if (row.instrument.market === "KOSPI" && entry?.date === asOfDate) {
    if (entry.originDate)
      conditions.push(
        `Onset 기록 ${entry.originDate} · 확인 ${entry.confirmationDate ?? "다음 KOSPI 거래일 종가"}`,
      );
    if (entry.confirmationDate === asOfDate) {
      conditions.push(
        score === null
          ? "확인일 8점 유지 미확인"
          : `확인일 8점 유지 ${score >= 8 ? "충족" : "미충족"}`,
      );
      conditions.push(
        finite(entry.rsAccel)
          ? `확인일 RSAccel > 0 ${entry.rsAccel > 0 ? "충족" : "미충족"} · ${value(entry.rsAccel)}%p`
          : "확인일 RSAccel 미확인",
      );
    } else if (finite(row.rs20) && finite(row.rs60)) {
      conditions.push(`현재 RSAccel ${value(row.rs20 - row.rs60)}%p · 확인 전 참고`);
    }
    for (const [label, evidence, expected] of [
      ["Onset일 시장", entry.marketGate?.origin, entry.originDate],
      ["확인일 시장", entry.marketGate?.confirmation, entry.confirmationDate],
    ] as const) {
      if (!expected) continue;
      const observed =
        evidence?.date === expected &&
        !evidence.incomplete &&
        evidence.evaluatedCount === 4 &&
        !evidence.issues.length &&
        evidence.status !== "UNKNOWN";
      conditions.push(
        observed
          ? `${label} ${evidence.status} · ${evidence.status === "RISK_OFF" ? "미충족" : "충족"}`
          : `${label} 미확인`,
      );
    }
    conditions.push(...entry.issues);
  }
  const pending = [...(row.pendingRules ?? [])];
  const failed = [...(row.failedRules ?? [])];
  const heldExit =
    score !== null && previousScore !== null
      ? getHeldOperationalExitSignal(row.instrument.market, score, (score - previousScore) * 10)
      : null;
  const exit =
    score === null || previousScore === null
      ? "기술청산 판단 미확인"
      : heldExit === "UP95"
        ? "보유 시 기술청산 조건 충족 · 9.5점 상향돌파"
        : heldExit === "UP90"
          ? "보유 시 기술청산 조건 충족 · 9.0점 상향 재돌파"
          : heldExit === "DOWN30"
            ? "보유 시 기술청산 조건 충족 · 3.0점 하향 이탈"
            : "기술청산 조건 없음";
  const rejected = failed.length > 0 || (entry?.date === asOfDate && entry.state === "rejected");
  const finalEntry = !current
    ? "기준일 가격 미확인 · 최종 진입 미확정"
    : rejected
      ? "확인된 조건 미충족 · 신규 진입 제외"
      : pending.length || row.hardFilterStatus === "PENDING"
        ? "최종 진입 미확정 · 필수 자료 확인 대기"
        : isOperationalEntry(row, asOfDate)
          ? "저장된 운영 진입 조건 충족 · 보유·체결 조건 별도 확인"
          : "운영 신규 진입 조건 미충족";
  return {
    current,
    score,
    grade: score === null ? null : row.grade,
    previousScore,
    volumeRatio20:
      current && finite(row.snapshot.volumeRatio20) ? row.snapshot.volumeRatio20 : null,
    rawOnset,
    conditions: [...new Set(conditions)],
    pending,
    failed,
    finalEntry,
    exit,
  };
}
