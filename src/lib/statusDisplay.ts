import type { ScreeningRow } from "@/lib/engine/pipeline";

/**
 * V8 Final status label derived from structural signal fields.
 * Presentation should use this instead of cached actionLabelText so wording changes
 * do not require cache rebuilds.
 */
export function getDisplayStatus(
  row: Pick<ScreeningRow, "kosdaq80Onset" | "exitSignal" | "grade">,
): string {
  if (row.kosdaq80Onset && row.exitSignal) return "KOSDAQ80 Onset · V8 Exit 조건";
  if (row.kosdaq80Onset) return "KOSDAQ80 Onset";
  if (row.exitSignal === "UP95") return "V8 Exit · 9.5점 이상";
  if (row.exitSignal === "DOWN25") return "V8 Exit · 2.5점 이하";
  if (row.grade === "A") return "관심 후보";
  if (row.grade === "B") return "관찰 후보";
  return "관찰";
}
