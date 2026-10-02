import { KOSPI_ENTRY_POLICY } from "./engine/kospiEntryConfirmation";
import type { ScreeningRow, V8ExitSignal } from "@/lib/engine/pipeline";
import { getDisplayStatus } from "@/lib/statusDisplay";

export interface SnapshotEntry {
  symbol: string;
  name: string;
  instrumentType: "STOCK" | "ETF";
  sectorCode: string;
  sectorName: string;
  grade: string;
  status: string;
  totalScore: number;
  scoreDelta1d: number | null;
  technicalPoints: number | null;
  priorityPoints: number;
  hardFilterPassed: boolean;
  /** V8 Final operational signals. Optional for backward compatibility with old snapshots. */
  kosdaq80Onset?: boolean;
  kospiEightPointEntry?: boolean;
  kospi80Onset?: boolean;
  kospiEntry?: import("./engine/kospiEntryConfirmation").KospiEntrySnapshot | undefined;
  operationalSignalVersion?: string;
  exitSignal?: V8ExitSignal;
}

export interface ScreeningSnapshot {
  /** 실제 자료 기준일 (YYYY-MM-DD) — 같은 기준일 재스크리닝 시 갱신한다. */
  date: string;
  savedAt: string;
  sourceRegisteredAt?: string;
  asOfDate: string;
  marketGateStatus: string;
  kospiMarketGate?: import("./engine/kospiMarketGate").KospiMarketGateEvidence | undefined;
  totalCount: number;
  passedCount: number;
  gradeACount: number;
  gradeBCount: number;
  /** 기술점수 기준 주식 상위 50. 이전 스냅샷 호환을 위해 optional. */
  topStocks?: SnapshotEntry[];
  /** 기술점수 기준 ETF 상위 50. 이전 스냅샷 호환을 위해 optional. */
  topEtfs?: SnapshotEntry[];
  /** 운영신호/등급 비교를 위해 전체 분석 결과를 유지한다. */
  entries: SnapshotEntry[];
}

export function kstDateKey(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function topTechnicalEntries(
  entries: SnapshotEntry[],
  instrumentType: SnapshotEntry["instrumentType"],
  limit = 50,
): SnapshotEntry[] {
  return entries
    .filter((entry) => entry.instrumentType === instrumentType)
    .sort(
      (a, b) =>
        (b.technicalPoints ?? -Infinity) - (a.technicalPoints ?? -Infinity) ||
        b.priorityPoints - a.priorityPoints ||
        a.name.localeCompare(b.name, "ko"),
    )
    .slice(0, limit);
}

/** 분석 결과를 웹·자동화가 공유하는 저장용 스냅샷으로 변환한다. */
export function buildSnapshot(
  analysis: {
    asOfDate: string;
    calculatedAt: string;
    marketGate: { status: string };
    kospiMarketGate?: import("./engine/kospiMarketGate").KospiMarketGateEvidence | undefined;
    rows: ScreeningRow[];
  },
  sourceRegisteredAt?: string,
): ScreeningSnapshot {
  const entries: SnapshotEntry[] = analysis.rows.map((row) => ({
    symbol: row.instrument.symbol,
    name: row.instrument.name,
    instrumentType: row.instrument.instrumentType,
    sectorCode: row.instrument.sectorCode,
    sectorName: row.instrument.sectorName,
    grade: row.grade,
    status: getDisplayStatus(row),
    totalScore: row.totalScoreNormalized,
    scoreDelta1d: row.scoreDelta1d,
    technicalPoints:
      row.instrument.instrumentType === "STOCK"
        ? row.operatingScore10
        : (row.vf ?? row.technical).points,
    priorityPoints: row.priority.points,
    hardFilterPassed: row.hardFilterPassed,
    kosdaq80Onset: row.kosdaq80Onset,
    kospiEightPointEntry: row.kospiEightPointEntry,
    kospiEntry: row.kospiEntry,
    kospi80Onset: row.kospi80Onset ?? false,
    ...(row.operationalSignalVersion
      ? { operationalSignalVersion: row.operationalSignalVersion }
      : {}),
    exitSignal: row.exitSignal,
  }));
  const passed = entries.filter((entry) => entry.hardFilterPassed);
  return {
    date: analysis.asOfDate,
    savedAt: analysis.calculatedAt,
    ...(sourceRegisteredAt ? { sourceRegisteredAt } : {}),
    asOfDate: analysis.asOfDate,
    marketGateStatus: analysis.marketGate.status,
    kospiMarketGate: analysis.kospiMarketGate,
    totalCount: entries.length,
    passedCount: passed.length,
    gradeACount: passed.filter((entry) => entry.grade === "A").length,
    gradeBCount: passed.filter((entry) => entry.grade === "B").length,
    topStocks: topTechnicalEntries(entries, "STOCK"),
    topEtfs: topTechnicalEntries(entries, "ETF"),
    entries,
  };
}

/** Registration time is provenance, never a substitute for market data time. */
export function latestSourceRegistration(
  sources: Array<{
    min_date: string | null;
    max_date: string | null;
    activated_at: string | null;
    created_at: string;
  }>,
  asOfDate: string,
): string | undefined {
  return sources
    .filter((s) => s.min_date && s.max_date && s.min_date <= asOfDate && s.max_date >= asOfDate)
    .map((s) => s.activated_at ?? s.created_at)
    .filter((t) => Number.isFinite(Date.parse(t)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

/** Recalculation must not replace the source record of pre-adoption modeled trades. */
export function preservePreAdoptionSnapshot(
  incoming: ScreeningSnapshot,
  existing: ScreeningSnapshot | null,
): ScreeningSnapshot {
  return existing &&
    existing.asOfDate === incoming.asOfDate &&
    incoming.asOfDate < KOSPI_ENTRY_POLICY.effectiveConfirmationDate
    ? existing
    : incoming;
}

/** Shared writer for browser, server and automation; data-read errors fail closed before replacement. */
export async function persistScreeningSnapshot(
  client: import("@supabase/supabase-js").SupabaseClient,
  userId: string,
  incoming: ScreeningSnapshot,
) {
  const { data, error } = await client
    .from("screening_history")
    .select("snapshot")
    .eq("user_id", userId)
    .eq("date", incoming.asOfDate)
    .maybeSingle();
  if (error) throw error;
  const snapshot = preservePreAdoptionSnapshot(
    incoming,
    (data?.snapshot as ScreeningSnapshot | undefined) ?? null,
  );
  if (snapshot !== incoming) return snapshot;
  const { error: writeError } = await client.from("screening_history").upsert(
    {
      user_id: userId,
      date: snapshot.asOfDate,
      snapshot: { ...snapshot, date: snapshot.asOfDate },
    },
    { onConflict: "user_id,date" },
  );
  if (writeError) throw writeError;
  return snapshot;
}
