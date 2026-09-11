import type { ScreeningRow } from "@/lib/engine/pipeline";

/**
 * 대시보드의 ScreenerTable이 실제로 읽는 필드만 남긴다.
 * ScreeningRow 전체(지표 snapshot/점수 breakdown/재무 payload)를 반복 저장하지 않아
 * dashboard/latest.json을 화면 표시용 projection으로 유지한다.
 */
export function compactDashboardRow(row: ScreeningRow): ScreeningRow {
  const technical = row.technical;
  const priority = row.priority;
  const vf = row.vf;

  return {
    instrument: {
      symbol: row.instrument.symbol,
      name: row.instrument.name,
      market: row.instrument.market,
      sectorName: row.instrument.sectorName,
    },
    snapshot: {
      close: row.snapshot.close,
      volumeRatio20: row.snapshot.volumeRatio20,
      distanceFrom52wHigh: row.snapshot.distanceFrom52wHigh,
    },
    technical: {
      points: technical.points,
      maxPoints: technical.maxPoints,
      availableMaxPoints: technical.availableMaxPoints,
    },
    priority: {
      points: priority.points,
      maxPoints: priority.maxPoints,
      availableMaxPoints: priority.availableMaxPoints,
    },
    vf: vf
      ? {
          points: vf.points,
          maxPoints: vf.maxPoints,
          availableMaxPoints: vf.availableMaxPoints,
        }
      : null,
    totalScoreNormalized: row.totalScoreNormalized,
    scoreDelta1d: row.scoreDelta1d,
    dataCompletenessRatio: row.dataCompletenessRatio,
    grade: row.grade,
    actionLabelText: row.actionLabelText,
    warnings: row.warnings,
    failedRules: row.failedRules,
    hardFilterPassed: row.hardFilterPassed,
    marketCap: row.marketCap,
    rs20: row.rs20,
  } as unknown as ScreeningRow;
}
