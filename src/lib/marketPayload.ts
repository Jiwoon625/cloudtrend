import type { AnalysisResult, ScreeningRow, chartSeries, scoreHistory } from "./engine/pipeline";
import type { dataStatusVolatility } from "./dataStatusPresentation";
import type { DriveResultPublication } from "./driveResultPublication";

export interface DataSourceStatus {
  drivePublication?: DriveResultPublication;
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

export interface DataStatusChecks {
  ohlcErrors: number;
  negativeVolume: number;
  duplicates: number;
  futureDates: number;
  afterAsOfDates?: number;
  insufficient: number;
  abnormalMoves: number;
}

export interface DataStatusCoverageRow {
  provider: string;
  kind: string;
  count: number;
  entities: number;
  ok: boolean;
  availableEntities?: number;
  asOfDate?: string;
}

export interface DataStatusBarCoverage {
  symbol: string;
  name: string;
  bars: number;
  first: string;
  last: string;
}

/**
 * Where the quality evidence behind a status payload was produced. A payload without the
 * publication-time dataset calculation carries `unavailable` instead of inventing counts.
 */
export interface DataStatusEvidence {
  version: "kr-data-status-evidence-v1";
  source: "DRIVE_PUBLICATION_DATA_STATUS" | "PUBLISHED_ANALYSIS" | "ACTIVE_SOURCE_CSV";
  asOfDate: string;
  phase?: "PRELIMINARY" | "FINAL";
  publicationId?: string;
  computedAt?: string;
  /** Payload sections this evidence source cannot establish. */
  unavailable?: string[];
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
  qualityDate?: string;
  qualityTimezone?: "Asia/Seoul";
  coverage: DataStatusCoverageRow[];
  /** Absent when the payload was built without the publication-time dataset calculation. */
  checks?: DataStatusChecks;
  barCoverage?: DataStatusBarCoverage[];
  evidence?: DataStatusEvidence;
}
