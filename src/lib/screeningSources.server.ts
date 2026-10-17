import { OPERATIONAL_INDEX_ENABLED } from "./operationalUnderlyingIndexRelease";
import { OPERATIONAL_INDEX_START, OPERATIONAL_INDEX_VERSION } from "./operationalUnderlyingIndex";
import { UNDERLYING_INDEX_RELEASE } from "./underlyingIndexSupplementRelease";
import { sourceFingerprintRecords } from "./sourceFingerprintRecords";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScoringConfig } from "./engine/scoring";
import { SCREENING_CACHE_VERSION, stableCacheJson } from "./screeningCacheContract";
export interface ActiveSourceRecord {
  id: string;
  original_filename: string;
  storage_bucket: string;
  storage_path: string;
  file_hash: string;
  data_hash: string;
  schema_hash: string;
  min_date: string | null;
  max_date: string | null;
  activated_at: string | null;
  created_at: string;
  validation_result?: unknown;
}

function sha256Text(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function inputFingerprint(sources: ActiveSourceRecord[], config: ScoringConfig) {
  return sha256Text(
    stableCacheJson({
      version: SCREENING_CACHE_VERSION,
      strategyConfig: config,
      sources: sourceFingerprintRecords(sources),
      legacyFallback: null,
      ...(OPERATIONAL_INDEX_ENABLED &&
      sources.some((s) => (s.max_date ?? "") >= OPERATIONAL_INDEX_START)
        ? {
            operationalIndex: {
              version: OPERATIONAL_INDEX_VERSION,
              artifactSha256: UNDERLYING_INDEX_RELEASE.sha256,
            },
          }
        : {}),
    }),
  );
}

function decodeSource(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

export async function listActiveSources(client: SupabaseClient, userId: string) {
  const { data, error } = await client
    .from("analysis_source_files")
    .select(
      "id,original_filename,storage_bucket,storage_path,file_hash,data_hash,schema_hash,min_date,max_date,activated_at,created_at,validation_result",
    )
    .eq("user_id", userId)
    .eq("source_type", "screening")
    .eq("status", "active")
    // parseManualMarketData는 뒤에 들어온 중복 행의 비어 있지 않은 값을
    // 덮어쓴다. 오래된 source부터 읽어 최신 활성 source가 최종 우선권을 갖게 한다.
    .order("activated_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error(`스크리닝 원천데이터 목록 조회 실패: ${error.message}`);
  const sources = (data ?? []) as ActiveSourceRecord[];
  if (sources.length === 0) throw new Error("활성 스크리닝 원천데이터가 없습니다.");

  return sources;
}

export async function loadActiveSources(
  client: SupabaseClient,
  userId: string,
  downloadConcurrency = 1,
) {
  const sources = await listActiveSources(client, userId);
  const texts = new Array<string>(sources.length);
  // Keep source precedence independent of response order and bound peak download memory.
  const concurrency = Math.max(1, Math.min(3, Math.floor(downloadConcurrency) || 1));
  async function downloadSource(index: number) {
    const source = sources[index]!;
    const { data: blob, error: downloadError } = await client.storage
      .from(source.storage_bucket)
      .download(source.storage_path);
    if (downloadError)
      throw new Error(
        `스크리닝 원천파일 다운로드 실패 (${source.original_filename}): ${downloadError.message}`,
      );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const fileHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (fileHash !== source.file_hash)
      throw new Error(`스크리닝 원천파일 해시가 등록정보와 다릅니다: ${source.original_filename}`);
    texts[index] = decodeSource(bytes);
  }
  for (let i = 0; i < sources.length; i += concurrency)
    await Promise.all(
      sources.slice(i, i + concurrency).map((_, offset) => downloadSource(i + offset)),
    );
  return { sources, texts };
}
