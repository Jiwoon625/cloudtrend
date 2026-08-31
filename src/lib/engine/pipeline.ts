// 스크리닝 파이프라인: mock provider → 지표 → 실격 필터 → 시장 게이트 → 점수
import { computeIndicators, percentile, periodReturn, sma, type IndicatorSnapshot } from "./indicators";
import {
  DEFAULT_UNIVERSE,
  ETF_WEIGHTS,
  STOCK_WEIGHTS,
  STRATEGY_VERSION,
  actionLabel,
  collectWarnings,
  etfHealthScore,
  evaluateMarketGate,
  evaluateUniverse,
  fundamentalScore,
  normalize,
  priorityScore,
  technicalGrade,
  technicalScore,
  totalScore,
  type MarketGate,
  type ScoreBlock,
  type TechnicalGrade,
} from "./scoring";
import {
  AS_OF_DATE,
  DATA_PROVIDER,
  DATA_VERSION,
  INSTRUMENTS,
  SECTORS,
  TRADE_DATES,
  VKOSPI_SERIES,
  getBars,
  getEtfFacts,
  getFinancials,
  getIndexSeries,
} from "./mockProvider";
import type { EtfFacts, FinancialFacts, Instrument } from "./types";

export interface SectorScore {
  sectorCode: string;
  sectorName: string;
  rs20: number;
  rs60: number;
  aboveMa20: boolean | null;
  aboveMa60: boolean | null;
  aboveCloud: boolean | null;
  breadthMaAligned: number;
  breadthNearHigh: number;
  breadthAdvancing: number;
  score: number;
  rank: number;
  prevRank: number;
  isSynthetic: boolean;
  gradeACount: number;
  gradeBCount: number;
  representativeEtf: string | null;
}

export interface ScreeningRow {
  instrument: Instrument;
  snapshot: IndicatorSnapshot;
  technical: ScoreBlock;
  priority: ScoreBlock;
  quality: ScoreBlock; // 주식: 펀더멘털 / ETF: 상품건전성
  technicalNormalized: number | null;
  priorityNormalized: number | null;
  qualityScore: number | null;
  marketSectorScore: number | null;
  totalScoreNormalized: number;
  dataCompletenessRatio: number;
  grade: TechnicalGrade;
  actionLabelText: string;
  warnings: string[];
  failedRules: string[];
  hardFilterPassed: boolean;
  financials: FinancialFacts | undefined;
  etf: EtfFacts | undefined;
  marketCap: number;
  benchmarkCode: string;
  benchmarkFallback: boolean;
  rs20: number | null;
  rs60: number | null;
}

export interface AnalysisResult {
  asOfDate: string;
  strategyVersion: string;
  dataVersion: string;
  dataProvider: string;
  marketGate: MarketGate;
  vkospi: number | null;
  kospi: IndicatorSnapshot;
  kosdaq: IndicatorSnapshot;
  marketForeignNet5d: number | null;
  rows: ScreeningRow[];
  sectors: SectorScore[];
  calculatedAt: string;
}

function indexSnapshot(code: string, offset = 0): IndicatorSnapshot | null {
  const series = getIndexSeries(code);
  if (!series) return null;
  return computeIndicators(series.bars, series.bars.length - 1 - offset);
}

function sectorSnapshotScores(rows: Array<{ row: ScreeningRow }>): SectorScore[] {
  const kospi = getIndexSeries("KOSPI")!;
  const kospiCloses = kospi.bars.map((b) => b.close);
  const lastIndex = kospi.bars.length - 1;
  const marketReturn20 = periodReturn(kospiCloses, lastIndex, 20) ?? 0;
  const marketReturn60 = periodReturn(kospiCloses, lastIndex, 60) ?? 0;
  const marketReturn20Prev = periodReturn(kospiCloses, lastIndex - 5, 20) ?? 0;

  const raw = SECTORS.map((s) => {
    const series = getIndexSeries(`KRX_${s.code}`);
    const isSynthetic = !series;
    const closes = series ? series.bars.map((b) => b.close) : [];
    const li = closes.length - 1;
    const r20 = series ? (periodReturn(closes, li, 20) ?? 0) : 0;
    const r60 = series ? (periodReturn(closes, li, 60) ?? 0) : 0;
    const r20prev = series ? (periodReturn(closes, li - 5, 20) ?? 0) : 0;
    const snap = series ? computeIndicators(series.bars, li) : null;

    const members = rows.filter((r) => r.row.instrument.sectorCode === s.code);
    const aligned = members.filter((m) => m.row.snapshot.maAligned === true).length;
    const nearHigh = members.filter(
      (m) => (m.row.snapshot.distanceFrom52wHigh ?? -100) >= -10,
    ).length;
    const advancing = members.filter((m) => (m.row.snapshot.dayReturn ?? 0) > 0).length;
    const total = Math.max(1, members.length);

    return {
      sectorCode: s.code,
      sectorName: s.name,
      rs20: (r20 - marketReturn20) * 100,
      rs60: (r60 - marketReturn60) * 100,
      rs20prev: (r20prev - marketReturn20Prev) * 100,
      aboveMa20: snap && snap.ma20 !== null ? snap.close > snap.ma20 : null,
      aboveMa60: snap && snap.ma60 !== null ? snap.close > snap.ma60 : null,
      aboveCloud:
        snap && snap.ichimoku.cloudTop !== null ? snap.close > snap.ichimoku.cloudTop : null,
      breadthMaAligned: (aligned / total) * 100,
      breadthNearHigh: (nearHigh / total) * 100,
      breadthAdvancing: (advancing / total) * 100,
      isSynthetic,
      gradeACount: members.filter((m) => m.row.grade === "A").length,
      gradeBCount: members.filter((m) => m.row.grade === "B").length,
      representativeEtf:
        members.find((m) => m.row.instrument.instrumentType === "ETF")?.row.instrument.name ?? null,
    };
  });

  const rs20Sorted = [...raw.map((r) => r.rs20)].sort((a, b) => a - b);
  const rs60Sorted = [...raw.map((r) => r.rs60)].sort((a, b) => a - b);

  const scored = raw.map((r) => {
    const trendFlags = [r.aboveMa20, r.aboveMa60, r.aboveCloud];
    const trendMet = trendFlags.filter((f) => f === true).length;
    const trendScore = (trendMet / 3) * 20;
    const breadth = ((r.breadthMaAligned + r.breadthNearHigh + r.breadthAdvancing) / 300) * 20;
    const score =
      (percentile(rs20Sorted, r.rs20) / 100) * 35 +
      (percentile(rs60Sorted, r.rs60) / 100) * 25 +
      trendScore +
      breadth;
    return { ...r, score };
  });

  const byScore = [...scored].sort((a, b) => b.score - a.score);
  const prevByRs = [...scored].sort((a, b) => b.rs20prev - a.rs20prev);

  return byScore.map((r, i) => ({
    sectorCode: r.sectorCode,
    sectorName: r.sectorName,
    rs20: r.rs20,
    rs60: r.rs60,
    aboveMa20: r.aboveMa20,
    aboveMa60: r.aboveMa60,
    aboveCloud: r.aboveCloud,
    breadthMaAligned: r.breadthMaAligned,
    breadthNearHigh: r.breadthNearHigh,
    breadthAdvancing: r.breadthAdvancing,
    score: r.score,
    rank: i + 1,
    prevRank: prevByRs.findIndex((p) => p.sectorCode === r.sectorCode) + 1,
    isSynthetic: r.isSynthetic,
    gradeACount: r.gradeACount,
    gradeBCount: r.gradeBCount,
    representativeEtf: r.representativeEtf,
  }));
}

let cached: AnalysisResult | null = null;

export function runAnalysis(): AnalysisResult {
  if (cached) return cached;

  const kospi = indexSnapshot("KOSPI")!;
  const kosdaq = indexSnapshot("KOSDAQ")!;
  const vkospi = VKOSPI_SERIES[VKOSPI_SERIES.length - 1] ?? null;
  const kospiBars = getIndexSeries("KOSPI")!.bars;
  const marketForeignNet5d = kospiBars
    .slice(-5)
    .reduce((a, b) => a + b.foreignNetBuyValue, 0);

  const gate = evaluateMarketGate({ benchmark: kospi, vkospi, marketForeignNet5d });

  // 거래대금 백분위는 시장/유형별로 따로 계산
  const groups = new Map<string, number[]>();
  const prepared = INSTRUMENTS.map((inst) => {
    const bars = getBars(inst.symbol);
    const snap = computeIndicators(bars, bars.length - 1);
    const key = inst.market;
    const arr = groups.get(key) ?? [];
    arr.push(bars[bars.length - 1]!.tradingValue);
    groups.set(key, arr);
    return { inst, bars, snap };
  });
  for (const [k, v] of groups) groups.set(k, v.sort((a, b) => a - b));

  const rows: ScreeningRow[] = prepared.map(({ inst, bars, snap }) => {
    const last = bars[bars.length - 1]!;
    const financials = getFinancials(inst.symbol);
    const etf = getEtfFacts(inst.symbol);
    const valuePct = percentile(groups.get(inst.market) ?? [], last.tradingValue);

    const benchmarkCode =
      inst.market === "KOSDAQ" ? "KOSDAQ" : etf?.underlyingIndex ? "KOSPI" : "KOSPI";
    const benchmarkFallback = inst.instrumentType === "ETF" && !etf?.underlyingIndex;
    const bench = benchmarkCode === "KOSDAQ" ? kosdaq : kospi;

    const benchSeries = getIndexSeries(benchmarkCode)!;
    const benchCloses = benchSeries.bars.map((b) => b.close);
    const bli = benchCloses.length - 1;
    const benchR20 = periodReturn(benchCloses, bli, 20);
    const benchR60 = periodReturn(benchCloses, bli, 60);

    const tech = technicalScore(snap, valuePct);
    const prio = priorityScore(inst, snap, financials, last.marketCap, bench.dayReturn);
    const quality =
      inst.instrumentType === "STOCK" ? fundamentalScore(financials) : etfHealthScore(inst, etf);

    const universe = evaluateUniverse(
      inst,
      snap,
      last.marketCap,
      last.tradingValue,
      bars.length,
      etf,
      DEFAULT_UNIVERSE,
    );

    const technicalNormalized = normalize(tech);
    const priorityNormalized = normalize(prio);
    const qualityScore =
      quality.availableMaxPoints === 0
        ? null
        : (quality.points / quality.availableMaxPoints) * 100;

    return {
      instrument: inst,
      snapshot: snap,
      technical: tech,
      priority: prio,
      quality,
      technicalNormalized,
      priorityNormalized,
      qualityScore,
      marketSectorScore: null,
      totalScoreNormalized: 0,
      dataCompletenessRatio: 0,
      grade: technicalGrade(tech.points),
      actionLabelText: actionLabel(technicalGrade(tech.points), gate.status),
      warnings: [],
      failedRules: universe.failedRules,
      hardFilterPassed: universe.passed,
      financials,
      etf,
      marketCap: last.marketCap,
      benchmarkCode,
      benchmarkFallback,
      rs20:
        snap.return20 !== null && benchR20 !== null ? (snap.return20 - benchR20) * 100 : null,
      rs60:
        snap.return60 !== null && benchR60 !== null ? (snap.return60 - benchR60) * 100 : null,
    };
  });

  const sectors = sectorSnapshotScores(rows.map((row) => ({ row })));
  const sectorByCode = new Map(sectors.map((s) => [s.sectorCode, s]));

  for (const row of rows) {
    const sector = sectorByCode.get(row.instrument.sectorCode);
    row.marketSectorScore = sector ? sector.score : null;
    const weights = row.instrument.instrumentType === "STOCK" ? STOCK_WEIGHTS : ETF_WEIGHTS;
    const { total, dataCompletenessRatio } = totalScore({
      technicalNormalized: row.technicalNormalized,
      priorityNormalized: row.priorityNormalized,
      qualityScore: row.qualityScore,
      marketSectorScore: row.marketSectorScore,
      weights,
    });
    row.totalScoreNormalized = total;
    row.dataCompletenessRatio = dataCompletenessRatio;
    row.warnings = collectWarnings({
      snap: row.snapshot,
      gate,
      etf: row.etf,
      inst: row.instrument,
      dataCompletenessRatio,
      vkospi,
    });
  }

  cached = {
    asOfDate: AS_OF_DATE,
    strategyVersion: STRATEGY_VERSION,
    dataVersion: DATA_VERSION,
    dataProvider: DATA_PROVIDER,
    marketGate: gate,
    vkospi,
    kospi,
    kosdaq,
    marketForeignNet5d,
    rows,
    sectors,
    calculatedAt: new Date(`${AS_OF_DATE}T09:00:00Z`).toISOString(),
  };
  return cached;
}

export function getRow(symbol: string): ScreeningRow | undefined {
  return runAnalysis().rows.find((r) => r.instrument.symbol === symbol);
}

export function scoreHistory(symbol: string, days = 60) {
  const bars = getBars(symbol);
  const inst = INSTRUMENTS.find((i) => i.symbol === symbol);
  if (!inst || bars.length === 0) return [];
  const out: Array<{ tradeDate: string; technicalPoints: number; grade: TechnicalGrade }> = [];
  for (let i = Math.max(120, bars.length - days); i < bars.length; i++) {
    const snap = computeIndicators(bars, i);
    const t = technicalScore(snap, 75);
    out.push({ tradeDate: bars[i]!.tradeDate, technicalPoints: t.points, grade: technicalGrade(t.points) });
  }
  return out;
}

export function chartSeries(symbol: string, days = 160) {
  const bars = getBars(symbol);
  const out = [];
  for (let i = Math.max(120, bars.length - days); i < bars.length; i++) {
    const closes = bars.map((b) => b.close);
    const snap = computeIndicators(bars, i);
    out.push({
      tradeDate: bars[i]!.tradeDate,
      close: bars[i]!.close,
      high: bars[i]!.high,
      low: bars[i]!.low,
      open: bars[i]!.open,
      volume: bars[i]!.volume,
      ma20: sma(closes, 20, i),
      ma60: sma(closes, 60, i),
      ma120: sma(closes, 120, i),
      bbUpper: snap.bollinger.bb?.upper ?? null,
      bbLower: snap.bollinger.bb?.lower ?? null,
      cloudTop: snap.ichimoku.cloudTop,
      cloudBottom: snap.ichimoku.cloudBottom,
    });
  }
  return out;
}

export const ALL_TRADE_DATES = TRADE_DATES;
