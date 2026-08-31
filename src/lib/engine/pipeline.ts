// 스크리닝 파이프라인: MarketDataset → 지표 → 실격 필터 → 시장 게이트 → 점수
// 데이터 공급자(mock / 토스증권 Open API)에 의존하지 않고 주입된 dataset만 사용한다.
import {
  computeIndicators,
  percentile,
  periodReturn,
  sma,
  type IndicatorSnapshot,
} from "./indicators";
import {
  ALL_AVAILABLE,
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
import type { DatasetCapabilities, MarketDataset } from "./dataset";
import type { EtfFacts, FinancialFacts, IndexSeries, Instrument } from "./types";

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
  skippedRules: string[];
  hardFilterPassed: boolean;
  financials: FinancialFacts | undefined;
  etf: EtfFacts | undefined;
  marketCap: number | null;
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
  isLive: boolean;
  capabilities: DatasetCapabilities;
  notes: string[];
  marketGate: MarketGate;
  vkospi: number | null;
  kospi: IndicatorSnapshot;
  kosdaq: IndicatorSnapshot;
  marketForeignNet5d: number | null;
  rows: ScreeningRow[];
  sectors: SectorScore[];
  tradeDates: string[];
  calculatedAt: string;
}

function indexOf(ds: MarketDataset, code: string): IndexSeries | undefined {
  return ds.indexSeries.find((s) => s.indexCode === code);
}

function indexSnapshot(ds: MarketDataset, code: string, offset = 0): IndicatorSnapshot | null {
  const series = indexOf(ds, code);
  if (!series) return null;
  return computeIndicators(series.bars, series.bars.length - 1 - offset);
}

function sectorSnapshotScores(ds: MarketDataset, rows: ScreeningRow[]): SectorScore[] {
  const kospi = indexOf(ds, "KOSPI");
  if (!kospi) return [];
  const kospiCloses = kospi.bars.map((b) => b.close);
  const lastIndex = kospi.bars.length - 1;
  const marketReturn20 = periodReturn(kospiCloses, lastIndex, 20) ?? 0;
  const marketReturn60 = periodReturn(kospiCloses, lastIndex, 60) ?? 0;
  const marketReturn20Prev = periodReturn(kospiCloses, lastIndex - 5, 20) ?? 0;

  // 섹터지수 시계열이 없는 경우(토스 Open API), 구성종목 일봉의 기간수익률 중위값으로 섹터 수익률을 합성한다.
  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  };
  const memberReturn = (symbols: string[], period: number, offset: number): number | null =>
    median(
      symbols
        .map((sym) => {
          const bars = ds.bars[sym] ?? [];
          if (bars.length === 0) return null;
          const closes = bars.map((b) => b.close);
          return periodReturn(closes, closes.length - 1 - offset, period);
        })
        .filter((v): v is number => v !== null),
    );

  const raw = ds.sectors.map((s) => {
    const series = indexOf(ds, `KRX_${s.code}`);
    const isSynthetic = !series;
    const closes = series ? series.bars.map((b) => b.close) : [];
    const li = closes.length - 1;
    const memberSymbols = rows
      .filter((r) => r.instrument.sectorCode === s.code && r.instrument.instrumentType === "STOCK")
      .map((r) => r.instrument.symbol);
    const r20 = series
      ? (periodReturn(closes, li, 20) ?? 0)
      : (memberReturn(memberSymbols, 20, 0) ?? marketReturn20);
    const r60 = series
      ? (periodReturn(closes, li, 60) ?? 0)
      : (memberReturn(memberSymbols, 60, 0) ?? marketReturn60);
    const r20prev = series
      ? (periodReturn(closes, li - 5, 20) ?? 0)
      : (memberReturn(memberSymbols, 20, 5) ?? marketReturn20Prev);
    const snap = series ? computeIndicators(series.bars, li) : null;


    const members = rows.filter((r) => r.instrument.sectorCode === s.code);
    const aligned = members.filter((m) => m.snapshot.maAligned === true).length;
    const nearHigh = members.filter((m) => (m.snapshot.distanceFrom52wHigh ?? -100) >= -10).length;
    const advancing = members.filter((m) => (m.snapshot.dayReturn ?? 0) > 0).length;
    const total = Math.max(1, members.length);

    // 섹터지수가 없으면 구성종목 과반 기준으로 추세 판정
    const majority = (pred: (m: ScreeningRow) => boolean | null): boolean | null => {
      const valid = members.map(pred).filter((v): v is boolean => v !== null);
      if (valid.length === 0) return null;
      return valid.filter(Boolean).length / valid.length > 0.5;
    };

    return {
      sectorCode: s.code,
      sectorName: s.name,
      rs20: (r20 - marketReturn20) * 100,
      rs60: (r60 - marketReturn60) * 100,
      rs20prev: (r20prev - marketReturn20Prev) * 100,
      aboveMa20:
        snap && snap.ma20 !== null
          ? snap.close > snap.ma20
          : majority((m) => (m.snapshot.ma20 !== null ? m.snapshot.close > m.snapshot.ma20 : null)),
      aboveMa60:
        snap && snap.ma60 !== null
          ? snap.close > snap.ma60
          : majority((m) => (m.snapshot.ma60 !== null ? m.snapshot.close > m.snapshot.ma60 : null)),
      aboveCloud:
        snap && snap.ichimoku.cloudTop !== null
          ? snap.close > snap.ichimoku.cloudTop
          : majority((m) =>
              m.snapshot.ichimoku.cloudTop !== null
                ? m.snapshot.close > m.snapshot.ichimoku.cloudTop
                : null,
            ),

      breadthMaAligned: (aligned / total) * 100,
      breadthNearHigh: (nearHigh / total) * 100,
      breadthAdvancing: (advancing / total) * 100,
      isSynthetic,
      gradeACount: members.filter((m) => m.grade === "A").length,
      gradeBCount: members.filter((m) => m.grade === "B").length,
      representativeEtf:
        members.find((m) => m.instrument.instrumentType === "ETF")?.instrument.name ?? null,
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

export function runAnalysis(ds: MarketDataset): AnalysisResult {
  const kospi = indexSnapshot(ds, "KOSPI");
  const kosdaq = indexSnapshot(ds, "KOSDAQ") ?? kospi;
  if (!kospi || !kosdaq) throw new Error("시장 지수(KOSPI/KOSDAQ) 시계열이 없어 분석할 수 없습니다.");

  const vkospi = ds.capabilities.volatilityIndex
    ? (ds.vkospiSeries[ds.vkospiSeries.length - 1] ?? null)
    : null;

  const kospiBars = indexOf(ds, "KOSPI")!.bars;
  const last5 = kospiBars.slice(-5);
  const marketForeignNet5d = ds.capabilities.investorFlow
    ? last5.every((b) => b.foreignNetBuyValue !== null)
      ? last5.reduce((a, b) => a + (b.foreignNetBuyValue ?? 0), 0)
      : null
    : null;

  const gate = evaluateMarketGate({ benchmark: kospi, vkospi, marketForeignNet5d });

  const availability = {
    marketCap: ds.capabilities.marketCap,
    etfFacts: ds.capabilities.etfFacts,
  };

  // 거래대금 백분위는 시장/유형별로 따로 계산
  const groups = new Map<string, number[]>();
  const prepared = ds.instruments
    .map((inst) => {
      const bars = ds.bars[inst.symbol] ?? [];
      if (bars.length === 0) return null;
      const snap = computeIndicators(bars, bars.length - 1);
      const arr = groups.get(inst.market) ?? [];
      arr.push(bars[bars.length - 1]!.tradingValue);
      groups.set(inst.market, arr);
      return { inst, bars, snap };
    })
    .filter((p): p is { inst: Instrument; bars: typeof kospiBars; snap: IndicatorSnapshot } => !!p);
  for (const [k, v] of groups) groups.set(k, v.sort((a, b) => a - b));

  const rows: ScreeningRow[] = prepared.map(({ inst, bars, snap }) => {
    const last = bars[bars.length - 1]!;
    const financials = ds.financials[inst.symbol];
    const etf = ds.etfFacts[inst.symbol];
    const valuePct = percentile(groups.get(inst.market) ?? [], last.tradingValue);

    const benchmarkCode = inst.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
    const benchmarkFallback = inst.instrumentType === "ETF" && !etf?.underlyingIndex;
    const bench = benchmarkCode === "KOSDAQ" ? kosdaq : kospi;

    const benchSeries = indexOf(ds, benchmarkCode) ?? indexOf(ds, "KOSPI")!;
    const benchCloses = benchSeries.bars.map((b) => b.close);
    const bli = benchCloses.length - 1;
    const benchR20 = periodReturn(benchCloses, bli, 20);
    const benchR60 = periodReturn(benchCloses, bli, 60);

    const tech = technicalScore(snap, valuePct);
    const prio = priorityScore(inst, snap, financials, last.marketCap, bench.dayReturn);
    const quality =
      inst.instrumentType === "STOCK"
        ? fundamentalScore(financials)
        : etfHealthScore(inst, ds.capabilities.etfFacts ? etf : undefined);

    const universe = evaluateUniverse(
      inst,
      snap,
      last.marketCap,
      last.tradingValue,
      bars.length,
      etf,
      DEFAULT_UNIVERSE,
      ds.isLive ? availability : ALL_AVAILABLE,
    );

    // 초저유동성(직전 20거래일 중 거래일이 절반 미만) 종목은 지표 왜곡이 커 실격 처리한다.
    const prior20 = bars.slice(Math.max(0, bars.length - 21), bars.length - 1);
    const tradedDays = prior20.filter((b) => b.volume > 0).length;
    if (prior20.length >= 20 && tradedDays < 10) {
      universe.failedRules.push(`직전 20거래일 중 거래일 ${tradedDays}일 (유동성 부족)`);
      universe.passed = false;
    }


    const technicalNormalized = normalize(tech);
    const priorityNormalized = normalize(prio);
    const qualityScore =
      quality.availableMaxPoints === 0 ? null : (quality.points / quality.availableMaxPoints) * 100;

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
      skippedRules: universe.skippedRules,
      hardFilterPassed: universe.passed,
      financials,
      etf,
      marketCap: last.marketCap,
      benchmarkCode,
      benchmarkFallback,
      rs20: snap.return20 !== null && benchR20 !== null ? (snap.return20 - benchR20) * 100 : null,
      rs60: snap.return60 !== null && benchR60 !== null ? (snap.return60 - benchR60) * 100 : null,
    };
  });

  const sectors = sectorSnapshotScores(ds, rows);
  const sectorByCode = new Map(sectors.map((s) => [s.sectorCode, s]));

  for (const row of rows) {
    const sector = sectorByCode.get(row.instrument.sectorCode);
    row.marketSectorScore = ds.capabilities.sectors && sector ? sector.score : null;
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

  return {
    asOfDate: ds.asOfDate,
    strategyVersion: STRATEGY_VERSION,
    dataVersion: ds.version,
    dataProvider: ds.provider,
    isLive: ds.isLive,
    capabilities: ds.capabilities,
    notes: ds.notes,
    marketGate: gate,
    vkospi,
    kospi,
    kosdaq,
    marketForeignNet5d,
    rows,
    sectors,
    tradeDates: ds.tradeDates,
    calculatedAt: new Date().toISOString(),
  };
}

export function getRow(ds: MarketDataset, symbol: string): ScreeningRow | undefined {
  return runAnalysis(ds).rows.find((r) => r.instrument.symbol === symbol);
}

export function scoreHistory(ds: MarketDataset, symbol: string, days = 60) {
  const bars = ds.bars[symbol] ?? [];
  const inst = ds.instruments.find((i) => i.symbol === symbol);
  if (!inst || bars.length === 0) return [];
  const out: Array<{ tradeDate: string; technicalPoints: number; grade: TechnicalGrade }> = [];
  for (let i = Math.max(120, bars.length - days); i < bars.length; i++) {
    const snap = computeIndicators(bars, i);
    const t = technicalScore(snap, 75);
    out.push({
      tradeDate: bars[i]!.tradeDate,
      technicalPoints: t.points,
      grade: technicalGrade(t.points),
    });
  }
  return out;
}

export function chartSeries(ds: MarketDataset, symbol: string, days = 160) {
  const bars = ds.bars[symbol] ?? [];
  const closes = bars.map((b) => b.close);
  const out = [];
  for (let i = Math.max(120, bars.length - days); i < bars.length; i++) {
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
