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
    rank: rank + 1,
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
  const stockRows = analysis.rows.filter((row) => row.instrument.instrumentType === "STOCK");
  const etfRows = analysis.rows.filter((row) => row.instrument.instrumentType === "ETF");
  const mappedRows = analysis.rows.filter((row) => row.instrument.sectorCode !== "ETC");
  const unmappedRows = analysis.rows.filter((row) => row.instrument.sectorCode === "ETC");
  const sectorCounts = new Map<string, { sectorCode: string; sectorName: string; count: number }>();
  for (const row of analysis.rows) {
    const key = `${row.instrument.sectorCode}\u0000${row.instrument.sectorName}`;
    const current = sectorCounts.get(key);
    sectorCounts.set(key, {
      sectorCode: row.instrument.sectorCode,
      sectorName: row.instrument.sectorName,
      count: (current?.count ?? 0) + 1,
    });
  }
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
    sectorCoverage: {
      total: analysis.rows.length,
      mapped: mappedRows.length,
      unmapped: unmappedRows.length,
      stocks: {
        total: stockRows.length,
        mapped: stockRows.filter((row) => row.instrument.sectorCode !== "ETC").length,
        unmapped: stockRows.filter((row) => row.instrument.sectorCode === "ETC").length,
      },
      etfs: {
        total: etfRows.length,
        mapped: etfRows.filter((row) => row.instrument.sectorCode !== "ETC").length,
        unmapped: etfRows.filter((row) => row.instrument.sectorCode === "ETC").length,
      },
      unmappedSymbols: unmappedRows.map((row) => ({
        symbol: row.instrument.symbol,
        name: row.instrument.name,
        instrumentType: row.instrument.instrumentType,
      })),
      sectors: [...sectorCounts.values()].sort(
        (a, b) => b.count - a.count || a.sectorCode.localeCompare(b.sectorCode),
      ),
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
  const mapped = bundle.data.universe.filter((item) => item.sectorCode !== "ETC");
  return {
    asOfDate: bundle.data.asOfDate,
    period: { from: result.from, to: result.to, oosStart: result.splitBoundaries.oosStart },
    universe: {
      symbolCount: result.symbolCount,
      mappedSymbols: mapped.length,
      unmappedSymbols: bundle.data.universe.length - mapped.length,
      sectorCount: new Set(mapped.map((item) => item.sectorCode)).size,
      sectorCounts: Object.entries(
        bundle.data.universe.reduce<Record<string, { sectorName: string; count: number }>>(
          (counts, item) => {
            const current = counts[item.sectorCode];
            counts[item.sectorCode] = {
              sectorName: item.sectorName,
              count: (current?.count ?? 0) + 1,
            };
            return counts;
          },
          {},
        ),
      )
        .map(([sectorCode, value]) => ({
          sectorCode,
          sectorName: value.sectorName,
          count: value.count,
        }))
        .sort((a, b) => b.count - a.count || a.sectorCode.localeCompare(b.sectorCode)),
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
