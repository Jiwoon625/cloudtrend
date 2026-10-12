import { getStoredOperationalExit, isOperationalEntry } from "@/lib/engine/operationalStrategy";
import { validDate } from "@/lib/ledger/date";
import type { SnapshotEntry } from "@/lib/screeningSnapshot";
import { kospiEntryStateLabel } from "./kospiEntryPresentation";

export function isHistoryOperationalEntry(entry: SnapshotEntry, asOfDate: string): boolean {
  if (entry.hardFilterStatus && entry.hardFilterStatus !== "PASS") return false;
  if (isOperationalEntry(entry, asOfDate)) return true;
  if (entry.kosdaq80Onset === true) return true;
  return /KOSDAQ\s*80\s*Onset|KOSDAQ\s*8\s*ONSET/i.test(entry.status ?? "");
}

export function historyEntryStatus(entry: SnapshotEntry): string {
  if (entry.hardFilterStatus === "PENDING") {
    const pending = `판단 보류 · ${entry.pendingRules?.join(" · ") || "필수 자료 미확인"}`;
    return entry.kospiEntry?.state === "rejected"
      ? `KOSPI ${kospiEntryStateLabel(entry.kospiEntry)} · 신규 진입 제외 · ${pending}`
      : pending;
  }
  const status = (entry.status?.trim() || (entry.hardFilterPassed ? "관찰" : "실격")).replace(
    /onset/gi,
    "원신호",
  );
  if (getStoredOperationalExit(entry, "KOSPI")) return status;
  if (entry.kospiEntry && entry.kospiEntry.state !== "none")
    return `KOSPI ${kospiEntryStateLabel(entry.kospiEntry)}`;
  if (!entry.kospiEntry && (entry.kospi80Onset || entry.kospiEightPointEntry))
    return `기존 운영 기록: ${status} · 하루 확인 기록 없음`;
  return status
    .replace(/KOSDAQ80 원신호/gi, "KOSDAQ 8 원신호")
    .replace(/KOSDAQ 80 원신호/gi, "KOSDAQ 8 원신호");
}

export function historyEtfEvidence(entry: SnapshotEntry) {
  const evidence = entry.evidence?.["etfStrategy"];
  return evidence && typeof evidence === "object"
    ? (evidence as Partial<import("@/lib/engine/etfStrategy").EtfStrategySnapshot>)
    : undefined;
}

/** Archived observations only: never infer M0 from the technical subtotal. */
export function historyScoreLabel(entry: SnapshotEntry, asOfDate: string): string {
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value)
      ? Number(value.toFixed(2)).toString()
      : "미관측";
  if (entry.market === "US") return `Core ${number(entry.technicalPoints)}`;
  if (entry.instrumentType !== "ETF") return `기술 ${number(entry.technicalPoints)}/10`;
  const evidence = historyEtfEvidence(entry);
  const m0 = !evidence
    ? "미기록"
    : evidence.date !== asOfDate || evidence.dataStatus !== "ready"
      ? "미확인"
      : number(evidence.score);
  return `기술 ${number(entry.technicalPoints)}/100 · M0 ${m0}`;
}

export function historyEtfOnsetLabel(entry: SnapshotEntry, asOfDate: string): string {
  const evidence = historyEtfEvidence(entry);
  if (!evidence || typeof evidence.rawOnset !== "boolean") return "미기록";
  if (
    evidence.date !== asOfDate ||
    evidence.dataStatus !== "ready" ||
    typeof evidence.previousDate !== "string" ||
    !validDate(evidence.previousDate) ||
    evidence.previousDate >= asOfDate ||
    typeof evidence.previousScore !== "number" ||
    !Number.isFinite(evidence.previousScore) ||
    evidence.previousScore < 0 ||
    evidence.previousScore > 100 ||
    typeof evidence.score !== "number" ||
    !Number.isFinite(evidence.score) ||
    evidence.score < 0 ||
    evidence.score > 100
  )
    return "미확인";
  return evidence.rawOnset ? "원신호" : "없음";
}
