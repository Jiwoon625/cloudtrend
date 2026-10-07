import { supabase } from "@/lib/cloud";
import { getActiveScoringConfig } from "@/lib/scoringConfigStore";
import { readDashboardCache, readScreeningCache } from "@/lib/screeningCache";
import { runWebScreeningServer } from "@/lib/webScreening.functions";

let serverBuildInFlight: ReturnType<typeof runWebScreeningServer> | null = null;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

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

export async function getOrBuildDashboardSummaryServerFirst() {
  const cached = await readDashboardCache();
  if (cached) {
    return cached;
  }
  try {
    await buildCachesOnServer();
    const rebuilt = await readDashboardCache();
    if (rebuilt) return rebuilt;
    throw new Error("서버 계산은 완료됐지만 대시보드 캐시를 다시 읽지 못했습니다.");
  } catch (serverError) {
    throw new Error(
      `서버 스크리닝 실패: ${errorMessage(serverError)}. 잠시 후 다시 시도해 주세요.`,
    );
  }
}

export async function getOrBuildScreeningPayloadServerFirst() {
  const cached = await readScreeningCache();
  if (cached) {
    return cached.payload;
  }
  try {
    await buildCachesOnServer();
    const rebuilt = await readScreeningCache();
    if (rebuilt) return rebuilt.payload;
    throw new Error("서버 계산은 완료됐지만 스크리닝 캐시를 다시 읽지 못했습니다.");
  } catch (serverError) {
    throw new Error(
      `서버 스크리닝 실패: ${errorMessage(serverError)}. 잠시 후 다시 시도해 주세요.`,
    );
  }
}

/** Explicit screening checks inputs; unchanged successful publications reuse verified results. */
export async function rebuildScreeningCachesServerFirst() {
  const refresh = await buildCachesOnServer();
  const [screening, dashboard] = await Promise.all([readScreeningCache(), readDashboardCache()]);
  if (!screening || !dashboard) throw new Error("서버 재계산 후 캐시 검증에 실패했습니다.");
  return { screening, dashboard, refresh };
}
