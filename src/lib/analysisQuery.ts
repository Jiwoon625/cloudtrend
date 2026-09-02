import { queryOptions } from "@tanstack/react-query";

import { getActiveScoringConfig } from "@/lib/scoringConfigStore";
import {
  getDataStatus,
  getInstrumentDetail,
  getMarketAnalysis,
  getServerEgressIp,
  type AnalysisPayload,
} from "@/lib/market.functions";

/** HMR 이전 요청이나 실패한 RPC가 남긴 불완전 캐시를 분석 결과로 사용하지 않는다. */
export function isAnalysisPayload(value: unknown): value is AnalysisPayload {
  if (value === null || typeof value !== "object") return false;
  const analysis = (value as { analysis?: unknown }).analysis;
  if (analysis === null || typeof analysis !== "object") return false;
  return Array.isArray((analysis as { rows?: unknown }).rows);
}

export const analysisQueryOptions = queryOptions({
  // 실패한 자동 호출 캐시와 분리한다. 이 키는 대시보드의 명시적 실행에서만 채워진다.
  queryKey: ["market-analysis", "manual-v2"],
  queryFn: () => getMarketAnalysis({ data: { config: getActiveScoringConfig() } }),
  staleTime: 5 * 60 * 1000,
  retry: false,
});

export const dataStatusQueryOptions = queryOptions({
  queryKey: ["data-status"],
  queryFn: () => getDataStatus(),
  staleTime: 5 * 60 * 1000,
  retry: false,
});

export const instrumentQueryOptions = (symbol: string) =>
  queryOptions({
    queryKey: ["instrument", symbol],
    queryFn: () =>
      getInstrumentDetail({ data: { symbol, config: getActiveScoringConfig() } }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

export const ipQueryOptions = queryOptions({
  queryKey: ["server-egress-ip"],
  queryFn: () => getServerEgressIp(),
  staleTime: 60 * 1000,
});

