import { supabase } from "@/lib/cloud";
import { getActiveScoringConfig } from "@/lib/scoringConfigStore";
import {
  getOrBuildDashboardSummary,
  getOrBuildScreeningPayload,
  readDashboardCache,
  readScreeningCache,
} from "@/lib/screeningCache";
import { hydrateSnapshots } from "@/lib/screeningHistory";
import { syncPortfolioFromHistory } from "@/lib/portfolioStore";
import { runWebScreeningServer } from "@/lib/webScreening.functions";

let serverBuildInFlight: Promise<void> | null = null;

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
    await runWebScreeningServer({
      data: { accessToken, config: getActiveScoringConfig() },
    });
  })().finally(() => {
    serverBuildInFlight = null;
  });
  return serverBuildInFlight;
}

async function refreshHistoryAndPortfolio() {
  await hydrateSnapshots();
  await syncPortfolioFromHistory();
}

export async function getOrBuildDashboardSummaryServerFirst() {
  const cached = await readDashboardCache();
  if (cached) return cached;
  try {
    await buildCachesOnServer();
    await refreshHistoryAndPortfolio();
    const rebuilt = await readDashboardCache();
    if (rebuilt) return rebuilt;
    throw new Error("서버 계산은 완료됐지만 대시보드 캐시를 다시 읽지 못했습니다.");
  } catch (serverError) {
    try {
      return await getOrBuildDashboardSummary();
    } catch (browserError) {
      throw new Error(
        `서버 스크리닝 실패: ${errorMessage(serverError)} / 브라우저 예비 계산 실패: ${errorMessage(browserError)}`,
      );
    }
  }
}

export async function getOrBuildScreeningPayloadServerFirst() {
  const cached = await readScreeningCache();
  if (cached) return cached.payload;
  try {
    await buildCachesOnServer();
    await refreshHistoryAndPortfolio();
    const rebuilt = await readScreeningCache();
    if (rebuilt) return rebuilt.payload;
    throw new Error("서버 계산은 완료됐지만 스크리닝 캐시를 다시 읽지 못했습니다.");
  } catch (serverError) {
    try {
      return await getOrBuildScreeningPayload();
    } catch (browserError) {
      throw new Error(
        `서버 스크리닝 실패: ${errorMessage(serverError)} / 브라우저 예비 계산 실패: ${errorMessage(browserError)}`,
      );
    }
  }
}

/** 사용자가 명시적으로 다시 스크리닝을 눌렀을 때 기존 캐시 유무와 관계없이 서버에서 재계산한다. */
export async function rebuildScreeningCachesServerFirst() {
  await buildCachesOnServer();
  await refreshHistoryAndPortfolio();
  const [screening, dashboard] = await Promise.all([readScreeningCache(), readDashboardCache()]);
  if (!screening || !dashboard) throw new Error("서버 재계산 후 캐시 검증에 실패했습니다.");
  return { screening, dashboard };
}
