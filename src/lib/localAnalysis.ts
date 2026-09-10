// 직접 입력한 데이터로 브라우저에서 분석을 실행한다(외부 시세 API 호출 없음).
import {
  runBacktest,
  type BacktestParams,
  type BacktestResult,
} from "@/lib/engine/backtestV4";
import { buildAlignedRankingAnalysis } from "@/lib/engine/backtestRankingV5";
import type { MarketDataset } from "@/lib/engine/dataset";
import { chartSeries, runAnalysis, scoreHistory } from "@/lib/engine/pipeline";
import {
  buildFullUniverseSectorDataset,
  computeFullUniverseSectorRotation,
} from "@/lib/engine/sectorRotationFullUniverse";
import { getManualDataset, MANUAL_DATA_MISSING_MESSAGE } from "@/lib/manualDataStore";
import { getActiveScoringConfig } from "@/lib/scoringConfigStore";
import type {
  DataStatusPayload,
  DataSourceStatus,
  InstrumentDetailPayload,
  MarketAnalysisPayload,
} from "@/lib/market.functions";

const SOURCE: DataSourceStatus = { live: true, credentialsConfigured: true, fallbackReason: null };

function message(error: unknown): string {
  return error instanceof Error ? error.message : "입력한 시세 데이터를 분석할 수 없습니다.";
}

/**
 * 섹터 탭은 스크리닝 실격 여부와 독립적으로 원본 데이터의 모든 주식을 사용한다.
 * runAnalysis 자체도 정규화된 데이터셋으로 실행해 스크리너/기존 RS 표/로테이션 표의 섹터가 서로 어긋나지 않게 한다.
 */
function runLocalMarketAnalysis(
  rawDataset: MarketDataset,
  config: ReturnType<typeof getActiveScoringConfig>,
) {
  const dataset = buildFullUniverseSectorDataset(rawDataset);
  const analysis = runAnalysis(dataset, config);

  const representativeEtf = new Map<string, { symbol: string; name: string }>();
  for (const sector of analysis.sectorRotation?.sectors ?? []) {
    if (sector.representativeEtfSymbol && sector.representativeEtf) {
      representativeEtf.set(sector.sectorCode, {
        symbol: sector.representativeEtfSymbol,
        name: sector.representativeEtf,
      });
    }
  }

  analysis.sectorRotation = computeFullUniverseSectorRotation(dataset, {
    representativeEtf,
    weights: config.rotation,
  });
  return { analysis, dataset };
}

export function computeLocalAnalysis(): MarketAnalysisPayload {
  try {
    const parsed = getManualDataset();
    if (!parsed) return { analysis: null, source: null, error: MANUAL_DATA_MISSING_MESSAGE };
    const { analysis } = runLocalMarketAnalysis(parsed.dataset, getActiveScoringConfig());
    return {
      analysis,
      source: SOURCE,
    };
  } catch (error) {
    return { analysis: null, source: null, error: message(error) };
  }
}

export function computeLocalInstrumentDetail(symbol: string): InstrumentDetailPayload {
  const parsed = getManualDataset();
  if (!parsed) throw new Error(MANUAL_DATA_MISSING_MESSAGE);
  const config = getActiveScoringConfig();
  const { analysis, dataset } = runLocalMarketAnalysis(parsed.dataset, config);
  const row = analysis.rows.find((r) => r.instrument.symbol === symbol) ?? null;
  return {
    source: SOURCE,
    asOfDate: analysis.asOfDate,
    dataProvider: analysis.dataProvider,
    dataVersion: analysis.dataVersion,
    strategyVersion: analysis.strategyVersion,
    notes: analysis.notes,
    isLive: analysis.isLive,
    marketGateStatus: analysis.marketGate.status,
    row,
    chart: row ? chartSeries(dataset, symbol, Infinity, config) : [],
    history: row ? scoreHistory(dataset, symbol, 60, config) : [],
  };
}

export function computeLocalDataStatus(): DataStatusPayload {
  const parsed = getManualDataset();
  if (!parsed) throw new Error(MANUAL_DATA_MISSING_MESSAGE);
  const dataset = buildFullUniverseSectorDataset(parsed.dataset);
  const today = dataset.asOfDate;

  let ohlcErrors = 0;
  let negativeVolume = 0;
  let duplicates = 0;
  let futureDates = 0;
  let insufficient = 0;
  let abnormalMoves = 0;
  let priceRecords = 0;
  const barCoverage: DataStatusPayload["barCoverage"] = [];

  for (const inst of dataset.instruments) {
    const bars = dataset.bars[inst.symbol] ?? [];
    priceRecords += bars.length;
    if (bars.length < 120) insufficient++;
    const seen = new Set<string>();
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!;
      if (
        b.high < b.low ||
        b.high < b.open ||
        b.high < b.close ||
        b.low > b.open ||
        b.low > b.close
      )
        ohlcErrors++;
      if (b.volume < 0) negativeVolume++;
      if (seen.has(b.tradeDate)) duplicates++;
      seen.add(b.tradeDate);
      if (b.tradeDate > today) futureDates++;
      if (i > 0 && Math.abs(b.close / bars[i - 1]!.close - 1) > 0.29) abnormalMoves++;
    }
    barCoverage.push({
      symbol: inst.symbol,
      name: inst.name,
      bars: bars.length,
      first: bars[0]?.tradeDate ?? "-",
      last: bars[bars.length - 1]?.tradeDate ?? "-",
    });
  }

  const stockCount = dataset.instruments.filter((i) => i.instrumentType === "STOCK").length;
  const etfCount = dataset.instruments.length - stockCount;
  const indexRecords = dataset.indexSeries.reduce((a, s) => a + s.bars.length, 0);

  return {
    source: SOURCE,
    asOfDate: dataset.asOfDate,
    dataProvider: dataset.provider,
    dataVersion: dataset.version,
    strategyVersion: runAnalysis(dataset, getActiveScoringConfig()).strategyVersion,
    isLive: dataset.isLive,
    notes: dataset.notes,
    capabilities: dataset.capabilities,
    coverage: [
      {
        provider: dataset.provider,
        kind: "종목 일봉(직접 입력)",
        count: priceRecords,
        entities: dataset.instruments.length,
        ok: priceRecords > 0,
      },
      {
        provider: dataset.provider,
        kind: "지수 일봉(직접 입력)",
        count: indexRecords,
        entities: dataset.indexSeries.length,
        ok: indexRecords > 0,
      },
      {
        provider: dataset.provider,
        kind: "시가총액",
        count: dataset.capabilities.marketCap ? dataset.instruments.length : 0,
        entities: dataset.instruments.length,
        ok: dataset.capabilities.marketCap,
      },
      {
        provider: dataset.provider,
        kind: "투자자별 순매수",
        count: dataset.capabilities.investorFlow ? priceRecords : 0,
        entities: dataset.instruments.length,
        ok: dataset.capabilities.investorFlow,
      },
      {
        provider: dataset.provider,
        kind: "ETF 상품 메타데이터",
        count: 0,
        entities: etfCount,
        ok: false,
      },
      {
        provider: dataset.provider,
        kind: "재무 스냅샷",
        count: 0,
        entities: stockCount,
        ok: false,
      },
    ],
    checks: { ohlcErrors, negativeVolume, duplicates, futureDates, insufficient, abnormalMoves },
    barCoverage,
  };
}

export interface LocalBacktestPayload {
  result: BacktestResult;
  universe: Array<{ symbol: string; name: string; bars: number; market: string }>;
  extended: boolean;
  asOfDate: string;
  notes: string[];
}

/** 입력 데이터의 일봉으로 V5 피처·랭킹 백테스트를 실행한다. */
export function computeLocalBacktest(
  symbols: string[],
  params: BacktestParams,
  limit: number,
  includeEtf = false,
  override?: MarketDataset | null,
): LocalBacktestPayload {
  let dataset: MarketDataset;
  if (override) {
    dataset = override;
  } else {
    const parsed = getManualDataset();
    if (!parsed) throw new Error(MANUAL_DATA_MISSING_MESSAGE);
    dataset = parsed.dataset;
  }
  const upper = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const pool = upper.length
    ? dataset.instruments.filter((i) => upper.includes(i.symbol))
    : [...dataset.instruments]
        .filter((i) => includeEtf || i.instrumentType === "STOCK")
        .sort(
          (a, b) =>
            (dataset.bars[b.symbol]?.at(-1)?.tradingValue ?? 0) -
            (dataset.bars[a.symbol]?.at(-1)?.tradingValue ?? 0),
        )
        .slice(0, Math.max(1, limit));

  const series = pool
    .map((i) => ({
      symbol: i.symbol,
      name: i.name,
      market: i.market === "KOSDAQ" ? ("KOSDAQ" as const) : ("KOSPI" as const),
      bars: dataset.bars[i.symbol] ?? [],
    }))
    .filter((s) => s.bars.length > 0);

  const maxBars = series.reduce((m, s) => Math.max(m, s.bars.length), 0);
  const marketContext = { indexSeries: dataset.indexSeries };
  const result = runBacktest(series, params, marketContext);

  // Rank IC / Top 5 / Quantile은 모든 종목이 같은 공통 5D 관측일에서 비교되도록 별도로 재계산한다.
  const alignedRanking = buildAlignedRankingAnalysis(series, params, marketContext);
  result.rankIcByDate = alignedRanking.rankIcByDate;
  result.rankIcSummary = alignedRanking.rankIcSummary;
  result.topSelection = alignedRanking.topSelection;
  result.quantileSpreads = alignedRanking.quantileSpreads;

  return {
    result,
    universe: series.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      bars: s.bars.length,
      market: s.market,
    })),
    extended: maxBars > 200,
    asOfDate: dataset.asOfDate,
    notes: [
      `CloudTrend Backtest V5 · 직접 입력 일봉(종목당 최대 ${maxBars}봉)으로 계산했습니다.`,
      "KOSPI 종목은 KOSPI, KOSDAQ 종목은 KOSDAQ 지수를 같은 날짜의 벤치마크로 사용합니다.",
      "기본 지표는 120봉 이후부터 관측하며, 52주 신고가 피처는 현재 봉 포함 252거래일이 확보된 시점부터만 계산합니다.",
      "피처별 Edge는 메인 관측 그리드에서 false→true로 전환된 Signal Onset만 신호로 집계하고, 복합점수는 기존 상태값을 그대로 사용합니다.",
      "Rank IC·Top 5·5/10분위는 KOSPI 거래일을 anchor로 한 공통 관측일에서, 전체 9.5점의 모든 항목이 계산 가능한 종목만 비교합니다.",
      "Top 5는 실제 비교 가능 종목이 5개 미만인 날짜를 집계하지 않으며, Ranking은 최소 50종목 이상인 날짜만 사용합니다.",
      `왕복 비용 ${Math.max(0, params.roundTripCostBps ?? 0)}bps를 수익률에서 차감합니다.`,
    ],
  };
}
