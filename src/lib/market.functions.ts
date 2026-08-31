// 시세 데이터 조회 서버 함수.
// 토스증권 Open API 키(TOSS_CLIENT_ID / TOSS_CLIENT_SECRET)가 설정되어 있으면 실데이터를,
// 없거나 조회 실패 시 합성(mock) 데이터로 폴백하고 그 사실을 응답에 담아 화면에 노출한다.
import { createServerFn } from "@tanstack/react-start";

import type { MarketDataset } from "@/lib/engine/dataset";
import { getMockDataset } from "@/lib/engine/mockProvider";
import {
  chartSeries,
  runAnalysis,
  scoreHistory,
  type AnalysisResult,
  type ScreeningRow,
} from "@/lib/engine/pipeline";

export interface DataSourceStatus {
  /** 실데이터 사용 여부 */
  live: boolean;
  /** 토스 API 키 설정 여부 */
  credentialsConfigured: boolean;
  /** 실데이터 조회 실패 시 원인 (mock 폴백 사유) */
  fallbackReason: string | null;
}

async function loadDataset(): Promise<{ dataset: MarketDataset; status: DataSourceStatus }> {
  const { buildTossDataset, hasTossCredentials } = await import("@/lib/engine/toss.server");
  const configured = hasTossCredentials();
  if (!configured) {
    return {
      dataset: getMockDataset(),
      status: {
        live: false,
        credentialsConfigured: false,
        fallbackReason:
          "토스증권 Open API 키(TOSS_CLIENT_ID / TOSS_CLIENT_SECRET)가 등록되지 않아 합성 데이터를 사용합니다.",
      },
    };
  }
  try {
    const dataset = await buildTossDataset();
    return {
      dataset,
      status: { live: true, credentialsConfigured: true, fallbackReason: null },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      dataset: getMockDataset(),
      status: {
        live: false,
        credentialsConfigured: true,
        fallbackReason: `토스증권 API 조회 실패로 합성 데이터로 대체했습니다: ${message}`,
      },
    };
  }
}

export interface AnalysisPayload {
  analysis: AnalysisResult;
  source: DataSourceStatus;
}

export const getMarketAnalysis = createServerFn({ method: "GET" }).handler(
  async (): Promise<AnalysisPayload> => {
    const { dataset, status } = await loadDataset();
    return { analysis: runAnalysis(dataset), source: status };
  },
);

export interface InstrumentDetailPayload {
  source: DataSourceStatus;
  asOfDate: string;
  dataProvider: string;
  dataVersion: string;
  strategyVersion: string;
  notes: string[];
  isLive: boolean;
  marketGateStatus: string;
  row: ScreeningRow | null;
  chart: ReturnType<typeof chartSeries>;
  history: ReturnType<typeof scoreHistory>;
}

export const getInstrumentDetail = createServerFn({ method: "GET" })
  .inputValidator((input: { symbol: string }) => ({ symbol: String(input.symbol).slice(0, 20) }))
  .handler(async ({ data }): Promise<InstrumentDetailPayload> => {
    const { dataset, status } = await loadDataset();
    const analysis = runAnalysis(dataset);
    const row = analysis.rows.find((r) => r.instrument.symbol === data.symbol) ?? null;
    return {
      source: status,
      asOfDate: analysis.asOfDate,
      dataProvider: analysis.dataProvider,
      dataVersion: analysis.dataVersion,
      strategyVersion: analysis.strategyVersion,
      notes: analysis.notes,
      isLive: analysis.isLive,
      marketGateStatus: analysis.marketGate.status,
      row,
      chart: row ? chartSeries(dataset, data.symbol) : [],
      history: row ? scoreHistory(dataset, data.symbol) : [],
    };
  });

export interface DataStatusPayload {
  source: DataSourceStatus;
  asOfDate: string;
  dataProvider: string;
  dataVersion: string;
  strategyVersion: string;
  isLive: boolean;
  notes: string[];
  capabilities: AnalysisResult["capabilities"];
  coverage: Array<{ provider: string; kind: string; count: number; entities: number; ok: boolean }>;
  checks: {
    ohlcErrors: number;
    negativeVolume: number;
    duplicates: number;
    futureDates: number;
    insufficient: number;
    abnormalMoves: number;
  };
  barCoverage: Array<{ symbol: string; name: string; bars: number; first: string; last: string }>;
}

export const getDataStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<DataStatusPayload> => {
    const { dataset, status } = await loadDataset();
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
        if (i > 0) {
          const chg = b.close / bars[i - 1]!.close - 1;
          if (Math.abs(chg) > 0.29) abnormalMoves++;
        }
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
    const etfCount = dataset.instruments.filter((i) => i.instrumentType === "ETF").length;
    const indexRecords = dataset.indexSeries.reduce((a, s) => a + s.bars.length, 0);

    return {
      source: status,
      asOfDate: dataset.asOfDate,
      dataProvider: dataset.provider,
      dataVersion: dataset.version,
      strategyVersion: runAnalysis(dataset).strategyVersion,
      isLive: dataset.isLive,
      notes: dataset.notes,
      capabilities: dataset.capabilities,
      coverage: [
        {
          provider: dataset.provider,
          kind: "종목 일봉",
          count: priceRecords,
          entities: dataset.instruments.length,
          ok: priceRecords > 0,
        },
        {
          provider: dataset.provider,
          kind: "지수 일봉",
          count: indexRecords,
          entities: dataset.indexSeries.length,
          ok: indexRecords > 0,
        },
        {
          provider: dataset.provider,
          kind: "재무 스냅샷",
          count: Object.keys(dataset.financials).length,
          entities: stockCount,
          ok: dataset.capabilities.fundamentals,
        },
        {
          provider: dataset.provider,
          kind: "ETF 상품 메타데이터",
          count: Object.keys(dataset.etfFacts).length,
          entities: etfCount,
          ok: dataset.capabilities.etfFacts,
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
          count: dataset.capabilities.investorFlow ? indexRecords : 0,
          entities: dataset.indexSeries.length,
          ok: dataset.capabilities.investorFlow,
        },
      ],
      checks: {
        ohlcErrors,
        negativeVolume,
        duplicates,
        futureDates,
        insufficient,
        abnormalMoves,
      },
      barCoverage,
    };
  },
);
