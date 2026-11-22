import { runSignalJournalStage } from "./signalJournalStage";
import {
  currentDriveGeneration,
  krResultPhase,
  drivePublicationSources,
  type DriveResultPublication,
} from "./driveResultPublication";
import { publishKrSignalJournal } from "./krSignalJournal.server";
import { initialScreeningStages, type ScreeningStages } from "./screeningStages";
import { saveScreeningStages } from "./screeningStages.server";
import { preserveConfirmedEtfContext } from "./confirmedEtfContext.server";
import { applyKrScreeningPublication } from "./krScreeningPublication";
import { verifyKrScreeningPublication } from "./krScreeningPublication.server";
import {
  loadOperationalIndex,
  operationalArtifactForPublication,
} from "./operationalUnderlyingIndex.server";
import { savedOperationalIdentity } from "./screeningInputIdentity";
import { OPERATIONAL_INDEX_VERSION } from "./operationalUnderlyingIndex";
import { UNDERLYING_INDEX_RELEASE } from "./underlyingIndexSupplementRelease";
import { screeningPublicationAnalysis } from "./screeningPublicationAnalysis";
import { appendEtfReportEvidence } from "./etfReportScore";
import { createDataStatusCache } from "./dataStatusCache";
import {
  krDataStatusPointerKey,
  readKrDataStatusPointer,
  resolvePublishedKrDataStatus,
} from "./krDataStatus.server";
import { latestSourceDate } from "./dataStatusPublication";
import type { DataStatusPayload } from "./marketPayload";
import {
  completeScreeningPublication,
  SCREENING_PUBLICATION_VERSION,
  SCREENING_CALCULATION_VERSION,
  screeningPublicationPath,
} from "./screeningPublication.server";
import {
  inputFingerprint,
  loadActiveSources,
  listActiveSourceRecords,
  listActiveSources,
} from "./screeningSources.server";
import { primeChartContext, publishRecentPrices } from "./instrumentChartStore.server";
import { createHash } from "node:crypto";
import { downloadFreshObject } from "./freshStorage";
import { isCompressedCacheObject } from "./cacheObjectEncoding";
import { readFreshCacheObject, writeFreshCacheObject } from "./cacheObjectStorage";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";

import { parseManualMarketDataWithReferences as parseManualMarketData } from "./krxReviewReferenceParser";
import { runCurrentScreening } from "@/lib/currentScreening";
import { mergeScoringConfig, type ScoringConfig } from "@/lib/engine/scoring";
import type { AnalysisResult } from "@/lib/engine/pipeline";
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
  // The screening/dashboard pointers are stored gzip-encoded (see cacheObjectEncoding).
  if (isCompressedCacheObject(path)) {
    await writeFreshCacheObject(client, ANALYSIS_BUCKET, path, value);
    return;
  }
  const body = new Blob([JSON.stringify(value)], { type: "application/json" });
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(path, body, {
    upsert: true,
    contentType: "application/json",
    cacheControl: "0",
  });
  if (error) throw new Error(`스크리닝 캐시 저장 실패 (${path}): ${error.message}`);
}

async function readJson<T>(client: SupabaseClient, path: string): Promise<T> {
  if (isCompressedCacheObject(path)) {
    let value: T | null;
    try {
      value = await readFreshCacheObject<T>(client, ANALYSIS_BUCKET, path);
    } catch (error) {
      throw new Error(
        `스크리닝 캐시 재검증 실패 (${path}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (value === null) throw new Error(`스크리닝 캐시 재검증 실패 (${path}): Object not found`);
    return value;
  }
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
  portfolioRefresh: { status: "DISABLED"; asOfDate: null; calculatedAt: null };
  octoberShadow: null;
  asOfDate: string;
  rows: number;
  sources: number;
  inputFingerprint: string;
  resultDigest: string;
  publicationId: string;
  pipelineStatus: ScreeningStages;
};

/** Server-only entry point; callers must authenticate and provide the verified owner. */
export async function runWebScreeningForUser(
  client: SupabaseClient,
  userId: string,
  config: ScoringConfig,
): Promise<WebScreeningRefreshResult> {
  const registered = await listActiveSources(client, userId);
  const registeredPublication = await verifyKrScreeningPublication(client, userId, registered);
  const preliminary = registeredPublication.phase === "PRELIMINARY";
  const sourceFingerprint = inputFingerprint(registered, config);
  let fingerprint = sourceFingerprint;
  const key = `${userId}/${fingerprint}`;
  const inFlight = screeningBuilds.get(key);
  if (inFlight) return inFlight;
  const build = (async (): Promise<WebScreeningRefreshResult> => {
    const cached = await readJson<{
      version: string;
      publicationId?: string;
      inputFingerprint: string;
      resultDigest: string;
      payload: { analysis: AnalysisResult; source?: { drivePublication?: DriveResultPublication } };
    }>(client, `${userId}/cache/screening/latest.json`).catch(missingCache);
    const savedIdentity = cached?.payload?.analysis
      ? savedOperationalIdentity(cached.payload.analysis)
      : undefined;
    const drive = cached?.payload?.source?.drivePublication;
    const driveHead = await readJson<{ version?: string }>(
      client,
      `${userId}/results/drive-screening/input-head/latest.json`,
    ).catch(missingCache);
    if (driveHead?.version === "drive-input-head-v1" && !drive)
      throw new Error("Drive 운영 이력이 있습니다. v1.1 실행기로 최신 결과를 게시해 주세요.");
    if (drive && cached?.payload.analysis) {
      const combined = await drivePublicationSources(
        drive,
        registered,
        inputFingerprint(registered, config, savedIdentity),
        cached.payload.analysis.asOfDate,
        krResultPhase(cached.payload.analysis),
      );
      const expected = inputFingerprint(combined as typeof registered, config, savedIdentity);
      if (
        expected !== cached.inputFingerprint ||
        resultDigest(cached.payload.analysis) !== cached.resultDigest ||
        !cached.publicationId
      )
        throw new Error("Drive 게시 결과 검증에 실패했습니다. 실행기에서 다시 게시해 주세요.");
      const currentHead = await readJson(
        client,
        `${userId}/results/drive-screening/input-head/latest.json`,
      ).catch(missingCache);
      if (!currentDriveGeneration(currentHead, { ...cached, drivePublication: drive }))
        throw new Error("스크리닝이 게시 중입니다. 잠시 후 새로고침해 주세요.");
      // Reuse is read-only; an old refresh must never overwrite a newer summary.
      return {
        ok: true,
        reused: true,
        portfolioRefresh: { status: "DISABLED", asOfDate: null, calculatedAt: null },
        octoberShadow: null,
        asOfDate: cached.payload.analysis.asOfDate,
        rows: cached.payload.analysis.rows.length,
        sources: combined.length,
        inputFingerprint: expected,
        resultDigest: cached.resultDigest,
        publicationId: cached.publicationId,
        pipelineStatus: {
          screening: "COMPLETED",
          actualPortfolio: "DISABLED",
          models: "DISABLED",
          publication: "COMPLETED",
          signalHistory: drive.phase === "PRELIMINARY" ? "SKIPPED_PRELIMINARY" : "NOT_RUN",
        },
      };
    }
    // CSV 원천 기반 재계산(구 세대)은 명시적 옵트인에서만 돈다. 라이브 배포에서는 활성 원천
    // 52개(약 315MiB)를 통째로 내려받게 되므로, Drive 게시본이 없는 계정은 재계산 대신 재게시를
    // 요구한다. 로컬·복구 화면에서만 CLOUDTREND_LEGACY_CSV_SCREENING=1로 열 수 있다.
    if (process.env["CLOUDTREND_LEGACY_CSV_SCREENING"] !== "1")
      throw new Error(
        "이 결과는 Drive v7 게시본이 아닙니다. 실행기에서 최신 결과를 게시한 뒤 화면을 확인해 주세요.",
      );
    // Resolve the owner, not a global source max_date heuristic. A rollback still reads a
    // valid saved provider; a new publication with changed inputs follows the current flag.
    if (
      cached?.payload?.analysis &&
      inputFingerprint(registered, config, savedIdentity) === cached.inputFingerprint
    ) {
      const artifact = await operationalArtifactForPublication(
        client,
        userId,
        cached.payload.analysis.asOfDate,
        new Date().toISOString(),
      );
      fingerprint = inputFingerprint(
        registered,
        config,
        artifact
          ? {
              version: OPERATIONAL_INDEX_VERSION,
              artifactSha256: UNDERLYING_INDEX_RELEASE.sha256,
              asOfDate: cached.payload.analysis.asOfDate,
              availableFrom: artifact.availableFrom,
            }
          : savedIdentity,
      );
    }
    if (
      !preliminary &&
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
          inputFingerprint(currentSources, config) !== sourceFingerprint
        )
          throw new Error(
            "재사용 확인 중 스크리닝 입력이나 결과가 변경됐습니다. 최신 결과를 다시 확인하세요.",
          );
        const { sources: journalSources, texts } = await loadActiveSources(client, userId);
        if (inputFingerprint(journalSources, config) !== sourceFingerprint)
          throw new Error(
            "신호 이력 점검 중 원천데이터가 변경됐습니다. 최신 입력으로 다시 시도하세요.",
          );
        const journalDataset = parseManualMarketData(texts).dataset;
        const pipelineStatus = initialScreeningStages();
        await runSignalJournalStage(
          pipelineStatus,
          () => saveScreeningStages(client, userId, cached.publicationId!, pipelineStatus),
          () =>
            publishKrSignalJournal(client, userId, {
              dataset: journalDataset,
              config,
              snapshot: appendEtfReportEvidence(
                buildSnapshot(cached.payload.analysis, undefined, cached.publicationId),
                cached.payload.analysis,
              ),
              sourceHash: fingerprint,
            }),
        );
        pipelineStatus.publication = "COMPLETED";
        await saveScreeningStages(client, userId, cached.publicationId, pipelineStatus);
        const portfolioRefresh = {
          status: "DISABLED" as const,
          asOfDate: null,
          calculatedAt: null,
        };
        return {
          ok: true,
          reused: true,
          pipelineStatus,
          portfolioRefresh,
          octoberShadow: null,
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
    if (inputFingerprint(sources, config) !== sourceFingerprint)
      throw new Error("계산 중 원천데이터가 변경됐습니다. 최신 입력으로 다시 시도하세요.");
    const krPublication = await verifyKrScreeningPublication(client, userId, sources, texts);
    if (krPublication.phase !== registeredPublication.phase)
      throw new Error("계산 중 KRX 공표 상태가 변경됐습니다. 최신 입력으로 다시 시도하세요.");
    const parsed = parseManualMarketData(texts);
    const { analysis: engineAnalysis, dataset } = runCurrentScreening(parsed.dataset, config);
    const operationalIndex = await loadOperationalIndex(
      client,
      userId,
      dataset,
      new Date().toISOString(),
    );
    const analysis = applyKrScreeningPublication(
      screeningPublicationAnalysis(engineAnalysis, dataset, config, operationalIndex),
      krPublication,
    );
    fingerprint = inputFingerprint(sources, config, savedOperationalIdentity(analysis));

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
    const sourceRegisteredAt = latestSourceRegistration(sources, analysis.asOfDate);
    if (sourceRegisteredAt) dashboard.sourceRegisteredAt = sourceRegisteredAt;
    const screeningPath = `${userId}/cache/screening/latest.json`;
    const dashboardPath = `${userId}/cache/dashboard/latest.json`;

    const newer = await readJson<{
      publicationId?: string;
      payload?: { source?: { drivePublication?: unknown } };
    }>(client, screeningPath).catch(missingCache);
    if (newer?.payload?.source?.drivePublication && newer.publicationId !== cached?.publicationId)
      throw new Error("계산 중 새 Drive 결과가 게시됐습니다. 홈페이지를 새로고침해 주세요.");

    if (preliminary) await preserveConfirmedEtfContext(client, userId, cached);

    await Promise.all([
      uploadJson(client, screeningPath, screening),
      uploadJson(client, dashboardPath, dashboard),
    ]);

    const snapshot = appendEtfReportEvidence(
      buildSnapshot(
        analysis,
        latestSourceRegistration(sources, analysis.asOfDate),
        screening.publicationId,
      ),
      analysis,
    );
    if (!preliminary) await persistScreeningSnapshot(client, userId, snapshot);
    const pipelineStatus = initialScreeningStages(preliminary);
    const saveStages = () =>
      saveScreeningStages(client, userId, screening.publicationId, pipelineStatus);
    if (preliminary) pipelineStatus.signalHistory = "SKIPPED_PRELIMINARY";
    else
      await runSignalJournalStage(pipelineStatus, saveStages, () =>
        publishKrSignalJournal(client, userId, {
          dataset: parsed.dataset,
          config,
          snapshot,
          sourceHash: fingerprint,
        }),
      );
    const portfolioRefresh = { status: "DISABLED" as const, asOfDate: null, calculatedAt: null };
    const octoberShadow = null;
    await saveStages();

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
      operationalIndex,
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
    // Completion certifies screening and its immutable history, independent of retired ledgers.
    if (!preliminary) {
      try {
        await completeScreeningPublication(client, userId, {
          inputFingerprint: fingerprint,
          resultDigest: digest,
          publicationId: screening.publicationId,
        });
        pipelineStatus.publication = "COMPLETED";
      } catch (error) {
        pipelineStatus.publication = "FAILED";
        await saveStages();
        throw error;
      }
    } else pipelineStatus.publication = preliminary ? "SKIPPED_PRELIMINARY" : "WAITING_FOLLOWUP";
    await saveStages();
    return {
      reused: false,
      pipelineStatus,
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
// "게시 요약 없음"도 한 시간 동안 기억해 매 요청마다 스크리닝 캐시를 다시 읽지 않는다.
const publishedDataStatusCache = createDataStatusCache<DataStatusPayload | null>();

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
    // Drive v7 게시본이 원천 CSV보다 최신이면 게시 요약만 읽고 끝낸다(수백 MB 재다운로드 없음).
    const records = await listActiveSourceRecords(client, auth.user.id);
    const legacyLatestDate = latestSourceDate(records);
    const pointer = await readKrDataStatusPointer(client, auth.user.id);
    // 같은 게시 세대는 다시 계산하지 않는다. 포인터가 없을 때는 한 시간 단위로만 재확인한다.
    const revision = `${krDataStatusPointerKey(pointer)}:${legacyLatestDate ?? "none"}:${new Date().toISOString().slice(0, 13)}`;
    const published = await publishedDataStatusCache.get(
      auth.user.id,
      `published:${revision}`,
      () => resolvePublishedKrDataStatus(client, auth.user.id, legacyLatestDate, pointer),
    );
    if (published) return published;
    // 게시 요약이 현재 게시본과 맞지 않거나 없으면, 예전에는 활성 원천 CSV 52개(약 315MiB)를
    // 내려받아 직접 계산했다. 그 다운로드가 Free 플랜 egress 한도를 넘기던 주된 원인이므로
    // 라이브 화면은 여기서 멈추고 실행기 게시를 요구한다(추정값으로 채우지 않는다).
    throw new Error(
      "이 게시본의 데이터 상태 요약이 없습니다. 실행기에서 최신 결과를 다시 게시한 뒤 확인해 주세요.",
    );
  });
