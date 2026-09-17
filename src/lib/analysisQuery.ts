import { queryOptions } from "@tanstack/react-query";

import { computeLocalDataStatus } from "@/lib/localAnalysis";
import { ensureManualDataset } from "@/lib/manualDataStore";
import type { ScoreBlock } from "@/lib/engine/scoring";
import {
  DASHBOARD_CACHE_VERSION,
  getCachedInstrumentDetail,
  INSTRUMENT_CACHE_VERSION,
  SCREENING_CACHE_VERSION,
} from "@/lib/screeningCache";
import {
  getOrBuildDashboardSummaryServerFirst,
  getOrBuildScreeningPayloadServerFirst,
} from "@/lib/webScreeningClient";
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

function withThreeDecimalClv(block: ScoreBlock, clv: number): ScoreBlock {
  return {
    ...block,
    rows: block.rows.map((row) => {
      if ((row.group !== "Vf Volume" && row.group !== "Volume") || !row.actual.includes("CLV "))
        return row;
      return {
        ...row,
        actual: row.actual.replace(/CLV\s+-?\d+(?:\.\d+)?/, `CLV ${clv.toFixed(3)}`),
      };
    }),
  };
}

export const analysisQueryOptions = queryOptions({
  queryKey: ["market-analysis", V8_QUERY_VERSION, SCREENING_CACHE_VERSION],
  queryFn: () => getOrBuildScreeningPayloadServerFirst(),
  staleTime: 5 * 60 * 1000,
  retry: false,
});

export const dashboardQueryOptions = queryOptions({
  queryKey: ["market-analysis", V8_QUERY_VERSION, DASHBOARD_CACHE_VERSION],
  queryFn: () => getOrBuildDashboardSummaryServerFirst(),
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
    queryKey: ["instrument", V8_QUERY_VERSION, INSTRUMENT_CACHE_VERSION, symbol],
    queryFn: async () => {
      const detail = await getCachedInstrumentDetail(symbol);
      const clv = detail.row?.snapshot.closeLocationValue;
      if (!detail.row || clv === null || clv === undefined || !Number.isFinite(clv)) return detail;
      return {
        ...detail,
        row: {
          ...detail.row,
          technical: withThreeDecimalClv(detail.row.technical, clv),
          vf: detail.row.vf ? withThreeDecimalClv(detail.row.vf, clv) : detail.row.vf,
        },
      };
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

export const ipQueryOptions = queryOptions({
  queryKey: ["server-egress-ip"],
  queryFn: () => getServerEgressIp(),
  staleTime: 0,
  gcTime: 0,
});
