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
}

function sha256Text(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function inputFingerprint(sources: ActiveSourceRecord[], config: ScoringConfig) {
  return sha256Text(
    stableCacheJson({
      version: SCREENING_CACHE_VERSION,
      strategyConfig: config,
      sources: sources
        .map((source) => ({
          id: source.id,
          dataHash: source.data_hash,
          schemaHash: source.schema_hash,
          activatedAt: source.activated_at,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      legacyFallback: null,
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

export async function loadActiveSources(client: SupabaseClient, userId: string) {
  const { data, error } = await client
    .from("analysis_source_files")
    .select(
      "id,original_filename,storage_bucket,storage_path,file_hash,data_hash,schema_hash,min_date,max_date,activated_at,created_at",
    )
    .eq("user_id", userId)
    .eq("source_type", "screening")
    .eq("status", "active")
    .order("activated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(`스크리닝 원천데이터 목록 조회 실패: ${error.message}`);
  const sources = (data ?? []) as ActiveSourceRecord[];
  if (sources.length === 0) throw new Error("활성 스크리닝 원천데이터가 없습니다.");

  const texts: string[] = [];
  for (const source of sources) {
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
    texts.push(decodeSource(bytes));
  }
  return { sources, texts };
}
