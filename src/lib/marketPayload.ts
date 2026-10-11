import type { AnalysisResult, ScreeningRow, chartSeries, scoreHistory } from "./engine/pipeline";
import type { dataStatusVolatility } from "./dataStatusPresentation";

export interface DataSourceStatus {
  /** 실데이터 사용 여부 */
  live: boolean;
  /** 입력 자료가 준비되었는지 여부. 기존 저장 결과와의 호환 필드. */
  credentialsConfigured: boolean;
  /** 실데이터 조회 실패 시 원인 (mock 폴백 사유) */
  fallbackReason: string | null;
}

export interface AnalysisPayload {
  analysis: AnalysisResult;
  source: DataSourceStatus;
}

export interface AnalysisFailurePayload {
  analysis: null;
  source: null;
  error: string;
}

export type MarketAnalysisPayload = AnalysisPayload | AnalysisFailurePayload;

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

export interface DataStatusPayload {
  source: DataSourceStatus;
  asOfDate: string;
  dataProvider: string;
  dataVersion: string;
  strategyVersion: string;
  isLive: boolean;
  notes: string[];
  capabilities: AnalysisResult["capabilities"];
  volatilityObservation?: ReturnType<typeof dataStatusVolatility>;
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
