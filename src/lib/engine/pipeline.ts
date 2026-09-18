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
  strictRawTechnicalScore,
  technicalGrade,
  technicalScore,
  totalScore,
  v8FinalStockScore,
  vfGrade,
  type MarketGate,
  type ScoreBlock,
  type ScoringConfig,
  type TechnicalGrade,
} from "./scoring";
import { computeSectorRotation, type SectorRotationResult } from "./sectorRotation";
import { buildPriorityScoreV8 } from "./priorityScoreV8";
import { computeV8SectorPriceLeadership } from "./v8SectorPriceLeadership";
import {
  getKosdaqOperationalExitSignal,
  VF_DOWNSIDE_EXIT_RAW_SCORE,
  VF_ENTRY_RAW_SCORE,
  VF_UPSIDE_EXIT_RAW_SCORE,
  selectV8SectorPriceLeadership,
} from "./vfConfig";
import type { DatasetCapabilities, MarketDataset } from "./dataset";
import type { DailyPrice, EtfFacts, FinancialFacts, IndexSeries, Instrument } from "./types";

const NON_SECTOR_ETF =
  /채권|국고채|CD\s?금리|단기자금|머니마켓|MMF|금현물|달러|원유|커버드콜|미국|나스닥|S&P|필라델피아|글로벌|차이나|중국|일본|인도|베트남|유로|선진국|신흥국|리츠|TDF|배당성장|밸류업|레버리지|인버스|200TR|코스피|코스닥/i;

function buildRepresentativeEtf(ds: MarketDataset): Map<string, { symbol: string; name: string }> {
  const bestEtf = new Map<string, { symbol: string; name: string; value: number }>();
  const bestStock = new Map<string, { symbol: string; name: string; value: number }>();
  for (const inst of ds.instruments) {
    const bars = ds.bars[inst.symbol] ?? [];
    if (bars.length === 0) continue;
    if (inst.sectorCode === "MARKET_IDX" || inst.sectorCode === "ETC") continue;
    if (inst.instrumentType === "ETF") {
      if (inst.isLeveraged || inst.isInverse || NON_SECTOR_ETF.test(inst.name)) continue;
      const recent = bars.slice(-20);
      const value =
        recent.reduce((sum, bar) => sum + bar.tradingValue, 0) / Math.max(1, recent.length);
      const current = bestEtf.get(inst.sectorCode);
      if (!current || value > current.value)
        bestEtf.set(inst.sectorCode, { symbol: inst.symbol, name: inst.name, value });
      continue;
    }
    if (inst.isPreferredStock) continue;
    const last = bars[bars.length - 1]!;
    const value =
      last.marketCap !== null && Number.isFinite(last.marketCap)
        ? last.marketCap
        : last.tradingValue;
    if (!Number.isFinite(value)) continue;
    const current = bestStock.get(inst.sectorCode);
    if (!current || value > current.value)
      bestStock.set(inst.sectorCode, { symbol: inst.symbol, name: inst.name, value });
  }
  const out = new Map<string, { symbol: string; name: string }>();
  for (const [code, value] of bestStock) out.set(code, { symbol: value.symbol, name: value.name });
  for (const [code, value] of bestEtf) out.set(code, { symbol: value.symbol, name: value.name });
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

export type V8ExitSignal = "UP90" | "DOWN30" | "UP95" | "DOWN25" | null;

export interface ScreeningRow {
  instrument: Instrument;
  snapshot: IndicatorSnapshot;
  technical: ScoreBlock;
  priority: ScoreBlock;
  /** V8 Final 10-point technical score for stocks. */
  vf: ScoreBlock | null;
  quality: ScoreBlock;
  technicalNormalized: number | null;
  priorityNormalized: number | null;
  qualityScore: number | null;
  marketSectorScore: number | null;
  totalScoreNormalized: number;
  scoreDelta1d: number | null;
  dataCompletenessRatio: number;
  grade: TechnicalGrade;
  /** Display-only label. Trading logic uses structural signal fields only. */
  actionLabelText: string;
  /** Strict raw 0~10 score. null when any core feature is unavailable. */
  operatingScore10: number | null;
  kosdaq80Onset: boolean;
  /** KOSPI stock crossing from below 8.0 to 8.0 or above; informational, not a portfolio entry signal. */
  kospiEightPointEntry: boolean;
  exitSignal: V8ExitSignal;
  sectorPriceLeadership: number | null;
  sectorPriceLeadershipSource: "ETF" | "STOCK" | null;
  sectorPriceLeadershipThreshold: number | null;
  sectorRotationScore: number | null;
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
  sectorRotation: SectorRotationResult | null;
  tradeDates: string[];
  calculatedAt: string;
}

export function computeMarketForeignNet5d(
  ds: MarketDataset,
  benchmarkBars: DailyPrice[],
): number | null {
  const last5 = benchmarkBars.slice(-5);
  if (last5.length > 0 && last5.every((bar) => bar.foreignNetBuyValue !== null))
    return last5.reduce((sum, bar) => sum + (bar.foreignNetBuyValue ?? 0), 0);
  const dates = new Set(last5.map((bar) => bar.tradeDate));
  let sum = 0;
  let contributing = 0;
  for (const inst of ds.instruments) {
    const bars = ds.bars[inst.symbol] ?? [];
    if (bars.length === 0) continue;
    const window = dates.size > 0 ? bars.filter((bar) => dates.has(bar.tradeDate)) : bars.slice(-5);
    const flows = window
      .map((bar) => bar.foreignNetBuyValue)
      .filter((value): value is number => value !== null && Number.isFinite(value));
    if (flows.length === 0) continue;
    sum += flows.reduce((total, value) => total + value, 0);
    contributing++;
  }
  return contributing > 0 ? sum : null;
}

function indexOf(ds: MarketDataset, code: string): IndexSeries | undefined {
  return ds.indexSeries.find((series) => series.indexCode === code);
}

function indexSnapshot(ds: MarketDataset, code: string, offset = 0): IndicatorSnapshot | null {
  const series = indexOf(ds, code);
  if (!series) return null;
  return computeIndicators(series.bars, series.bars.length - 1 - offset);
}

function sectorSnapshotScores(ds: MarketDataset, rows: ScreeningRow[]): SectorScore[] {
  const kospi = indexOf(ds, "KOSPI");
  if (!kospi) return [];
  const kospiCloses = kospi.bars.map((bar) => bar.close);
  const lastIndex = kospi.bars.length - 1;
  const marketReturn20 = periodReturn(kospiCloses, lastIndex, 20) ?? 0;
  const marketReturn60 = periodReturn(kospiCloses, lastIndex, 60) ?? 0;
  const marketReturn20Prev = periodReturn(kospiCloses, lastIndex - 5, 20) ?? 0;
  const median = (values: number[]): number | null => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };
  const memberReturn = (symbols: string[], period: number, offset: number): number | null =>
    median(
      symbols
        .map((symbol) => {
          const bars = ds.bars[symbol] ?? [];
          if (!bars.length) return null;
          const closes = bars.map((bar) => bar.close);
          return periodReturn(closes, closes.length - 1 - offset, period);
        })
        .filter((value): value is number => value !== null),
    );

  const raw = ds.sectors.map((sector) => {
    const series = indexOf(ds, `KRX_${sector.code}`);
    const isSynthetic = !series;
    const closes = series ? series.bars.map((bar) => bar.close) : [];
    const li = closes.length - 1;
    const memberSymbols = rows
      .filter(
        (row) =>
          row.instrument.sectorCode === sector.code && row.instrument.instrumentType === "STOCK",
      )
      .map((row) => row.instrument.symbol);
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
    const members = rows.filter((row) => row.instrument.sectorCode === sector.code);
    const aligned = members.filter((member) => member.snapshot.maAligned === true).length;
    const nearHigh = members.filter(
      (member) => (member.snapshot.distanceFrom52wHigh ?? -100) >= -10,
    ).length;
    const advancing = members.filter((member) => (member.snapshot.dayReturn ?? 0) > 0).length;
    const total = Math.max(1, members.length);
    const majority = (predicate: (member: ScreeningRow) => boolean | null): boolean | null => {
      const valid = members.map(predicate).filter((value): value is boolean => value !== null);
      if (!valid.length) return null;
      return valid.filter(Boolean).length / valid.length > 0.5;
    };
    return {
      sectorCode: sector.code,
      sectorName: sector.name,
      rs20: (r20 - marketReturn20) * 100,
      rs60: (r60 - marketReturn60) * 100,
      rs20prev: (r20prev - marketReturn20Prev) * 100,
      aboveMa20:
        snap && snap.ma20 !== null
          ? snap.close > snap.ma20
          : majority((member) =>
              member.snapshot.ma20 !== null ? member.snapshot.close > member.snapshot.ma20 : null,
            ),
      aboveMa60:
        snap && snap.ma60 !== null
          ? snap.close > snap.ma60
          : majority((member) =>
              member.snapshot.ma60 !== null ? member.snapshot.close > member.snapshot.ma60 : null,
            ),
      aboveCloud:
        snap && snap.ichimoku.cloudTop !== null
          ? snap.close > snap.ichimoku.cloudTop
          : majority((member) =>
              member.snapshot.ichimoku.cloudTop !== null
                ? member.snapshot.close > member.snapshot.ichimoku.cloudTop
                : null,
            ),
      breadthMaAligned: (aligned / total) * 100,
      breadthNearHigh: (nearHigh / total) * 100,
      breadthAdvancing: (advancing / total) * 100,
      isSynthetic,
      gradeACount: members.filter((member) => member.grade === "A").length,
      gradeBCount: members.filter((member) => member.grade === "B").length,
      representativeEtf:
        members.find((member) => member.instrument.instrumentType === "ETF")?.instrument.name ??
        null,
    };
  });
  const rs20Sorted = raw.map((row) => row.rs20).sort((a, b) => a - b);
  const rs60Sorted = raw.map((row) => row.rs60).sort((a, b) => a - b);
  const scored = raw.map((row) => {
    const trendFlags = [row.aboveMa20, row.aboveMa60, row.aboveCloud];
    const trendMet = trendFlags.filter((flag) => flag === true).length;
    const trendScore = (trendMet / 3) * 20;
    const breadth =
      ((row.breadthMaAligned + row.breadthNearHigh + row.breadthAdvancing) / 300) * 20;
    return {
      ...row,
      score:
        (percentile(rs20Sorted, row.rs20) / 100) * 35 +
        (percentile(rs60Sorted, row.rs60) / 100) * 25 +
        trendScore +
        breadth,
    };
  });
  const byScore = [...scored].sort((a, b) => b.score - a.score);
  const prevByRs = [...scored].sort((a, b) => b.rs20prev - a.rs20prev);
  return byScore.map((row, index) => ({
    sectorCode: row.sectorCode,
    sectorName: row.sectorName,
    rs20: row.rs20,
    rs60: row.rs60,
    aboveMa20: row.aboveMa20,
    aboveMa60: row.aboveMa60,
    aboveCloud: row.aboveCloud,
    breadthMaAligned: row.breadthMaAligned,
    breadthNearHigh: row.breadthNearHigh,
    breadthAdvancing: row.breadthAdvancing,
    score: row.score,
    rank: index + 1,
    prevRank: prevByRs.findIndex((previous) => previous.sectorCode === row.sectorCode) + 1,
    isSynthetic: row.isSynthetic,
    gradeACount: row.gradeACount,
    gradeBCount: row.gradeBCount,
    representativeEtf: row.representativeEtf,
  }));
}

function displayActionLabel(
  kosdaq80Onset: boolean,
  kospiEightPointEntry: boolean,
  exitSignal: V8ExitSignal,
  grade: TechnicalGrade,
  gate: MarketGate["status"],
) {
  if (kosdaq80Onset && exitSignal) return "KOSDAQ80 Onset · V8 Exit 조건";
  if (kosdaq80Onset) return "KOSDAQ80 Onset";
  if (kospiEightPointEntry && exitSignal) return "8점 신규 진입 후보 · V8 Exit 조건";
  if (kospiEightPointEntry) return "8점 신규 진입 후보";
  if (exitSignal === "UP90") return "KOSDAQ Exit · 9.0점 상향 재돌파";
  if (exitSignal === "DOWN30") return "KOSDAQ Exit · 3.0점 하향 이탈";
  if (exitSignal === "UP95") return "V8 Exit · 9.5점 이상";
  if (exitSignal === "DOWN25") return "V8 Exit · 2.5점 이하";
  return actionLabel(grade, gate);
}

export function runAnalysis(
  ds: MarketDataset,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
): AnalysisResult {
  const kospi = indexSnapshot(ds, "KOSPI");
  const kosdaq = indexSnapshot(ds, "KOSDAQ") ?? kospi;
  if (!kospi || !kosdaq)
    throw new Error("시장 지수(KOSPI/KOSDAQ) 시계열이 없어 분석할 수 없습니다.");

  const vkospi = ds.capabilities.volatilityIndex
    ? (ds.vkospiSeries[ds.vkospiSeries.length - 1] ?? null)
    : null;
  const kospiBars = indexOf(ds, "KOSPI")!.bars;
  const marketForeignNet5d = computeMarketForeignNet5d(ds, kospiBars);
  const gate = evaluateMarketGate({ benchmark: kospi, vkospi, marketForeignNet5d });
  const availability = { marketCap: ds.capabilities.marketCap, etfFacts: ds.capabilities.etfFacts };

  const sectorRotation = computeSectorRotation(ds, {
    representativeEtf: buildRepresentativeEtf(ds),
    weights: cfg.rotation,
  });
  const rotationScoreBySector = new Map(
    (sectorRotation?.sectors ?? []).map(
      (sector) => [sector.sectorCode, sector.rotationScore] as const,
    ),
  );
  const stockSectorPriceLeadership = computeV8SectorPriceLeadership(ds, 0, "STOCK");
  const previousStockSectorPriceLeadership = computeV8SectorPriceLeadership(ds, 1, "STOCK");
  const etfSectorPriceLeadership = computeV8SectorPriceLeadership(ds, 0, "ETF");
  const previousEtfSectorPriceLeadership = computeV8SectorPriceLeadership(ds, 1, "ETF");

  const groups = new Map<string, number[]>();
  const prepared = ds.instruments
    .map((inst) => {
      const bars = ds.bars[inst.symbol] ?? [];
      if (!bars.length) return null;
      const snap = computeIndicators(bars, bars.length - 1);
      const previousSnap = bars.length > 1 ? computeIndicators(bars, bars.length - 2) : null;
      const values = groups.get(inst.market) ?? [];
      values.push(bars[bars.length - 1]!.tradingValue);
      groups.set(inst.market, values);
      return { inst, bars, snap, previousSnap };
    })
    .filter(
      (
        prepared,
      ): prepared is {
        inst: Instrument;
        bars: DailyPrice[];
        snap: IndicatorSnapshot;
        previousSnap: IndicatorSnapshot | null;
      } => prepared !== null,
    );
  for (const [market, values] of groups)
    groups.set(
      market,
      values.sort((a, b) => a - b),
    );

  const rows: ScreeningRow[] = prepared.map(({ inst, bars, snap, previousSnap }) => {
    const last = bars[bars.length - 1]!;
    const financials = ds.financials[inst.symbol];
    const etf = ds.etfFacts[inst.symbol];
    const valuePct = percentile(groups.get(inst.market) ?? [], last.tradingValue);
    const benchmarkCode = inst.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
    const benchmarkFallback = inst.instrumentType === "ETF" && !etf?.underlyingIndex;
    const benchmark = benchmarkCode === "KOSDAQ" ? kosdaq : kospi;
    const benchmarkSeries = indexOf(ds, benchmarkCode) ?? indexOf(ds, "KOSPI")!;
    const benchmarkCloses = benchmarkSeries.bars.map((bar) => bar.close);
    const benchmarkIndex = benchmarkCloses.length - 1;
    const benchmarkR20 = periodReturn(benchmarkCloses, benchmarkIndex, 20);
    const benchmarkR60 = periodReturn(benchmarkCloses, benchmarkIndex, 60);
    const currentPlSelection = selectV8SectorPriceLeadership(
      inst.market,
      etfSectorPriceLeadership.get(inst.sectorCode),
      stockSectorPriceLeadership.get(inst.sectorCode),
    );
    const previousPlSelection = selectV8SectorPriceLeadership(
      inst.market,
      previousEtfSectorPriceLeadership.get(inst.sectorCode),
      previousStockSectorPriceLeadership.get(inst.sectorCode),
    );
    const currentPl = currentPlSelection.value;
    const previousPl = previousPlSelection.value;

    const vf =
      inst.instrumentType === "STOCK"
        ? v8FinalStockScore(snap, cfg, {
            sectorPriceLeadership: currentPl,
            sectorPriceLeadershipThreshold: currentPlSelection.threshold,
            sectorPriceLeadershipSource: currentPlSelection.source,
            sectorPriceLeadershipMissingEarnsSlot: false,
          })
        : null;
    const previousVf =
      inst.instrumentType === "STOCK" && previousSnap
        ? v8FinalStockScore(previousSnap, cfg, {
            sectorPriceLeadership: previousPl,
            sectorPriceLeadershipThreshold: previousPlSelection.threshold,
            sectorPriceLeadershipSource: previousPlSelection.source,
            sectorPriceLeadershipMissingEarnsSlot: false,
          })
        : null;
    const operatingScore10 = vf ? strictRawTechnicalScore(vf) : null;
    const previousOperatingScore10 = previousVf ? strictRawTechnicalScore(previousVf) : null;
    const stockPercent = operatingScore10 === null ? null : operatingScore10 * 10;
    const tech = vf ?? technicalScore(snap, valuePct, cfg);
    const legacyPriority = priorityScore(
      inst,
      snap,
      financials,
      last.marketCap,
      benchmark.dayReturn,
      cfg,
    );
    const rotationScore = rotationScoreBySector.get(inst.sectorCode) ?? null;
    const priority = buildPriorityScoreV8(
      legacyPriority,
      rotationScore,
      inst.instrumentType === "STOCK"
        ? {
            shortSellingVolumeRate20dChangePp: snap.shortSellingVolumeRate20dChangePp ?? null,
            lendingBalanceQuantity20dChange: snap.lendingBalanceQuantity20dChange ?? null,
          }
        : null,
    );
    const modelGrade =
      inst.instrumentType === "STOCK" ? vfGrade(stockPercent) : technicalGrade(tech.points, cfg);
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
    const prior20 = bars.slice(Math.max(0, bars.length - 21), bars.length - 1);
    const tradedDays = prior20.filter((bar) => bar.volume > 0).length;
    if (prior20.length >= 20 && tradedDays < 10) {
      universe.failedRules.push(`직전 20거래일 중 거래일 ${tradedDays}일 (유동성 부족)`);
      universe.passed = false;
    }

    const crossedEightPointThreshold =
      inst.instrumentType === "STOCK" &&
      universe.passed &&
      previousOperatingScore10 !== null &&
      operatingScore10 !== null &&
      previousOperatingScore10 < VF_ENTRY_RAW_SCORE &&
      operatingScore10 >= VF_ENTRY_RAW_SCORE;
    const kosdaq80Onset = crossedEightPointThreshold && inst.market === "KOSDAQ";
    const kospiEightPointEntry = crossedEightPointThreshold && inst.market === "KOSPI";
    const exitSignal: V8ExitSignal =
      inst.market === "KOSDAQ"
        ? getKosdaqOperationalExitSignal(previousOperatingScore10, operatingScore10, kosdaq80Onset)
        : operatingScore10 === null
          ? null
          : operatingScore10 >= VF_UPSIDE_EXIT_RAW_SCORE
            ? "UP95"
            : operatingScore10 <= VF_DOWNSIDE_EXIT_RAW_SCORE
              ? "DOWN25"
              : null;
    const technicalNormalized = inst.instrumentType === "STOCK" ? stockPercent : normalize(tech);
    const priorityNormalized = normalize(priority);
    const qualityScore =
      quality.availableMaxPoints === 0 ? null : (quality.points / quality.availableMaxPoints) * 100;
    const dataCompletenessRatio =
      inst.instrumentType === "STOCK" && vf && vf.maxPoints > 0
        ? vf.availableMaxPoints / vf.maxPoints
        : 0;

    return {
      instrument: inst,
      snapshot: snap,
      technical: tech,
      priority,
      vf,
      quality,
      technicalNormalized,
      priorityNormalized,
      qualityScore,
      marketSectorScore: null,
      totalScoreNormalized: inst.instrumentType === "STOCK" ? (stockPercent ?? 0) : 0,
      scoreDelta1d:
        operatingScore10 !== null && previousOperatingScore10 !== null
          ? Math.round((operatingScore10 - previousOperatingScore10) * 10_000) / 1_000
          : null,
      dataCompletenessRatio,
      grade: modelGrade,
      actionLabelText: displayActionLabel(
        kosdaq80Onset,
        kospiEightPointEntry,
        exitSignal,
        modelGrade,
        gate.status,
      ),
      operatingScore10,
      kosdaq80Onset,
      kospiEightPointEntry,
      exitSignal,
      sectorPriceLeadership: currentPl,
      sectorPriceLeadershipSource: currentPlSelection.source,
      sectorPriceLeadershipThreshold: currentPlSelection.threshold,
      sectorRotationScore: rotationScore,
      warnings: [],
      failedRules: universe.failedRules,
      skippedRules: universe.skippedRules,
      hardFilterPassed: universe.passed,
      financials,
      etf,
      marketCap: last.marketCap,
      benchmarkCode,
      benchmarkFallback,
      rs20:
        snap.return20 !== null && benchmarkR20 !== null
          ? (snap.return20 - benchmarkR20) * 100
          : null,
      rs60:
        snap.return60 !== null && benchmarkR60 !== null
          ? (snap.return60 - benchmarkR60) * 100
          : null,
    };
  });

  const sectors = sectorSnapshotScores(ds, rows);
  const sectorByCode = new Map(sectors.map((sector) => [sector.sectorCode, sector]));
  for (const row of rows) {
    const sector = sectorByCode.get(row.instrument.sectorCode);
    row.marketSectorScore = ds.capabilities.sectors && sector ? sector.score : null;
    if (row.instrument.instrumentType === "STOCK" && row.vf) {
      row.totalScoreNormalized = row.operatingScore10 === null ? 0 : row.operatingScore10 * 10;
      row.dataCompletenessRatio =
        row.vf.maxPoints > 0 ? row.vf.availableMaxPoints / row.vf.maxPoints : 0;
    } else {
      const result = totalScore({
        technicalNormalized: row.technicalNormalized,
        priorityNormalized: row.priorityNormalized,
        qualityScore: row.qualityScore,
        marketSectorScore: row.marketSectorScore,
        weights: cfg.weights.etf,
      });
      row.totalScoreNormalized = result.total;
      row.dataCompletenessRatio = result.dataCompletenessRatio;
    }
    row.warnings = collectWarnings({
      snap: row.snapshot,
      gate,
      etf: row.etf,
      inst: row.instrument,
      dataCompletenessRatio: row.dataCompletenessRatio,
      vkospi,
      exitSignal: row.exitSignal !== null,
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
    sectorRotation,
    tradeDates: ds.tradeDates,
    calculatedAt: new Date().toISOString(),
  };
}

export function getRow(ds: MarketDataset, symbol: string): ScreeningRow | undefined {
  return runAnalysis(ds).rows.find((row) => row.instrument.symbol === symbol);
}

export function scoreHistory(
  ds: MarketDataset,
  symbol: string,
  days = 60,
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
) {
  const bars = ds.bars[symbol] ?? [];
  const inst = ds.instruments.find((instrument) => instrument.symbol === symbol);
  if (!inst || !bars.length) return [];
  const out: Array<{ tradeDate: string; technicalPoints: number | null; grade: TechnicalGrade }> =
    [];
  for (let i = Math.max(0, bars.length - days); i < bars.length; i++) {
    const score = historicalTechnicalScore(computeIndicators(bars, i), cfg);
    out.push({
      tradeDate: bars[i]!.tradeDate,
      technicalPoints: score.points,
      grade: vfGrade(score.points === null ? null : score.points * 10),
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
  const closes = bars.map((bar) => bar.close);
  const out = [];
  for (let i = Math.max(0, bars.length - days); i < bars.length; i++) {
    const snap = computeIndicators(bars, i);
    const ich = snap.ichimoku;
    const technical = historicalTechnicalScore(snap, cfg);
    const top = ich.cloudTop;
    const bottom = ich.cloudBottom;
    const srcIndex = i - 26;
    let bullish: boolean | null = null;
    if (srcIndex >= 0) {
      const src = ichimoku(bars, srcIndex);
      if (src.tenkan !== null && src.kijun !== null && src.futureSenkouB !== null)
        bullish = (src.tenkan + src.kijun) / 2 >= src.futureSenkouB;
    }
    const band: [number, number] | null = top !== null && bottom !== null ? [bottom, top] : null;
    out.push({
      tradeDate: bars[i]!.tradeDate,
      close: bars[i]!.close,
      high: bars[i]!.high,
      low: bars[i]!.low,
      open: bars[i]!.open,
      volume: bars[i]!.volume,
      historicalTechnicalPoints: technical.points,
      historicalTechnical: technical,
      ma5: sma(closes, 5, i),
      ma20: sma(closes, 20, i),
      ma60: sma(closes, 60, i),
      ma120: sma(closes, 120, i),
      bbUpper: snap.bollinger.bb?.upper ?? null,
      bbLower: snap.bollinger.bb?.lower ?? null,
      bbBand: snap.bollinger.bb
        ? ([snap.bollinger.bb.lower, snap.bollinger.bb.upper] as [number, number])
        : null,
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
