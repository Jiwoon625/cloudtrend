// 계정별 일별 스냅샷. Supabase에서 최근 90개 날짜를 보관한다.
import { useCallback, useEffect, useState } from "react";

import { supabase, userId } from "@/lib/cloud";
import {
  buildSnapshot,
  kstDateKey,
  type ScreeningSnapshot,
  type SnapshotEntry,
} from "@/lib/screeningSnapshot";
import { toast } from "sonner";

export { buildSnapshot, kstDateKey } from "@/lib/screeningSnapshot";
export type { ScreeningSnapshot, SnapshotEntry } from "@/lib/screeningSnapshot";

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

export interface GradeDiff {
  previous: ScreeningSnapshot | null;
  newGradeA: SnapshotEntry[];
  droppedAtoB: SnapshotEntry[];
}

const listeners = new Set<() => void>();

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
