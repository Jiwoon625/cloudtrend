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
  technicalPoints: number;
  priorityPoints: number;
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

interface SnapshotSourceRow {
  instrument: {
    symbol: string;
    name: string;
    instrumentType: "STOCK" | "ETF";
    sectorCode: string;
    sectorName: string;
  };
  grade: string;
  actionLabelText: string;
  totalScoreNormalized: number;
  scoreDelta1d: number | null;
  technical: { points: number };
  priority: { points: number };
  hardFilterPassed: boolean;
}

export function kstDateKey(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** 분석 결과를 웹·자동화가 공유하는 저장용 스냅샷으로 변환한다. */
export function buildSnapshot(analysis: {
  asOfDate: string;
  calculatedAt: string;
  marketGate: { status: string };
  rows: SnapshotSourceRow[];
}): ScreeningSnapshot {
  const entries: SnapshotEntry[] = analysis.rows.map((row) => ({
    symbol: row.instrument.symbol,
    name: row.instrument.name,
    instrumentType: row.instrument.instrumentType,
    sectorCode: row.instrument.sectorCode,
    sectorName: row.instrument.sectorName,
    grade: row.grade,
    status: row.actionLabelText,
    totalScore: row.totalScoreNormalized,
    scoreDelta1d: row.scoreDelta1d,
    technicalPoints: row.technical.points,
    priorityPoints: row.priority.points,
    hardFilterPassed: row.hardFilterPassed,
  }));
  const passed = entries.filter((entry) => entry.hardFilterPassed);
  return {
    date: kstDateKey(new Date(analysis.calculatedAt)),
    savedAt: analysis.calculatedAt,
    asOfDate: analysis.asOfDate,
    marketGateStatus: analysis.marketGate.status,
    totalCount: entries.length,
    passedCount: passed.length,
    gradeACount: passed.filter((entry) => entry.grade === "A").length,
    gradeBCount: passed.filter((entry) => entry.grade === "B").length,
    entries,
  };
}
