import { queryOptions } from "@tanstack/react-query";

import {
  computeLocalDataStatus,
} from "@/lib/localAnalysis";
import { ensureManualDataset } from "@/lib/manualDataStore";
import {
  getCachedInstrumentDetail,
  getOrBuildDashboardSummary,
  getOrBuildScreeningPayload,
} from "@/lib/screeningCache";
import {
  getServerEgressIp,
  type AnalysisPayload,
  type AnalysisFailurePayload,
} from "@/lib/market.functions";

/** HMR 이전 요청이나 실패한 RPC가 남긴 불완전 캐시를 분석 결과로 사용하지 않는다. */
export function isAnalysisPayload(value: unknown): value is AnalysisPayload {
  if (value === null || typeof value !== "object") return false;
  const analysis = (value as { analysis?: unknown }).analysis;
  if (analysis === null || typeof analysis !== "object") return false;
  return Array.isArray((analysis as { rows?: unknown }).rows);
}

export function isAnalysisFailurePayload(value: unknown): value is AnalysisFailurePayload {
  if (value === null || typeof value !== "object") return false;
  return (
    (value as { analysis?: unknown }).analysis === null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

export const analysisQueryOptions = queryOptions({
  // Dashboard/Stock/ETF가 동일한 Supabase screening result cache를 공유한다.
  queryKey: ["market-analysis", "screening-cache-v1"],
  queryFn: () => getOrBuildScreeningPayload(),
  staleTime: 5 * 60 * 1000,
  retry: false,
});

export const dashboardQueryOptions = queryOptions({
  queryKey: ["dashboard-summary", "dashboard-cache-v1"],
  queryFn: () => getOrBuildDashboardSummary(),
  staleTime: 5 * 60 * 1000,
  retry: false,
});

export const dataStatusQueryOptions = queryOptions({
  queryKey: ["data-status", "manual-vf-9.5-intraday"],
  queryFn: async () => {
    await ensureManualDataset();
    return computeLocalDataStatus();
  },
  staleTime: 5 * 60 * 1000,
  retry: false,
});

export const instrumentQueryOptions = (symbol: string) =>
  queryOptions({
    queryKey: ["instrument", "lazy-cache-v1", symbol],
    queryFn: () => getCachedInstrumentDetail(symbol),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

export const ipQueryOptions = queryOptions({
  queryKey: ["server-egress-ip"],
  queryFn: () => getServerEgressIp(),
  // 실행 환경의 출구 IP는 언제든 바뀔 수 있으므로 항상 최신값을 다시 조회한다.
  staleTime: 0,
  gcTime: 0,
});
