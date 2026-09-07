// 계정별 일별 스냅샷. Supabase에서 최근 90개 날짜를 보관한다.
import { useCallback, useEffect, useState } from "react";

import { supabase, userId } from "@/lib/cloud";
import { toast } from "sonner";
let snapshots: ScreeningSnapshot[] = [];
export async function hydrateSnapshots() {
  const { data, error } = await supabase
    .from("screening_history")
    .select("snapshot")
    .order("date", { ascending: false })
    .limit(90);
  if (error) throw error;
  snapshots = (data ?? []).map((r) => r.snapshot as ScreeningSnapshot);
  for (const listener of listeners) listener();
}

export interface SnapshotEntry {
  symbol: string;
  name: string;
  instrumentType: "STOCK" | "ETF";
  grade: string;
  totalScore: number;
  technicalPoints: number;
  hardFilterPassed: boolean;
}

export interface ScreeningSnapshot {
  /** KST 기준 저장 날짜 (YYYY-MM-DD) — 같은 날 재스크리닝 시 덮어쓴다. */
  date: string;
  savedAt: string;
  asOfDate: string;
  marketGateStatus: string;
  totalCount: number;
  passedCount: number;
  gradeACount: number;
  gradeBCount: number;
  entries: SnapshotEntry[];
}

export interface GradeDiff {
  previous: ScreeningSnapshot | null;
  newGradeA: SnapshotEntry[];
  droppedAtoB: SnapshotEntry[];
}

const listeners = new Set<() => void>();

export function kstDateKey(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return parts; // YYYY-MM-DD
}

export function loadSnapshots(): ScreeningSnapshot[] {
  return snapshots;
}

export async function saveSnapshot(snapshot: ScreeningSnapshot) {
  const { error } = await supabase
    .from("screening_history")
    .upsert(
      { user_id: await userId(), date: snapshot.date, snapshot },
      { onConflict: "user_id,date" },
    );
  if (error) throw error;
  await hydrateSnapshots();
}
export async function deleteSnapshot(date: string) {
  const { error } = await supabase
    .from("screening_history")
    .delete()
    .eq("user_id", await userId())
    .eq("date", date);
  if (error) throw error;
  await hydrateSnapshots();
}
export async function clearSnapshots() {
  const { error } = await supabase
    .from("screening_history")
    .delete()
    .eq("user_id", await userId());
  if (error) throw error;
  await hydrateSnapshots();
}

/** 기준 스냅샷과 그 이전 영업일 스냅샷을 비교해 신규 A / A→B 하락을 구한다. */
export function diffSnapshots(
  current: ScreeningSnapshot,
  all: ScreeningSnapshot[] = loadSnapshots(),
): GradeDiff {
  const previous =
    all.filter((s) => s.date < current.date).sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
  if (!previous) return { previous: null, newGradeA: [], droppedAtoB: [] };

  const prevMap = new Map(previous.entries.map((e) => [e.symbol, e]));
  const newGradeA = current.entries.filter(
    (e) => e.grade === "A" && prevMap.get(e.symbol)?.grade !== "A",
  );
  const droppedAtoB = current.entries.filter(
    (e) => prevMap.get(e.symbol)?.grade === "A" && e.grade === "B",
  );
  return { previous, newGradeA, droppedAtoB };
}

export function useSnapshots(): {
  snapshots: ScreeningSnapshot[];
  refresh: () => void;
  remove: (date: string) => void;
  clear: () => void;
} {
  const [snapshots, setSnapshots] = useState<ScreeningSnapshot[]>([]);
  useEffect(() => {
    const l = () => setSnapshots(loadSnapshots());
    l();
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return {
    snapshots,
    refresh: useCallback(() => {
      void hydrateSnapshots().catch((e: Error) => toast.error(e.message));
    }, []),
    remove: useCallback((date: string) => {
      if (window.confirm("이 날짜의 클라우드 이력을 삭제할까요?"))
        void deleteSnapshot(date).catch((e: Error) => toast.error(e.message));
    }, []),
    clear: useCallback(() => {
      if (window.confirm("모든 기기에서 공유하는 이력을 전체 삭제할까요?"))
        void clearSnapshots().catch((e: Error) => toast.error(e.message));
    }, []),
  };
}

interface SnapshotSourceRow {
  instrument: { symbol: string; name: string; instrumentType: "STOCK" | "ETF" };
  grade: string;
  totalScoreNormalized: number;
  technical: { points: number };
  hardFilterPassed: boolean;
}

/** 분석 결과를 저장용 스냅샷으로 변환한다. */
export function buildSnapshot(analysis: {
  asOfDate: string;
  calculatedAt: string;
  marketGate: { status: string };
  rows: SnapshotSourceRow[];
}): ScreeningSnapshot {
  const entries: SnapshotEntry[] = analysis.rows.map((r) => ({
    symbol: r.instrument.symbol,
    name: r.instrument.name,
    instrumentType: r.instrument.instrumentType,
    grade: r.grade,
    totalScore: r.totalScoreNormalized,
    technicalPoints: r.technical.points,
    hardFilterPassed: r.hardFilterPassed,
  }));
  const passed = entries.filter((e) => e.hardFilterPassed);
  return {
    date: kstDateKey(new Date(analysis.calculatedAt)),
    savedAt: analysis.calculatedAt,
    asOfDate: analysis.asOfDate,
    marketGateStatus: analysis.marketGate.status,
    totalCount: entries.length,
    passedCount: passed.length,
    gradeACount: passed.filter((e) => e.grade === "A").length,
    gradeBCount: passed.filter((e) => e.grade === "B").length,
    entries,
  };
}
