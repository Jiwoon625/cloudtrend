import { getStoredOperationalExit, isOperationalEntry } from "@/lib/engine/operationalStrategy";
import type { SnapshotEntry } from "@/lib/screeningSnapshot";
import { kospiEntryStateLabel } from "./kospiEntryPresentation";

export function isHistoryOperationalEntry(entry: SnapshotEntry, asOfDate: string): boolean {
  if (entry.hardFilterStatus && entry.hardFilterStatus !== "PASS") return false;
  if (isOperationalEntry(entry, asOfDate)) return true;
  if (entry.kosdaq80Onset === true) return true;
  return /KOSDAQ\s*80\s*Onset|KOSDAQ\s*8\s*ONSET/i.test(entry.status ?? "");
}

export function historyEntryStatus(entry: SnapshotEntry): string {
  if (entry.hardFilterStatus === "PENDING")
    return `판단 보류 · ${entry.pendingRules?.join(" · ") || "필수 자료 미확인"}`;
  const status = entry.status?.trim() || (entry.hardFilterPassed ? "관찰" : "실격");
  if (getStoredOperationalExit(entry, "KOSPI")) return status;
  if (entry.kospiEntry && entry.kospiEntry.state !== "none")
    return `KOSPI ${kospiEntryStateLabel(entry.kospiEntry)}`;
  if (!entry.kospiEntry && (entry.kospi80Onset || entry.kospiEightPointEntry))
    return `기존 운영 기록: ${status} · 하루 확인 기록 없음`;
  return status
    .replace(/KOSDAQ80 Onset/gi, "KOSDAQ 8 ONSET")
    .replace(/KOSDAQ 80 Onset/gi, "KOSDAQ 8 ONSET");
}
