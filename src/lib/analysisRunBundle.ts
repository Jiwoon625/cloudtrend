import type { BacktestRunBundle } from "./backtestRunBundle";
import type { AnalysisResult, ScreeningRow } from "./engine/pipeline";
import type { ScreeningSnapshot } from "./screeningSnapshot";

export type AnalysisRunKind = "BACKTEST" | "SCREENING";
export type AnalysisRunStatus = "RUNNING" | "COMPLETED" | "FAILED";

export interface AnalysisRunSummaryRecord {
  id: string;
  user_id: string;
  kind: AnalysisRunKind;
  status: AnalysisRunStatus;
  run_key: string;
  requested_by: string;
  code_version: string;
  data_version: string;
  config: Record<string, unknown>;
  summary: Record<string, unknown>;
  as_of_date: string | null;
  result_path: string | null;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

export interface ScreeningCandidateSummary {
  rank: number;
  symbol: string;
  name: string;
  market: string;
  sectorCode: string;
  sectorName: string;
  close: number;
  totalScore: number;
  scoreDelta1d: number | null;
  technicalPoints: number;
  technicalMaxPoints: number;
  priorityPoints: number;
  grade: string;
  status: string;
  hardFilterPassed: boolean;
  rs20: number | null;
  rs60: number | null;
  marketCap: number | null;
  warnings: string[];
  failedRules: string[];
}

function candidate(row: ScreeningRow, rank: number): ScreeningCandidateSummary {
  return {
    rank,
    symbol: row.instrument.symbol,
    name: row.instrument.name,
    market: row.instrument.market,
    sectorCode: row.instrument.sectorCode,
    sectorName: row.instrument.sectorName,
    close: row.snapshot.close,
    totalScore: row.totalScoreNormalized,
    scoreDelta1d: row.scoreDelta1d,
    technicalPoints: row.technical.points,
    technicalMaxPoints: row.technical.maxPoints,
    priorityPoints: row.priority.points,
    grade: row.grade,
    status: row.actionLabelText,
    hardFilterPassed: row.hardFilterPassed,
    rs20: row.rs20,
    rs60: row.rs60,
    marketCap: row.marketCap,
    warnings: row.warnings,
    failedRules: row.failedRules,
  };
}

function ranked(rows: ScreeningRow[]) {
  return [...rows].sort(
    (a, b) =>
      b.totalScoreNormalized - a.totalScoreNormalized ||
      (b.scoreDelta1d ?? -Infinity) - (a.scoreDelta1d ?? -Infinity) ||
      a.instrument.symbol.localeCompare(b.instrument.symbol),
  );
}

export function buildScreeningSummary(
  analysis: AnalysisResult,
  snapshot: ScreeningSnapshot,
  previous: ScreeningSnapshot | null,
) {
  const passed = analysis.rows.filter((row) => row.hardFilterPassed);
  const sortedPassed = ranked(passed);
  const onsets = sortedPassed.filter(
    (row) => row.actionLabelText === "진입후보" || row.actionLabelText === "우선진입후보",
  );
  const momentumRisk = ranked(analysis.rows.filter((row) => row.actionLabelText === "모멘텀 위험"));
  const failureReasons = new Map<string, number>();
  const warningCounts = new Map<string, number>();
  for (const row of analysis.rows) {
    for (const warning of row.warnings)
      warningCounts.set(warning, (warningCounts.get(warning) ?? 0) + 1);
    if (!row.hardFilterPassed) {
      for (const reason of row.failedRules)
        failureReasons.set(reason, (failureReasons.get(reason) ?? 0) + 1);
    }
  }

  const previousBySymbol = new Map(previous?.entries.map((entry) => [entry.symbol, entry]) ?? []);
  const newGradeA = snapshot.entries.filter(
    (entry) => entry.grade === "A" && previousBySymbol.get(entry.symbol)?.grade !== "A",
  );
  const droppedAtoB = snapshot.entries.filter(
    (entry) => previousBySymbol.get(entry.symbol)?.grade === "A" && entry.grade === "B",
  );

  const rotation = analysis.sectorRotation?.sectors ?? [];
  const topSectors = [...rotation]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 15)
    .map((sector) => ({
      rank: sector.rank,
      previousRank: sector.prevRank,
      sectorCode: sector.sectorCode,
      sectorName: sector.sectorName,
      rotationScore: sector.rotationScore,
      priceLeadershipScore: sector.priceLeadership.score,
      moneyFlowScore: sector.moneyFlow.score,
      rs20: sector.rs20,
      rs60: sector.rs60,
    }));

  return {
    asOfDate: analysis.asOfDate,
    calculatedAt: analysis.calculatedAt,
    strategyVersion: analysis.strategyVersion,
    dataVersion: analysis.dataVersion,
    market: {
      gate: analysis.marketGate,
      vkospi: analysis.vkospi,
      marketForeignNet5d: analysis.marketForeignNet5d,
      kospi: {
        close: analysis.kospi.close,
        dayReturn: analysis.kospi.dayReturn,
        ma60: analysis.kospi.ma60,
      },
      kosdaq: {
        close: analysis.kosdaq.close,
        dayReturn: analysis.kosdaq.dayReturn,
        ma60: analysis.kosdaq.ma60,
      },
    },
    counts: {
      total: analysis.rows.length,
      passed: passed.length,
      failed: analysis.rows.length - passed.length,
      gradeA: passed.filter((row) => row.grade === "A").length,
      gradeB: passed.filter((row) => row.grade === "B").length,
      entryOnset60: onsets.filter((row) => row.actionLabelText === "진입후보").length,
      priorityOnset70: onsets.filter((row) => row.actionLabelText === "우선진입후보").length,
      momentumRisk: momentumRisk.length,
      incomplete: analysis.rows.filter((row) => row.dataCompletenessRatio < 0.7).length,
    },
    previousSnapshotDate: previous?.date ?? null,
    newGradeA,
    droppedAtoB,
    topCandidates: sortedPassed.slice(0, 50).map(candidate),
    onsetCandidates: onsets.slice(0, 50).map(candidate),
    momentumRisk: momentumRisk.slice(0, 50).map(candidate),
    topSectors,
    failureReasons: [...failureReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    warningCounts: [...warningCounts.entries()]
      .map(([warning, count]) => ({ warning, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export function buildBacktestSummary(bundle: BacktestRunBundle) {
  const result = bundle.result;
  return {
    asOfDate: bundle.data.asOfDate,
    period: { from: result.from, to: result.to, oosStart: result.splitBoundaries.oosStart },
    universe: {
      symbolCount: result.symbolCount,
      mappedSectorCount: new Set(bundle.data.universe.map((item) => item.sectorCode)).size,
      sectorCounts: Object.entries(
        bundle.data.universe.reduce<Record<string, number>>((counts, item) => {
          counts[item.sectorCode] = (counts[item.sectorCode] ?? 0) + 1;
          return counts;
        }, {}),
      )
        .map(([sectorCode, count]) => ({ sectorCode, count }))
        .sort((a, b) => b.count - a.count),
    },
    config: bundle.config,
    baselineByHorizon: result.baselineByHorizon,
    scoreChangeRows: result.strategyValidation.scoreChangeRows,
    strategyRows: result.strategyValidation.rows,
    portfolioRows: result.strategyValidation.portfolioRows,
    riskRows: result.strategyValidation.riskRows,
    yearlyRows: result.strategyValidation.yearlyRows,
    regimeRows: result.strategyValidation.regimeRows,
    rankIcSummary: result.rankIcSummary,
    topSelection: result.topSelection,
    modelSummary: result.summary,
  };
}
