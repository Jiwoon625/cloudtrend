import type { ScreeningRow } from "@/lib/engine/pipeline";

export function kospiEntryStateLabel(entry: ScreeningRow["kospiEntry"]): string {
  if (!entry) return "확인 기록 없음";
  switch (entry.state) {
    case "pending":
      return "하루 확인 대기";
    case "confirmed":
      return entry.eligible ? "하루 확인 완료" : "과거 확인 참고 · 운영 진입 제외";
    case "rejected":
      return "확인 탈락";
    case "unobservable":
      return "확인 불가";
    case "none":
      return "확인 대상 없음";
  }
}
