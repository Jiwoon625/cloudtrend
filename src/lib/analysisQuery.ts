import { queryOptions } from "@tanstack/react-query";

import { computeLocalDataStatus } from "@/lib/localAnalysis";
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

const V8_QUERY_VERSION = "manual-v8-final-10pt" as const;

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
  queryKey: ["market-analysis", V8_QUERY_VERSION, "screening-cache-v8-final-v1"],
  queryFn: () => getOrBuildScreeningPayload(),
  staleTime: 5 * 60 * 1000,
  retry: false,
});

export const dashboardQueryOptions = queryOptions({
  queryKey: ["market-analysis", V8_QUERY_VERSION, "dashboard-cache-v8-final-v1"],
  queryFn: () => getOrBuildDashboardSummary(),
  staleTime: 5 * 60 * 1000,
  retry: false,
});

export const dataStatusQueryOptions = queryOptions({
  queryKey: ["data-status", V8_QUERY_VERSION],
  queryFn: async () => {
    await ensureManualDataset();
    return computeLocalDataStatus();
  },
  staleTime: 5 * 60 * 1000,
  retry: false,
});

export const instrumentQueryOptions = (symbol: string) =>
  queryOptions({
    queryKey: ["instrument", V8_QUERY_VERSION, "instrument-cache-v8-final-v1", symbol],
    queryFn: () => getCachedInstrumentDetail(symbol),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

export const ipQueryOptions = queryOptions({
  queryKey: ["server-egress-ip"],
  queryFn: () => getServerEgressIp(),
  staleTime: 0,
  gcTime: 0,
});
