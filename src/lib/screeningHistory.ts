// 스크리닝 결과 스냅샷을 브라우저(localStorage)에 하루 1건(그날의 마지막 결과)씩 보관한다.
import { useCallback, useEffect, useState } from "react";

const KEY = "trendscore.screeningHistory.v1";
const MAX_DAYS = 90;

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
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ScreeningSnapshot[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => s && typeof s.date === "string" && Array.isArray(s.entries))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  } catch {
    return [];
  }
}

function persist(list: ScreeningSnapshot[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_DAYS)));
  } catch {
    // 저장 실패(용량 초과 등)는 무시
  }
  for (const l of listeners) l();
}

/** 같은 날짜의 기존 스냅샷은 최신 결과로 교체한다. */
export function saveSnapshot(snapshot: ScreeningSnapshot) {
  const rest = loadSnapshots().filter((s) => s.date !== snapshot.date);
  persist([snapshot, ...rest].sort((a, b) => (a.date < b.date ? 1 : -1)));
}

export function deleteSnapshot(date: string) {
  persist(loadSnapshots().filter((s) => s.date !== date));
}

export function clearSnapshots() {
  persist([]);
}

/** 기준 스냅샷과 그 이전 영업일 스냅샷을 비교해 신규 A / A→B 하락을 구한다. */
export function diffSnapshots(
  current: ScreeningSnapshot,
  all: ScreeningSnapshot[] = loadSnapshots(),
): GradeDiff {
  const previous = all.filter((s) => s.date < current.date).sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
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
    refresh: useCallback(() => setSnapshots(loadSnapshots()), []),
    remove: useCallback((date: string) => deleteSnapshot(date), []),
    clear: useCallback(() => clearSnapshots(), []),
  };
}
