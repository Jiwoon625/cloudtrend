import type { ScreeningRow } from "@/lib/engine/pipeline";

/** Dashboard projection: keep only structural fields read by the V8 Final dashboard table. */
export function compactDashboardRow(row: ScreeningRow): ScreeningRow {
  const technical = row.technical;
  const priority = row.priority;
  const vf = row.vf;

  return {
    instrument: {
      symbol: row.instrument.symbol,
      name: row.instrument.name,
      market: row.instrument.market,
      instrumentType: row.instrument.instrumentType,
      sectorCode: row.instrument.sectorCode,
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
    operatingScore10: row.operatingScore10,
    kosdaq80Onset: row.kosdaq80Onset,
    kospiEightPointEntry: row.kospiEightPointEntry,
    exitSignal: row.exitSignal,
    sectorPriceLeadership: row.sectorPriceLeadership,
    sectorRotationScore: row.sectorRotationScore,
    warnings: row.warnings,
    failedRules: row.failedRules,
    hardFilterPassed: row.hardFilterPassed,
    marketCap: row.marketCap,
    rs20: row.rs20,
    rs60: row.rs60,
  } as unknown as ScreeningRow;
}
