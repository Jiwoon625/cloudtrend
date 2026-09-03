// 직접 입력한 데이터로 브라우저에서 분석을 실행한다(외부 시세 API 호출 없음).
import { runBacktest, type BacktestParams } from "@/lib/engine/backtest";
import { chartSeries, runAnalysis, scoreHistory } from "@/lib/engine/pipeline";
import { getManualDataset, MANUAL_DATA_MISSING_MESSAGE } from "@/lib/manualDataStore";
import { getActiveScoringConfig } from "@/lib/scoringConfigStore";
import type {
  BacktestPayload,
  DataStatusPayload,
  DataSourceStatus,
  InstrumentDetailPayload,
  MarketAnalysisPayload,
} from "@/lib/market.functions";

const SOURCE: DataSourceStatus = { live: true, credentialsConfigured: true, fallbackReason: null };

function message(error: unknown): string {
  return error instanceof Error ? error.message : "입력한 시세 데이터를 분석할 수 없습니다.";
}

export function computeLocalAnalysis(): MarketAnalysisPayload {
  try {
    const parsed = getManualDataset();
    if (!parsed) return { analysis: null, source: null, error: MANUAL_DATA_MISSING_MESSAGE };
    return {
      analysis: runAnalysis(parsed.dataset, getActiveScoringConfig()),
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
  const analysis = runAnalysis(parsed.dataset, config);
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
    chart: row ? chartSeries(parsed.dataset, symbol) : [],
    history: row ? scoreHistory(parsed.dataset, symbol, 60, config) : [],
  };
}

export function computeLocalDataStatus(): DataStatusPayload {
  const parsed = getManualDataset();
  if (!parsed) throw new Error(MANUAL_DATA_MISSING_MESSAGE);
  const dataset = parsed.dataset;
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

/** 입력 데이터의 일봉으로 피처 영향도 백테스트를 실행한다. */
export function computeLocalBacktest(
  symbols: string[],
  params: BacktestParams,
  limit: number,
): BacktestPayload {
  const parsed = getManualDataset();
  if (!parsed) throw new Error(MANUAL_DATA_MISSING_MESSAGE);
  const dataset = parsed.dataset;
  const upper = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const pool = upper.length
    ? dataset.instruments.filter((i) => upper.includes(i.symbol))
    : [...dataset.instruments]
        .filter((i) => i.instrumentType === "STOCK")
        .sort(
          (a, b) =>
            (dataset.bars[b.symbol]?.at(-1)?.tradingValue ?? 0) -
            (dataset.bars[a.symbol]?.at(-1)?.tradingValue ?? 0),
        )
        .slice(0, Math.max(1, limit));

  const series = pool
    .map((i) => ({ symbol: i.symbol, name: i.name, bars: dataset.bars[i.symbol] ?? [] }))
    .filter((s) => s.bars.length > 0);

  const maxBars = series.reduce((m, s) => Math.max(m, s.bars.length), 0);
  return {
    result: runBacktest(series, params),
    universe: series.map((s) => ({ symbol: s.symbol, name: s.name, bars: s.bars.length })),
    extended: maxBars > 200,
    asOfDate: dataset.asOfDate,
    notes: [
      `직접 입력한 일봉(종목당 최대 ${maxBars}봉)으로 백테스트했습니다. 더 긴 기간을 원하면 주피터에서 더 많은 일봉을 조회해 붙여넣어 주세요.`,
      "지표 계산에 120봉이 필요하므로 관측 구간은 121번째 봉부터 시작합니다. 표본이 겹치는 중첩 관측이므로 t값은 참고용입니다.",
      "수수료·세금·슬리피지는 반영되지 않았습니다.",
    ],
  };
}
