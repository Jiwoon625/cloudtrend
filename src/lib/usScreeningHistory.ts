import type { ScreeningSnapshot, SnapshotEntry } from "./screeningSnapshot";

/** Read adapter only: never invent missing historical onset, eligibility or execution IDs. */
export interface UsHistoryRecord {
  date: string;
  data_hash: string;
  rule_version: string;
  created_at: string;
  signals?: Record<string, unknown>[];
}
export function usHistorySnapshot(record: UsHistoryRecord): ScreeningSnapshot {
  const entries: SnapshotEntry[] = (record.signals ?? []).map((r) => ({
    symbol: String(r["symbol"]),
    name: String(r["name"] ?? r["symbol"]),
    market: "US",
    instrumentType: "STOCK",
    sectorCode: String(r["sector"] ?? ""),
    sectorName: String(r["sector"] ?? ""),
    grade: "",
    status: r["a0Entry"] === true ? "A0 진입 준비" : "과거 저장 신호",
    totalScore: typeof r["coreRank"] === "number" ? r["coreRank"] : 0,
    technicalPoints: typeof r["coreRank"] === "number" ? r["coreRank"] : null,
    priorityPoints: typeof r["betaRank"] === "number" ? r["betaRank"] : 0,
    scoreDelta1d: null,
    hardFilterPassed: false,
    evidence: { ...r },
  }));
  return {
    market: "US",
    strategyVersion: record.rule_version,
    dataHash: record.data_hash,
    historySource: "US_DAILY",
    date: record.date,
    asOfDate: record.date,
    savedAt: record.created_at,
    storedAt: record.created_at,
    marketGateStatus: "UNRECORDED",
    totalCount: entries.length,
    passedCount: entries.filter((r) => r.evidence?.["a0Entry"] === true).length,
    gradeACount: 0,
    gradeBCount: 0,
    entries,
  };
}
export function historyRecordKey(s: ScreeningSnapshot) {
  return [
    s.market ?? "KR",
    s.runId ?? s.historySource ?? "KR_DAILY",
    s.asOfDate,
    s.savedAt,
    s.dataHash ?? "",
  ].join("|");
}
export function usHistorySignals(entry: SnapshotEntry, strategy = "ALL") {
  const evidence = entry.evidence ?? {};
  const strategies = strategy === "ALL" ? ["A0", "A2", "B3"] : [strategy];
  return {
    entries: strategies.filter((s) => evidence[`${s.toLowerCase()}Entry`] === true),
    exits: strategies.filter((s) => evidence[`${s.toLowerCase()}Exit`] === true),
    onset: typeof evidence["rawOnset"] === "boolean" ? evidence["rawOnset"] : undefined,
  };
}
