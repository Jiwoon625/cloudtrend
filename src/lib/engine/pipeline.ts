// 스크리닝 파이프라인: MarketDataset → 지표 → 실격 필터 → 시장 게이트 → 점수
// 데이터 공급자(mock / 토스증권 Open API)에 의존하지 않고 주입된 dataset만 사용한다.
import {
  computeIndicators,
  ichimoku,
  percentile,
  periodReturn,
  sma,
  type IndicatorSnapshot,
} from "./indicators";

import {
  ALL_AVAILABLE,
  DEFAULT_SCORING_CONFIG,
  STRATEGY_VERSION,
  actionLabel,
  collectWarnings,
  etfHealthScore,
  evaluateMarketGate,
  evaluateUniverse,
  fundamentalScore,
  historicalTechnicalScore,
  normalize,
  priorityScore,
  technicalGrade,
  technicalScore,
  totalScore,
  vfGrade,
  vfStockScore,
  type MarketGate,
  type ScoreBlock,
  type ScoringConfig,
  type TechnicalGrade,
} from "./scoring";
import {
  computeSectorRotation,
  type SectorRotationResult,
} from "./sectorRotation";
import type { DatasetCapabilities, MarketDataset } from "./dataset";
import type { DailyPrice, EtfFacts, FinancialFacts, IndexSeries, Instrument } from "./types";

/**
 * 섹터별 대표 종목 매핑 (대표 ETF 우선, 없으면 해당 섹터 시가총액 1위 종목).
 * 레버리지·인버스·채권·CD금리·해외자산·시장대표 ETF는 국내 산업 섹터 자금흐름 분석에서 제외한다.
 */
const NON_SECTOR_ETF = /채권|국고채|CD\s?금리|단기자금|머니마켓|MMF|금현물|달러|원유|커버드콜|미국|나스닥|S&P|필라델피아|글로벌|차이나|중국|일본|인도|베트남|유로|선진국|신흥국|리츠|TDF|배당성장|밸류업|레버리지|인버스|200TR|코스피|코스닥/i;

function buildRepresentativeEtf(
  ds: MarketDataset,
): Map<string, { symbol: string; name: string }> {
  const bestEtf = new Map<string, { symbol: string; name: string; value: number }>();
  const bestStock = new Map<string, { symbol: string; name: string; value: number }>();
  for (const inst of ds.instruments) {
    const bars = ds.bars[inst.symbol] ?? [];
    if (bars.length === 0) continue;
    if (inst.sectorCode === "MARKET_IDX" || inst.sectorCode === "ETC") continue;

    if (inst.instrumentType === "ETF") {
      if (inst.isLeveraged || inst.isInverse) continue;
      if (NON_SECTOR_ETF.test(inst.name)) continue;
      const recent = bars.slice(-20);
      const value = recent.reduce((a, b) => a + b.tradingValue, 0) / Math.max(1, recent.length);
      const cur = bestEtf.get(inst.sectorCode);
      if (!cur || value > cur.value) {
        bestEtf.set(inst.sectorCode, { symbol: inst.symbol, name: inst.name, value });
      }
      continue;
    }

    // 개별 주식: 시가총액(없으면 최근 거래대금) 최대 종목을 대표주로 사용
    if (inst.isPreferredStock) continue;
    const last = bars[bars.length - 1]!;
    const cap = last.marketCap;
    const value = cap !== null && Number.isFinite(cap) ? cap : last.tradingValue;
    if (!Number.isFinite(value)) continue;
    const cur = bestStock.get(inst.sectorCode);
    if (!cur || value > cur.value) {
      bestStock.set(inst.sectorCode, { symbol: inst.symbol, name: inst.name, value });
    }
  }

  const out = new Map<string, { symbol: string; name: string }>();
  for (const [code, v] of bestStock) out.set(code, { symbol: v.symbol, name: v.name });
  for (const [code, v] of bestEtf) out.set(code, { symbol: v.symbol, name: v.name });
  return out;
}


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
  /** Finalized seven-feature Vf score (stocks only). */
  vf: ScoreBlock | null;
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
  scoringConfig: ScoringConfig;
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
  /** 섹터 로테이션 엔진 결과 (가격 리더십 / 자금흐름 분리) */
  sectorRotation: SectorRotationResult | null;
  tradeDates: string[];
  calculatedAt: string;
}

/**
 * 시장 전체 외국인 5일 순매수.
 * 1순위: 지수 시계열에 외국인 순매수 컬럼이 있으면 그대로 사용.
 * 2순위: 업로드된 개별 종목 수급을 최근 5거래일 기준으로 합산한다.
 *        (지수 데이터에는 보통 수급 컬럼이 없으므로 이 경로가 실사용 기본값이다.)
 */
export function computeMarketForeignNet5d(
  ds: MarketDataset,
  benchmarkBars: DailyPrice[],
): number | null {
  const last5 = benchmarkBars.slice(-5);
  if (last5.length > 0 && last5.every((b) => b.foreignNetBuyValue !== null)) {
    return last5.reduce((a, b) => a + (b.foreignNetBuyValue ?? 0), 0);
  }

  // 개별 종목 합산: 데이터가 있는 종목만 사용하고, 최근 5거래일에 해당하는 값만 더한다.
  const dates = last5.map((b) => b.tradeDate);
  const dateSet = new Set(dates);
  let sum = 0;
  let contributing = 0;
  for (const inst of ds.instruments) {
    const bars = ds.bars[inst.symbol] ?? [];
    if (bars.length === 0) continue;
    const window = dateSet.size > 0 ? bars.filter((b) => dateSet.has(b.tradeDate)) : bars.slice(-5);
    const flows = window
      .map((b) => b.foreignNetBuyValue)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (flows.length === 0) continue;
    sum += flows.reduce((a, v) => a + v, 0);
    contributing++;
  }
  return contributing > 0 ? sum : null;
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

export function runAnalysis(
  ds: MarketDataset,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
): AnalysisResult {
  const kospi = indexSnapshot(ds, "KOSPI");
  const kosdaq = indexSnapshot(ds, "KOSDAQ") ?? kospi;
  if (!kospi || !kosdaq) throw new Error("시장 지수(KOSPI/KOSDAQ) 시계열이 없어 분석할 수 없습니다.");

  const vkospi = ds.capabilities.volatilityIndex
    ? (ds.vkospiSeries[ds.vkospiSeries.length - 1] ?? null)
    : null;

  const kospiBars = indexOf(ds, "KOSPI")!.bars;
  const marketForeignNet5d = computeMarketForeignNet5d(ds, kospiBars);

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

    const vf = inst.instrumentType === "STOCK" ? vfStockScore(snap, cfg) : null;
    // 주식 기술점수·상세·등급·순위는 백테스트와 같은 7개 피처를 사용한다.
    const tech = vf ?? technicalScore(snap, valuePct, cfg);
    const prio = priorityScore(inst, snap, financials, last.marketCap, bench.dayReturn, cfg);
    const vfNormalized = vf ? normalize(vf) : null;
    const modelGrade =
      inst.instrumentType === "STOCK" ? vfGrade(vfNormalized) : technicalGrade(tech.points, cfg);
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
      cfg.universe,
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
      vf,
      quality,
      technicalNormalized,
      priorityNormalized,
      qualityScore,
      marketSectorScore: null,
      totalScoreNormalized: inst.instrumentType === "STOCK" ? (vfNormalized ?? 0) : 0,
      dataCompletenessRatio:
        inst.instrumentType === "STOCK" && vf && vf.maxPoints > 0
          ? vf.availableMaxPoints / vf.maxPoints
          : 0,
      grade: modelGrade,
      actionLabelText: actionLabel(modelGrade, gate.status),
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
    let dataCompletenessRatio: number;
    if (row.instrument.instrumentType === "STOCK" && row.vf) {
      row.totalScoreNormalized = normalize(row.vf) ?? 0;
      dataCompletenessRatio =
        row.vf.maxPoints > 0 ? row.vf.availableMaxPoints / row.vf.maxPoints : 0;
    } else {
      const { total, dataCompletenessRatio: legacyCompleteness } = totalScore({
        technicalNormalized: row.technicalNormalized,
        priorityNormalized: row.priorityNormalized,
        qualityScore: row.qualityScore,
        marketSectorScore: row.marketSectorScore,
        weights: cfg.weights.etf,
      });
      row.totalScoreNormalized = total;
      dataCompletenessRatio = legacyCompleteness;
    }
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
    scoringConfig: cfg,
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
    sectorRotation: computeSectorRotation(ds, {
      representativeEtf: buildRepresentativeEtf(ds),
      weights: cfg.rotation,
    }),
    tradeDates: ds.tradeDates,
    calculatedAt: new Date().toISOString(),
  };
}

export function getRow(ds: MarketDataset, symbol: string): ScreeningRow | undefined {
  return runAnalysis(ds).rows.find((r) => r.instrument.symbol === symbol);
}

export function scoreHistory(
  ds: MarketDataset,
  symbol: string,
  days = 60,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
) {
  const bars = ds.bars[symbol] ?? [];
  const inst = ds.instruments.find((i) => i.symbol === symbol);
  if (!inst || bars.length === 0) return [];
  const out: Array<{ tradeDate: string; technicalPoints: number; grade: TechnicalGrade }> = [];
  for (let i = Math.max(120, bars.length - days); i < bars.length; i++) {
    const snap = computeIndicators(bars, i);
    const t = inst.instrumentType === "STOCK"
      ? vfStockScore(snap, cfg)
      : technicalScore(snap, 75, cfg);
    out.push({
      tradeDate: bars[i]!.tradeDate,
      technicalPoints: t.points,
      grade: inst.instrumentType === "STOCK"
        ? vfGrade(normalize(t))
        : technicalGrade(t.points, cfg),
    });
  }
  return out;
}

export function chartSeries(
  ds: MarketDataset,
  symbol: string,
  days = Infinity,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
) {
  const bars = ds.bars[symbol] ?? [];
  const isStock = ds.instruments.some((inst) => inst.symbol === symbol && inst.instrumentType === "STOCK");
  const closes = bars.map((b) => b.close);
  const out = [];
  for (let i = Math.max(0, bars.length - days); i < bars.length; i++) {
    const snap = computeIndicators(bars, i);
    const ich = snap.ichimoku;
    const technical = isStock ? historicalTechnicalScore(snap, cfg) : null;
    const top = ich.cloudTop;
    const bottom = ich.cloudBottom;
    // 표시 구름의 선행스팬1(=(전환+기준)/2, 26일 전 산출)이 선행스팬2 위면 양운
    const srcIndex = i - 26;
    let bullish: boolean | null = null;
    if (srcIndex >= 0) {
      const src = ichimoku(bars, srcIndex);
      if (src.tenkan !== null && src.kijun !== null && src.futureSenkouB !== null) {
        bullish = (src.tenkan + src.kijun) / 2 >= src.futureSenkouB;
      }
    }
    const band: [number, number] | null = top !== null && bottom !== null ? [bottom, top] : null;
    out.push({
      tradeDate: bars[i]!.tradeDate,
      close: bars[i]!.close,
      high: bars[i]!.high,
      low: bars[i]!.low,
      open: bars[i]!.open,
      volume: bars[i]!.volume,
      historicalTechnicalPoints: technical?.points ?? null,
      historicalTechnical: technical,
      ma5: sma(closes, 5, i),
      ma20: sma(closes, 20, i),
      ma60: sma(closes, 60, i),
      ma120: sma(closes, 120, i),
      bbUpper: snap.bollinger.bb?.upper ?? null,
      bbLower: snap.bollinger.bb?.lower ?? null,
      bbBand:
        snap.bollinger.bb ? ([snap.bollinger.bb.lower, snap.bollinger.bb.upper] as [number, number]) : null,
      cloudTop: top,
      cloudBottom: bottom,
      tenkan: ich.tenkan,
      kijun: ich.kijun,
      bullCloud: bullish === true ? band : null,
      bearCloud: bullish === false ? band : null,
    });
  }
  return out;
}

