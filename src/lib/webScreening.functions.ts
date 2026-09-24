import { inputFingerprint, loadActiveSources } from "./screeningSources.server";
import { primeChartContext, publishRecentPrices } from "./instrumentChartStore.server";
import { createHash } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";

import { parseManualMarketData } from "@/lib/engine/manualDataset";
import { runFullMarketAnalysis } from "@/lib/engine/fullMarketAnalysis";
import { mergeScoringConfig, type ScoringConfig } from "@/lib/engine/scoring";
import type { AnalysisResult } from "@/lib/engine/pipeline";
import { latestSourceRegistration, buildSnapshot } from "@/lib/screeningSnapshot";
import {
  buildDashboardSummary,
  deterministicAnalysis,
  SCREENING_CACHE_VERSION,
  stableCacheJson,
} from "@/lib/screeningCacheContract";

const SUPABASE_URL =
  import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
  "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE";
const ANALYSIS_BUCKET = "cloudtrend-data";

function resultDigest(analysis: AnalysisResult) {
  return createHash("sha256")
    .update(stableCacheJson(deterministicAnalysis(analysis)))
    .digest("hex");
}

async function uploadJson(client: SupabaseClient, path: string, value: unknown) {
  const body = new Blob([JSON.stringify(value)], { type: "application/json" });
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(path, body, {
    upsert: true,
    contentType: "application/json",
  });
  if (error) throw new Error(`스크리닝 캐시 저장 실패 (${path}): ${error.message}`);
}

async function readJson<T>(client: SupabaseClient, path: string): Promise<T> {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(path);
  if (error) throw new Error(`스크리닝 캐시 재검증 실패 (${path}): ${error.message}`);
  return JSON.parse(await data.text()) as T;
}

export const runWebScreeningServer = createServerFn({ method: "POST" })
  .inputValidator((input: { accessToken: string; config?: unknown }) => ({
    accessToken: String(input.accessToken ?? ""),
    config: mergeScoringConfig(input.config),
  }))
  .handler(async ({ data }) => {
    if (data.accessToken.length < 20) throw new Error("로그인 세션을 확인할 수 없습니다.");
    const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: `Bearer ${data.accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: authData, error: authError } = await client.auth.getUser(data.accessToken);
    if (authError || !authData.user) throw new Error("로그인 세션 검증에 실패했습니다.");

    const { sources, texts } = await loadActiveSources(client, authData.user.id);
    const parsed = parseManualMarketData(texts);
    const { analysis, dataset } = runFullMarketAnalysis(parsed.dataset, data.config);
    const fingerprint = inputFingerprint(sources, data.config);
    const digest = resultDigest(analysis);
    const source = { live: true, credentialsConfigured: true, fallbackReason: null };
    const screening = {
      version: SCREENING_CACHE_VERSION,
      createdAt: new Date().toISOString(),
      inputFingerprint: fingerprint,
      resultDigest: digest,
      payload: { analysis, source },
    };
    const dashboard = buildDashboardSummary(analysis, fingerprint, digest);
    const screeningPath = `${authData.user.id}/cache/screening/latest.json`;
    const dashboardPath = `${authData.user.id}/cache/dashboard/latest.json`;

    await Promise.all([
      uploadJson(client, screeningPath, screening),
      uploadJson(client, dashboardPath, dashboard),
    ]);

    try {
      const snapshot = buildSnapshot(
        analysis,
        latestSourceRegistration(sources, analysis.asOfDate),
      );
      await client
        .from("screening_history")
        .upsert(
          { user_id: authData.user.id, date: snapshot.date, snapshot },
          { onConflict: "user_id,date" },
        );
    } catch {
      // 이력 저장 실패가 웹 스크리닝 성공을 막지 않게 한다.
    }

    const roundTrip = await readJson<{
      version?: string;
      inputFingerprint?: string;
      resultDigest?: string;
      payload?: { analysis?: AnalysisResult };
    }>(client, screeningPath);
    const roundTripDigest = roundTrip.payload?.analysis
      ? resultDigest(roundTrip.payload.analysis)
      : null;
    if (
      roundTrip.version !== SCREENING_CACHE_VERSION ||
      roundTrip.inputFingerprint !== fingerprint ||
      roundTrip.resultDigest !== digest ||
      roundTripDigest !== digest
    )
      throw new Error("서버 스크리닝 캐시 저장 후 검증에 실패했습니다.");

    primeChartContext(authData.user.id, fingerprint, digest, {
      dataset,
      analysis,
      config: data.config,
    });
    // Prices are cheap; the expensive score warm-up runs in a separate awaited request.
    try {
      await publishRecentPrices(client, authData.user.id, fingerprint, digest, {
        dataset,
        analysis,
        config: data.config,
      });
    } catch (error) {
      console.warn("가격 차트 준비 실패: 종목 방문 시 재시도합니다.", error);
    }
    return {
      ok: true as const,
      asOfDate: analysis.asOfDate,
      rows: analysis.rows.length,
      sources: sources.length,
      inputFingerprint: fingerprint,
      resultDigest: digest,
    };
  });
