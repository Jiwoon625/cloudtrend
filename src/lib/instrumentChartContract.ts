import type { InstrumentChartRange } from "./engine/instrumentChart";
import type { AnalysisResult } from "./engine/pipeline";
import type { EtfInstrumentChartBundle } from "./engine/etfInstrumentChart";
import { etfPartialEvidence } from "./etfPartialEvidence";
import { ETF_POLICY } from "./engine/etfStrategy";
import { OPERATIONAL_INDEX_START } from "./operationalUnderlyingIndex";
import type { OperationalAnalysis, OperationalEtfSnapshot } from "./operationalEtfMa60";
export const FAST_CHART_VERSION = "chart-v3-full-universe";
export const ETF_CHART_VERSION = "etf-chart-v3-operational-underlying";
export type ChartKind = "prices" | "scored" | "etf" | "etf-prices";
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
  const version = kind.startsWith("etf") ? ETF_CHART_VERSION : FAST_CHART_VERSION;
  return `cache/charts/${version}/${identity.inputFingerprint}/${identity.resultDigest}/${range === "120" ? "bucket-" + chartBucket(symbol) : symbol + "-all"}-${kind}.json.gz`;
}

/** A cached historical series must never relabel a previous score as today's M0. */
export function assertEtfChartMatchesCard(
  bundle: EtfInstrumentChartBundle,
  analysis: AnalysisResult,
  symbol: string,
) {
  const row = analysis.rows.find((r) => r.instrument.symbol === symbol);
  if (
    !row ||
    row.instrument.instrumentType !== "ETF" ||
    row.etfStrategy?.version !== ETF_POLICY.version ||
    bundle.symbol !== symbol ||
    bundle.asOfDate !== analysis.asOfDate ||
    bundle.version !== ETF_POLICY.version
  )
    throw new Error("ETF 차트 기준일·전략 버전이 다릅니다. 새로고침해 주세요.");
  if (
    bundle.chart.some((point) => point.tradeDate > analysis.asOfDate) ||
    bundle.underlying.some((point) => point.tradeDate > analysis.asOfDate) ||
    (bundle.underlyingAsOfDate !== null && bundle.underlyingAsOfDate > analysis.asOfDate)
  )
    throw new Error("ETF 차트에 기준일 이후 자료가 있습니다.");
  const point = bundle.chart.at(-1);
  if (point?.tradeDate === analysis.asOfDate) {
    const expected = etfPartialEvidence(row, analysis.asOfDate).score;
    const actual = point.m0Score;
    if (expected === null ? actual !== null : actual === null || Math.abs(expected - actual) > 1e-8)
      throw new Error(`${symbol}: 카드와 차트 M0 총점이 다릅니다.`);
  }
  if (
    bundle.previousM0 &&
    (bundle.previousM0.date !== bundle.previousTradingDate ||
      bundle.previousM0.date >= analysis.asOfDate ||
      !Number.isFinite(bundle.previousM0.score) ||
      bundle.previousM0.score < 0 ||
      bundle.previousM0.score > 100)
  )
    throw new Error("ETF 직전 거래일 M0 근거가 다릅니다.");
  if (
    bundle.underlyingIndexVersion &&
    (analysis.asOfDate < OPERATIONAL_INDEX_START ||
      bundle.underlyingIndexAsOfDate !== analysis.asOfDate ||
      !bundle.underlyingIndexArtifactSha256 ||
      !bundle.underlyingIndexAvailableFrom)
  )
    throw new Error("ETF 운영 기초지수 기준일·출처가 다릅니다.");
  const metadata = (analysis as OperationalAnalysis).operationalIndex;
  if (
    metadata &&
    (bundle.underlyingIndexVersion !== metadata.version ||
      bundle.underlyingIndexArtifactSha256 !== metadata.artifactSha256 ||
      bundle.underlyingIndexAsOfDate !== metadata.asOfDate ||
      bundle.underlyingIndexAvailableFrom !== metadata.availableFrom)
  )
    throw new Error("ETF 카드와 차트 운영 기초지수 출처 버전이 다릅니다.");
  const strategy = row.etfStrategy as OperationalEtfSnapshot;
  if (strategy.underlyingIndexVersion) {
    const underlying = bundle.underlying.find((value) => value.tradeDate === analysis.asOfDate);
    const matches = (a: number | null | undefined, b: number | null) =>
      b === null ? a === null : typeof a === "number" && Math.abs(a - b) <= 1e-8;
    if (
      bundle.underlyingIndexVersion !== strategy.underlyingIndexVersion ||
      bundle.underlyingIndexArtifactSha256 !== strategy.underlyingIndexArtifactSha256 ||
      !underlying ||
      !matches(underlying.close, strategy.underlyingClose) ||
      !matches(underlying.ma60, strategy.underlyingMa60)
    )
      throw new Error(`${symbol}: 카드와 차트 운영 기초지수·MA60 근거가 다릅니다.`);
  }
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
