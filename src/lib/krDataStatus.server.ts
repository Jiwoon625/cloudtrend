import type { SupabaseClient } from "@supabase/supabase-js";
import { readFreshCacheObject } from "./cacheObjectStorage";
import { downloadFreshObject } from "./freshStorage";
import { SCREENING_CACHE_VERSION } from "./screeningCacheContract";
import type { AnalysisResult } from "./engine/pipeline";
import type { DataSourceStatus, DataStatusPayload } from "./marketPayload";
import {
  deriveDataStatusFromPublishedAnalysis,
  krDataStatusPointerPath,
  publishedDataStatusIsCurrent,
  readKrDataStatusArtifact,
} from "./dataStatusPublication";

const BUCKET = "cloudtrend-data";

interface PublishedScreeningCache {
  version?: string;
  publicationId?: string;
  resultDigest?: string;
  createdAt?: string;
  payload?: { analysis?: AnalysisResult; source?: DataSourceStatus };
}

function isMissingObject(error: { statusCode?: string; message: string }) {
  return (
    String(error.statusCode) === "404" || /object not found|not_found|404/i.test(error.message)
  );
}

/** 포인터는 mutable 객체라 CDN 캐시를 우회해 매번 새로 읽는다. */
export async function readKrDataStatusPointer(
  client: SupabaseClient,
  owner: string,
): Promise<unknown | null> {
  return downloadPointerJson(client, krDataStatusPointerPath(owner));
}

/** 포인터가 가리키는 게시 세대. 같은 세대의 요약은 다시 계산하지 않는다. */
export function krDataStatusPointerKey(pointer: unknown): string {
  if (!pointer || typeof pointer !== "object") return "absent";
  const value = pointer as { publicationId?: unknown; resultDigest?: unknown };
  if (typeof value.publicationId !== "string" || typeof value.resultDigest !== "string")
    return "invalid";
  return `${value.publicationId}:${value.resultDigest}`;
}

/**
 * Drive v7 게시본 기준 데이터 상태.
 *
 * 1. 게시 실행기가 남긴 요약(현재 게시 세대와 같은 세대여야 함)을 읽는다.
 * 2. 요약이 없으면(= 이 연동 이전에 게시된 세대) 게시된 분석 결과에서 확인 가능한 값만
 *    축약해 돌려준다.
 * 3. Drive 게시본이 활성 CSV 원천보다 오래됐으면 null을 돌려주고 호출자는 CSV 경로로 간다.
 */
export async function resolvePublishedKrDataStatus(
  client: SupabaseClient,
  owner: string,
  legacyLatestDate: string | null,
  pointer: unknown | null,
): Promise<DataStatusPayload | null> {
  if (pointer) {
    const path = (pointer as { path?: unknown }).path;
    if (typeof path === "string" && path.startsWith(`${owner}/cache/data-status/`)) {
      const artifact = await downloadPointerJson(client, path);
      const payload = readKrDataStatusArtifact(pointer, artifact);
      if (payload && publishedDataStatusIsCurrent(payload.asOfDate, legacyLatestDate))
        return payload;
    }
  }
  const cached = await readFreshCacheObject<PublishedScreeningCache>(
    client,
    BUCKET,
    `${owner}/cache/screening/latest.json`,
  );
  const analysis = cached?.payload?.analysis;
  if (!cached || cached.version !== SCREENING_CACHE_VERSION || !analysis) return null;
  // Drive v7 게시본만 이 축약 경로를 쓴다. CSV 게시본은 legacy 계산이 정본이다.
  if (!cached.payload?.source?.drivePublication) return null;
  if (!publishedDataStatusIsCurrent(analysis.asOfDate, legacyLatestDate)) return null;
  return deriveDataStatusFromPublishedAnalysis(analysis, { source: "PUBLISHED_ANALYSIS" });
}

async function downloadPointerJson(client: SupabaseClient, path: string) {
  const { data, error } = await downloadFreshObject(client, BUCKET, path);
  if (error) {
    if (isMissingObject(error as { statusCode?: string; message: string })) return null;
    throw error;
  }
  if (!data) return null;
  try {
    return JSON.parse(await data.text()) as unknown;
  } catch {
    return null;
  }
}
