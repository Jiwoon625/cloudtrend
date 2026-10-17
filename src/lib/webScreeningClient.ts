import { supabase } from "@/lib/cloud";
import { getActiveScoringConfig } from "@/lib/scoringConfigStore";
import { readDashboardCache, readScreeningCache } from "@/lib/screeningCache";
import { runWebScreeningServer } from "@/lib/webScreening.functions";

let serverBuildInFlight: ReturnType<typeof runWebScreeningServer> | null = null;

async function buildCachesOnServer() {
  if (serverBuildInFlight) return serverBuildInFlight;
  serverBuildInFlight = (async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const accessToken = data.session?.access_token;
    if (!accessToken) throw new Error("먼저 로그인해 주세요.");
    return runWebScreeningServer({
      data: { accessToken, config: getActiveScoringConfig() },
    });
  })().finally(() => {
    serverBuildInFlight = null;
  });
  return serverBuildInFlight;
}

/** Read-only page queries. Only the explicit rebuild action may run screening. */
export async function getOrBuildDashboardSummaryServerFirst() {
  const cached = await readDashboardCache();
  if (cached) return cached;
  throw new Error(
    "저장된 결과가 없거나 자료가 갱신되었습니다. 자료수집 후 게시된 스크리닝을 기다리거나 데이터 관리에서 명시적으로 실행해 주세요.",
  );
}

export async function getOrBuildScreeningPayloadServerFirst() {
  const cached = await readScreeningCache();
  if (cached) return cached.payload;
  throw new Error(
    "저장된 결과가 없거나 자료가 갱신되었습니다. 자료수집 후 게시된 스크리닝을 기다리거나 데이터 관리에서 명시적으로 실행해 주세요.",
  );
}

/** Explicit screening checks inputs; unchanged successful publications reuse verified results. */
export async function rebuildScreeningCachesServerFirst() {
  const refresh = await buildCachesOnServer();
  const [screening, dashboard] = await Promise.all([readScreeningCache(), readDashboardCache()]);
  if (!screening || !dashboard) throw new Error("서버 재계산 후 캐시 검증에 실패했습니다.");
  return { screening, dashboard, refresh };
}
