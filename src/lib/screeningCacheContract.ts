import { isOperationalEntry } from "@/lib/engine/operationalStrategy";
import { compactDashboardRow } from "@/lib/dashboardRow";
import type { AnalysisResult, ScreeningRow } from "@/lib/engine/pipeline";
import { isKospiRelativeMomentumConfirmed } from "@/lib/kospiRelativeQuality";

export const SCREENING_CACHE_VERSION = "screening-cache-v8-final-v5" as const;
export const DASHBOARD_CACHE_VERSION = "dashboard-cache-v8-final-v6" as const;
export const INSTRUMENT_CACHE_VERSION = "instrument-cache-v8-final-v6-sector-pl" as const;

export interface DashboardSummary {
  version: typeof DASHBOARD_CACHE_VERSION;
  createdAt: string;
  inputFingerprint: string;
  resultDigest: string;
  asOfDate: string;
  strategyVersion: string;
  dataVersion: string;
  calculatedAt: string;
  marketGate: AnalysisResult["marketGate"];
  kospi: AnalysisResult["kospi"];
  kosdaq: AnalysisResult["kosdaq"];
  vkospi: number | null;
  marketForeignNet5d: number | null;
  rotationSectors: Array<{
    sectorCode: string;
    sectorName: string;
    rank: number;
    prevRank: number;
    rs20: number | null;
    score: number;
    priceLeadership: number | null;
    moneyFlow: number | null;
  }>;
  counts: {
    total: number;
    passed: number;
    disqualified: number;
    kosdaq80Onsets: number;
    kospiEightPointEntries: number;
    kospiRelativeQualityConfirmed: number;
    upsideExits: number;
    downsideExits: number;
    incomplete: number;
  };
  failReasons: Array<[string, number]>;
  onsetRows: ScreeningRow[];
  kospiEntryRows: ScreeningRow[];
  exitRows: ScreeningRow[];
  top: ScreeningRow[];
}

export function stableCacheJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableCacheJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableCacheJson(object[key])}`)
    .join(",")}}`;
}

export function deterministicAnalysis(analysis: AnalysisResult) {
  return { ...analysis, calculatedAt: "" };
}

function buildRotationSectors(analysis: AnalysisResult): DashboardSummary["rotationSectors"] {
  const rotation = analysis.sectorRotation?.sectors ?? [];
  if (rotation.length > 0)
    return [...rotation]
      .sort((a, b) => a.rank - b.rank)
      .map((sector) => ({
        sectorCode: sector.sectorCode,
        sectorName: sector.sectorName,
        rank: sector.rank,
        prevRank: sector.prevRank,
        rs20: sector.rs20,
        score: sector.rotationScore,
        priceLeadership: sector.priceLeadership.score,
        moneyFlow: sector.moneyFlow.score,
      }));
  return [...analysis.sectors]
    .sort((a, b) => a.rank - b.rank)
    .map((sector) => ({
      sectorCode: sector.sectorCode,
      sectorName: sector.sectorName,
      rank: sector.rank,
      prevRank: sector.prevRank,
      rs20: sector.rs20,
      score: sector.score,
      priceLeadership: null,
      moneyFlow: null,
    }));
}

function signalPriority(a: ScreeningRow, b: ScreeningRow) {
  const priority = b.priority.points - a.priority.points;
  if (priority !== 0) return priority;
  const rotation = (b.sectorRotationScore ?? -Infinity) - (a.sectorRotationScore ?? -Infinity);
  if (rotation !== 0) return rotation;
  return (b.operatingScore10 ?? -Infinity) - (a.operatingScore10 ?? -Infinity);
}

export function buildDashboardSummary(
  analysis: AnalysisResult,
  inputFingerprint: string,
  resultDigest: string,
  createdAt = new Date().toISOString(),
): DashboardSummary {
  const rows = analysis.rows;
  const passed = rows.filter((row) => row.hardFilterPassed);
  const onsetRows = [...rows]
    .filter((row) => row.kosdaq80Onset)
    .sort(signalPriority)
    .slice(0, 30);
  const kospiEntryRows = [...rows]
    .filter((row) => row.kospi80Onset)
    .sort(signalPriority)
    .slice(0, 30);
  const exitRows = [...rows]
    .filter((row) => row.instrument.instrumentType === "STOCK" && row.exitSignal !== null)
    .sort((a, b) => (b.operatingScore10 ?? -Infinity) - (a.operatingScore10 ?? -Infinity))
    .slice(0, 30);
  const top = [...passed]
    .filter((row) => row.instrument.instrumentType === "STOCK")
    .sort(
      (a, b) =>
        Number(isOperationalEntry(b)) - Number(isOperationalEntry(a)) ||
        b.totalScoreNormalized - a.totalScoreNormalized,
    )
    .slice(0, 10);

  const failMap = new Map<string, number>();
  for (const row of rows) {
    if (row.hardFilterPassed) continue;
    for (const reason of row.failedRules) failMap.set(reason, (failMap.get(reason) ?? 0) + 1);
  }

  return {
    version: DASHBOARD_CACHE_VERSION,
    createdAt,
    inputFingerprint,
    resultDigest,
    asOfDate: analysis.asOfDate,
    strategyVersion: analysis.strategyVersion,
    dataVersion: analysis.dataVersion,
    calculatedAt: analysis.calculatedAt,
    marketGate: analysis.marketGate,
    kospi: analysis.kospi,
    kosdaq: analysis.kosdaq,
    vkospi: analysis.vkospi,
    marketForeignNet5d: analysis.marketForeignNet5d,
    rotationSectors: buildRotationSectors(analysis),
    counts: {
      total: rows.length,
      passed: passed.length,
      disqualified: rows.length - passed.length,
      kosdaq80Onsets: rows.filter((row) => row.kosdaq80Onset).length,
      kospiEightPointEntries: rows.filter((row) => row.kospi80Onset).length,
      kospiRelativeQualityConfirmed: rows.filter(
        (row) => row.kospi80Onset && isKospiRelativeMomentumConfirmed(row),
      ).length,
      upsideExits: rows.filter((row) => row.exitSignal === "UP95" || row.exitSignal === "UP90")
        .length,
      downsideExits: rows.filter(
        (row) => row.instrument.market === "KOSDAQ" && row.exitSignal === "DOWN30",
      ).length,
      incomplete: rows.filter(
        (row) => row.instrument.instrumentType === "STOCK" && row.operatingScore10 === null,
      ).length,
    },
    failReasons: [...failMap.entries()].sort((a, b) => b[1] - a[1]),
    onsetRows: onsetRows.map(compactDashboardRow),
    kospiEntryRows: kospiEntryRows.map(compactDashboardRow),
    exitRows: exitRows.map(compactDashboardRow),
    top: top.map(compactDashboardRow),
  };
}
