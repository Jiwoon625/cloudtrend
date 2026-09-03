import { queryOptions } from "@tanstack/react-query";

import { runUsAnalysis, type UsAnalysisResult } from "@/lib/engine/usPipeline";
import { getUsDataset, US_DATA_MISSING_MESSAGE } from "@/lib/usDataStore";

export interface UsAnalysisPayload {
  analysis: UsAnalysisResult;
}

export interface UsAnalysisFailure {
  analysis: null;
  error: string;
}

export type UsAnalysisResponse = UsAnalysisPayload | UsAnalysisFailure;

export function isUsAnalysisPayload(value: unknown): value is UsAnalysisPayload {
  if (value === null || typeof value !== "object") return false;
  const analysis = (value as { analysis?: unknown }).analysis;
  if (analysis === null || typeof analysis !== "object") return false;
  return Array.isArray((analysis as { rows?: unknown }).rows);
}

export function isUsAnalysisFailure(value: unknown): value is UsAnalysisFailure {
  if (value === null || typeof value !== "object") return false;
  return (
    (value as { analysis?: unknown }).analysis === null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

/** 브라우저에 저장된 입력 데이터로만 계산한다. 외부 시세 API를 호출하지 않는다. */
export const usAnalysisQueryOptions = queryOptions<UsAnalysisResponse>({
  queryKey: ["us-analysis", "manual-v1"],
  queryFn: async () => {
    try {
      const parsed = getUsDataset();
      if (!parsed) return { analysis: null, error: US_DATA_MISSING_MESSAGE };
      return { analysis: runUsAnalysis(parsed.dataset) };
    } catch (error) {
      return {
        analysis: null,
        error: error instanceof Error ? error.message : "입력한 미국 시세를 분석할 수 없습니다.",
      };
    }
  },
  staleTime: 5 * 60 * 1000,
  retry: false,
});
