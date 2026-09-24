import type { InstrumentChartRange } from "./engine/instrumentChart";
import type { AnalysisResult } from "./engine/pipeline";
export const FAST_CHART_VERSION = "chart-v3-full-universe";
export type ChartKind = "prices" | "scored";
export interface ChartIdentity {
  inputFingerprint: string;
  resultDigest: string;
}
export function chartBucket(symbol: string) {
  let hash = 0;
  for (const char of symbol) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 64;
}
export function chartPath(
  identity: ChartIdentity,
  symbol: string,
  range: InstrumentChartRange,
  kind: ChartKind,
) {
  if (
    !/^[a-f0-9]{64}$/.test(identity.inputFingerprint) ||
    !/^[a-f0-9]{64}$/.test(identity.resultDigest)
  )
    throw new Error("Invalid chart identity");
  if (!/^[A-Z0-9]{1,20}$/.test(symbol)) throw new Error("Invalid symbol");
  return `cache/charts/${FAST_CHART_VERSION}/${identity.inputFingerprint}/${identity.resultDigest}/${range === "120" ? "bucket-" + chartBucket(symbol) : symbol + "-all"}-${kind}.json.gz`;
}
export function cardTechnicalScore(row: AnalysisResult["rows"][number]): number | null {
  return row.instrument.instrumentType === "STOCK"
    ? row.operatingScore10
    : (row.etfStrategy?.technical ?? row.technicalNormalized);
}
export function assertChartMatchesCard(
  chart: Array<{ tradeDate: string; historicalTechnicalPoints: number | null }>,
  analysis: AnalysisResult,
  symbol: string,
) {
  const row = analysis.rows.find((r) => r.instrument.symbol === symbol);
  if (!row) throw new Error("분석 결과에 없는 종목입니다.");
  const point = chart.at(-1);
  if (!point || point.tradeDate !== analysis.asOfDate) return; // Suspensions keep their actual last trading date.
  const expected = cardTechnicalScore(row),
    actual = point.historicalTechnicalPoints;
  if (expected === null ? actual !== null : actual === null || Math.abs(expected - actual) > 1e-8)
    throw new Error(`${symbol}: 카드와 차트 기술점수가 다릅니다. 캐시를 게시하지 않습니다.`);
}

export function chartReadyPath(identity: ChartIdentity, kind: ChartKind) {
  return chartPath(identity, "KOSPI", "120", kind).replace(/[^/]+$/, `${kind}-ready.json.gz`);
}
