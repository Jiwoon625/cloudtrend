import {
  completeScreeningPublication,
  SCREENING_PUBLICATION_VERSION,
  SCREENING_CALCULATION_VERSION,
  screeningPublicationPath,
} from "./screeningPublication.server";
import { refreshPortfolioAfterScreening } from "./portfolioLedgers.server";
import { recordWebOctoberShadow } from "./octoberShadowPublication.server";
import { inputFingerprint, loadActiveSources, listActiveSources } from "./screeningSources.server";
import { primeChartContext, publishRecentPrices } from "./instrumentChartStore.server";
import { createHash } from "node:crypto";
import { downloadFreshObject } from "./freshStorage";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";

import { parseManualMarketData } from "@/lib/engine/manualDataset";
import { runFullMarketAnalysis } from "@/lib/engine/fullMarketAnalysis";
import { mergeScoringConfig, type ScoringConfig } from "@/lib/engine/scoring";
import type { AnalysisResult } from "@/lib/engine/pipeline";
import { withOnsetProfiles } from "@/lib/onsetProfile";
import {
  latestSourceRegistration,
  buildSnapshot,
  persistScreeningSnapshot,
} from "@/lib/screeningSnapshot";
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
    cacheControl: "0",
  });
  if (error) throw new Error(`스크리닝 캐시 저장 실패 (${path}): ${error.message}`);
}

async function readJson<T>(client: SupabaseClient, path: string): Promise<T> {
  const { data, error } = await downloadFreshObject(client, ANALYSIS_BUCKET, path);
  if (error) throw new Error(`스크리닝 캐시 재검증 실패 (${path}): ${error.message}`);
  return JSON.parse(await data.text()) as T;
}

function missingCache(error: unknown): null {
  if (
    error instanceof SyntaxError ||
    (error instanceof Error && /Object not found|not_found|404/i.test(error.message))
  )
    return null;
  throw error;
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

    return runWebScreeningForUser(client, authData.user.id, data.config);
  });

const screeningBuilds = new Map<string, Promise<WebScreeningRefreshResult>>();
type WebScreeningRefreshResult = {
  ok: true;
  reused: boolean;
  portfolioRefresh:
    | Awaited<ReturnType<typeof refreshPortfolioAfterScreening>>
    | { status: "FAILED"; asOfDate: null; calculatedAt: null };
  octoberShadow: Awaited<ReturnType<typeof recordWebOctoberShadow>> | null;
  asOfDate: string;
  rows: number;
  sources: number;
  inputFingerprint: string;
  resultDigest: string;
  publicationId: string;
};

/** Server-only entry point; callers must authenticate and provide the verified owner. */
export async function runWebScreeningForUser(
  client: SupabaseClient,
  userId: string,
  config: ScoringConfig,
): Promise<WebScreeningRefreshResult> {
  const registered = await listActiveSources(client, userId);
  const fingerprint = inputFingerprint(registered, config);
  const key = `${userId}/${fingerprint}`;
  const inFlight = screeningBuilds.get(key);
  if (inFlight) return inFlight;
  const build = (async (): Promise<WebScreeningRefreshResult> => {
    const cached = await readJson<{
      version: string;
      publicationId?: string;
      inputFingerprint: string;
      resultDigest: string;
      octoberShadow?: Awaited<ReturnType<typeof recordWebOctoberShadow>>;
      payload: { analysis: AnalysisResult };
    }>(client, `${userId}/cache/screening/latest.json`).catch(missingCache);
    if (
      cached?.version === SCREENING_CACHE_VERSION &&
      typeof cached.publicationId === "string" &&
      cached.inputFingerprint === fingerprint &&
      cached.payload?.analysis &&
      resultDigest(cached.payload.analysis) === cached.resultDigest
    ) {
      const dashboard = await readJson<{ inputFingerprint: string; resultDigest: string }>(
        client,
        `${userId}/cache/dashboard/latest.json`,
      ).catch(missingCache);
      const receipt = await readJson<{
        version: string;
        calculationVersion: string;
        inputFingerprint: string;
        resultDigest: string;
        publicationId: string;
      }>(
        client,
        screeningPublicationPath(userId, {
          inputFingerprint: cached.inputFingerprint,
          resultDigest: cached.resultDigest,
          publicationId: cached.publicationId,
        }),
      ).catch(missingCache);
      if (
        dashboard?.inputFingerprint === fingerprint &&
        dashboard.resultDigest === cached.resultDigest &&
        receipt?.version === SCREENING_PUBLICATION_VERSION &&
        receipt.calculationVersion === SCREENING_CALCULATION_VERSION &&
        receipt.inputFingerprint === fingerprint &&
        receipt.resultDigest === cached.resultDigest &&
        receipt.publicationId === cached.publicationId
      ) {
        // A receipt certifies that generation's history. Never re-upsert captured history
        // on reuse; a newer same-day screen may already have been published elsewhere.
        const current = await readJson<{
          publicationId?: string;
          inputFingerprint?: string;
          resultDigest?: string;
        }>(client, `${userId}/cache/screening/latest.json`);
        const currentSources = await listActiveSources(client, userId);
        if (
          current.publicationId !== cached.publicationId ||
          current.inputFingerprint !== fingerprint ||
          current.resultDigest !== cached.resultDigest ||
          inputFingerprint(currentSources, config) !== fingerprint
        )
          throw new Error(
            "재사용 확인 중 스크리닝 입력이나 결과가 변경됐습니다. 최신 결과를 다시 확인하세요.",
          );
        return {
          ok: true,
          reused: true,
          portfolioRefresh: await refreshPortfolioAfterScreening(client, userId).catch(() => ({
            status: "FAILED" as const,
            asOfDate: null,
            calculatedAt: null,
          })),
          octoberShadow: cached.octoberShadow ?? null,
          asOfDate: cached.payload.analysis.asOfDate,
          rows: cached.payload.analysis.rows.length,
          sources: registered.length,
          inputFingerprint: fingerprint,
          resultDigest: cached.resultDigest,
          publicationId: cached.publicationId,
        };
      }
    }
    const { sources, texts } = await loadActiveSources(client, userId);
    if (inputFingerprint(sources, config) !== fingerprint)
      throw new Error("계산 중 원천데이터가 변경됐습니다. 최신 입력으로 다시 시도하세요.");
    const parsed = parseManualMarketData(texts);
    const { analysis: engineAnalysis, dataset } = runFullMarketAnalysis(parsed.dataset, config);
    const analysis = withOnsetProfiles(engineAnalysis, dataset, config);

    const digest = resultDigest(analysis);
    const source = { live: true, credentialsConfigured: true, fallbackReason: null };
    const screening = {
      version: SCREENING_CACHE_VERSION,
      createdAt: new Date().toISOString(),
      publicationId: crypto.randomUUID(),
      inputFingerprint: fingerprint,
      resultDigest: digest,
      payload: { analysis, source },
    };
    const dashboard = buildDashboardSummary(analysis, fingerprint, digest);
    const screeningPath = `${userId}/cache/screening/latest.json`;
    const dashboardPath = `${userId}/cache/dashboard/latest.json`;

    await Promise.all([
      uploadJson(client, screeningPath, screening),
      uploadJson(client, dashboardPath, dashboard),
    ]);

    // Keep the frozen October model on the untouched engine payload. Onset profiles are display-only.
    const shadowSnapshot = buildSnapshot(
      engineAnalysis,
      latestSourceRegistration(sources, engineAnalysis.asOfDate),
    );
    const octoberShadow = await recordWebOctoberShadow({
      client,
      userId: userId,
      dataset,
      analysis: engineAnalysis,
      config: config,
      snapshot: shadowSnapshot,
      sources,
      decisionAt: screening.createdAt,
    });

    const snapshot = buildSnapshot(
      analysis,
      latestSourceRegistration(sources, analysis.asOfDate),
      screening.publicationId,
    );
    await persistScreeningSnapshot(client, userId, snapshot);
    const portfolioRefresh = await refreshPortfolioAfterScreening(client, userId, {
      sources,
      texts,
    }).catch(() => ({ status: "FAILED" as const, asOfDate: null, calculatedAt: null }));

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

    primeChartContext(userId, fingerprint, digest, {
      dataset,
      analysis,
      config: config,
    });
    // Prices are cheap; the expensive score warm-up runs in a separate awaited request.
    try {
      await publishRecentPrices(client, userId, fingerprint, digest, {
        dataset,
        analysis,
        config: config,
      });
    } catch (error) {
      console.warn("가격 차트 준비 실패: 종목 방문 시 재시도합니다.", error);
    }
    // Only fully successful publications are reusable. An earlier failed Shadow or
    // history/portfolio write cannot be hidden behind an already-uploaded cache.
    if (octoberShadow.status !== "DEFERRED" && portfolioRefresh.status !== "FAILED")
      await completeScreeningPublication(client, userId, {
        inputFingerprint: fingerprint,
        resultDigest: digest,
        publicationId: screening.publicationId,
      });
    return {
      reused: false,
      portfolioRefresh,
      ok: true as const,
      octoberShadow,
      asOfDate: analysis.asOfDate,
      rows: analysis.rows.length,
      sources: sources.length,
      inputFingerprint: fingerprint,
      resultDigest: digest,
      publicationId: screening.publicationId,
    };
  })().finally(() => screeningBuilds.delete(key));
  screeningBuilds.set(key, build);
  return build;
}

// Keep only small QA responses; raw market data is never retained here.
const dataStatusCache = new Map<string, import("./market.functions").DataStatusPayload>();

export const dataStatusServer = createServerFn({ method: "POST" })
  .inputValidator((input: { accessToken: string; config?: unknown }) => ({
    accessToken: String(input.accessToken ?? ""),
    config: mergeScoringConfig(input.config),
  }))
  .handler(async ({ data }) => {
    const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: `Bearer ${data.accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: auth, error } = await client.auth.getUser(data.accessToken);
    if (error || !auth.user) throw new Error("로그인 세션 검증에 실패했습니다.");
    const sources = await listActiveSources(client, auth.user.id);
    const fingerprint = inputFingerprint(sources, data.config);
    const key = `${auth.user.id}/${fingerprint}`;
    const cached = dataStatusCache.get(key);
    if (cached) return cached;
    const { texts } = await loadActiveSources(client, auth.user.id);
    const { computeDatasetDataStatus } = await import("./datasetDataStatus");
    const status = computeDatasetDataStatus(parseManualMarketData(texts).dataset, data.config);
    dataStatusCache.set(key, status);
    if (dataStatusCache.size > 4) dataStatusCache.delete(dataStatusCache.keys().next().value!);
    return status;
  });
