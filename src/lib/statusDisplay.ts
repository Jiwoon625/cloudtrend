import type { ScreeningRow } from "@/lib/engine/pipeline";
import { isKospiRelativeMomentumConfirmed } from "@/lib/kospiRelativeQuality";

/**
 * V8 Final status label derived from structural signal fields.
 * Presentation should use this instead of cached actionLabelText so wording changes
 * do not require cache rebuilds.
 *
 * KOSPI Relative Quality is display-only and never changes the V8 technical score.
 */
export function getDisplayStatus(row: ScreeningRow): string {
  if (row.kosdaq80Onset && row.exitSignal) return "KOSDAQ 8 ONSET · EXIT조건 달성";
  if (row.kosdaq80Onset) return "KOSDAQ 8 ONSET";

  const rsConfirmed = row.kospiEightPointEntry && isKospiRelativeMomentumConfirmed(row);
  if (row.kospiEightPointEntry && row.exitSignal)
    return rsConfirmed
      ? "8점 신규 진입 후보 · RS 확인 · V8 Exit 조건"
      : "8점 신규 진입 후보 · V8 Exit 조건";
  if (row.kospiEightPointEntry)
    return rsConfirmed ? "8점 신규 진입 후보 · RS 확인" : "8점 신규 진입 후보";

  if (row.exitSignal === "UP90") return "KOSDAQ Exit · 9.0점 상향 재돌파";
  if (row.exitSignal === "DOWN30") return "KOSDAQ Exit · 3.0점 하향 이탈";
  if (row.exitSignal === "UP95") return "V8 Exit · 9.5점 이상";
  if (row.exitSignal === "DOWN25") return "V8 Exit · 2.5점 이하";
  if (row.grade === "A") return "관심 후보";
  if (row.grade === "B") return "관찰 후보";
  return "관찰";
}
