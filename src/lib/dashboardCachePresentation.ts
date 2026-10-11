import type { QueryKey } from "@tanstack/react-query";
import { CLOUD_DATA_BUCKET, ownerPath, supabase } from "./cloud";
import { readDashboardCache } from "./screeningCache";
import { listRegisteredSources } from "./sourceRegistry";

/** A cache miss is not evidence that screening has never run. */
export function dashboardCacheReadInterval(state: {
  data: unknown;
  status: string;
  dataUpdateCount: number;
}): number | false {
  if (state.status !== "success" || state.data !== null) return false;
  return Math.min(15_000 * 2 ** Math.min(3, Math.max(0, state.dataUpdateCount - 1)), 120_000);
}

/** Only reads existing results. Query's shared key coalesces in-flight reads. */
export function dashboardCacheReadQueryOptions(queryKey: QueryKey, pollingPaused = false) {
  return {
    queryKey,
    queryFn: readDashboardCache,
    staleTime: 5 * 60 * 1000,
    retry: false,
    refetchInterval: (query: { state: Parameters<typeof dashboardCacheReadInterval>[0] }) =>
      pollingPaused ? false : dashboardCacheReadInterval(query.state),
    // Query's visibility gate pauses polling in hidden tabs without a second timer.
    refetchIntervalInBackground: false,
  };
}

export type DashboardSourceAvailability = "REGISTERED" | "LEGACY" | "NONE";

/** Inspect registry/object metadata only; never download or parse source prices. */
export async function readDashboardSourceAvailability(): Promise<DashboardSourceAvailability> {
  if ((await listRegisteredSources("screening", ["active"])).length > 0) return "REGISTERED";
  const { data, error } = await supabase.storage
    .from(CLOUD_DATA_BUCKET)
    .info(await ownerPath("kr.json"));
  if (error) {
    // Access/network/server failures are not evidence that the user has no data.
    if (Number((error as { statusCode?: string }).statusCode) === 404) return "NONE";
    throw error;
  }
  if (!data) throw new Error("기존 원자료 파일의 등록 상태를 확인하지 못했습니다.");
  return "LEGACY";
}

export function dashboardCacheEmptyPresentation(source?: DashboardSourceAvailability) {
  if (source === "NONE")
    return {
      title: "등록된 국내 원자료가 없습니다",
      detail:
        "데이터 관리에서 국내 주식·ETF 원자료를 등록해 주세요. 저장된 결과가 생기면 자동으로 다시 확인합니다.",
    };
  if (source === undefined)
    return {
      title: "저장 결과와 원자료 상태를 확인하고 있습니다",
      detail: "현재 입력에 맞는 저장 결과를 찾지 못해 원자료 등록 상태를 확인하고 있습니다.",
    };
  return {
    title: "현재 입력에 맞는 저장 결과가 없습니다",
    detail:
      (source === "LEGACY"
        ? "기존 자료 파일이 있습니다. 데이터 관리에서 등록 상태를 확인해 주세요. "
        : "등록된 원자료가 있습니다. ") +
      "자료나 계산 기준이 바뀌었거나 아직 결과가 저장되지 않았을 수 있습니다. 다른 화면에서 계산 중이면 완료된 결과를 자동으로 다시 확인합니다.",
  };
}
