import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseManualMarketDataWithReferences as parseManualMarketData } from "./krxReviewReferenceParser";
import type { MarketDataset } from "./engine/dataset";
import { stableCacheJson } from "./screeningCacheContract";
import {
  loadActiveSources,
  listActiveSources,
  type ActiveSourceRecord,
} from "./screeningSources.server";
import {
  calculateIndexDiagnostics,
  parseUnderlyingIndexArtifact,
} from "./underlyingIndexSupplement";
import { UNDERLYING_INDEX_RELEASE } from "./underlyingIndexSupplementRelease";

const BUCKET = "cloudtrend-data";
export const indexSha256 = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
export function underlyingIndexPath(owner: string, digest = UNDERLYING_INDEX_RELEASE.sha256) {
  if (!/^[0-9a-f-]{36}$/.test(owner) || !/^[0-9a-f]{64}$/.test(digest))
    throw new Error("검증되지 않은 소유자 또는 해시입니다.");
  return `${owner}/results/ingestion/underlying-index/${digest}.json`;
}
export const sourceSetDigest = (sources: ActiveSourceRecord[]) =>
  indexSha256(stableCacheJson(sources));
/** Streams deterministic fields into the hash without duplicating a giant dataset as one string. */
export function datasetDigest(ds: MarketDataset) {
  const hash = createHash("sha256");
  for (const key of Object.keys(ds).sort()) {
    hash.update(JSON.stringify(key));
    const value = ds[key as keyof MarketDataset];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const name of Object.keys(value).sort()) {
        hash.update(JSON.stringify(name));
        hash.update(stableCacheJson((value as Record<string, unknown>)[name]));
      }
    } else hash.update(stableCacheJson(value));
  }
  return hash.digest("hex");
}

function missing(error: {
  statusCode?: string | undefined;
  status?: number | undefined;
  message?: string | undefined;
}) {
  return String(error.statusCode ?? error.status) === "404" || error.message === "Object not found";
}
async function readArtifactText(client: SupabaseClient, owner: string): Promise<string | null> {
  const { data, error } = await client.storage.from(BUCKET).download(underlyingIndexPath(owner));
  if (error) {
    if (missing(error)) return null;
    throw new Error(`기초지수 전용 자료 읽기 실패: ${error.message}`);
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (indexSha256(bytes) !== UNDERLYING_INDEX_RELEASE.sha256)
    throw new Error("저장된 기초지수 자료의 해시가 다릅니다.");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Only a pinned, reviewed extraction may be installed. No overwrite, registry mutation or activation. */
export async function installUnderlyingIndexArtifact(
  client: SupabaseClient,
  owner: string,
  compressedBase64: string,
  now: string,
) {
  if (!UNDERLYING_INDEX_RELEASE.enabled)
    throw new Error("기초지수 진단 연결이 비활성화되었습니다.");
  if (compressedBase64.length > 4_000_000)
    throw new Error("전용 자료의 압축 크기 제한을 초과했습니다.");
  const bytes = gunzipSync(Buffer.from(compressedBase64, "base64"), {
    maxOutputLength: 16 * 1024 * 1024,
  });
  const digest = indexSha256(bytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (digest !== UNDERLYING_INDEX_RELEASE.sha256)
    throw new Error("사전 검증된 기초지수 자료와 해시가 다릅니다.");
  const artifact = parseUnderlyingIndexArtifact(JSON.parse(text), now);
  if (artifact.cutoffDate !== UNDERLYING_INDEX_RELEASE.cutoffDate)
    throw new Error("자료 기준일이 승인된 빈티지와 다릅니다.");
  const beforeSources = sourceSetDigest(await listActiveSources(client, owner));
  const existing = await readArtifactText(client, owner);
  if (existing !== null)
    return {
      installed: true as const,
      reused: true,
      sha256: digest,
      bytes: Buffer.byteLength(text),
      sourceSetDigest: beforeSources,
    };
  if (sourceSetDigest(await listActiveSources(client, owner)) !== beforeSources)
    throw new Error("원천 집합이 변경되어 저장을 중단했습니다.");
  const { error } = await client.storage
    .from(BUCKET)
    .upload(underlyingIndexPath(owner), new Blob([text], { type: "application/json" }), {
      upsert: false,
      contentType: "application/json",
      cacheControl: "31536000",
    });
  // An uncertain write or concurrent identical install is resolved by one exact read, never overwrite/retry.
  const reread = await readArtifactText(client, owner);
  if (reread === null || indexSha256(reread) !== digest)
    throw new Error(error?.message ?? "저장 후 동일성 검증에 실패했습니다.");
  return {
    installed: true as const,
    reused: Boolean(error),
    sha256: digest,
    bytes: Buffer.byteLength(text),
    sourceSetDigest: beforeSources,
  };
}

/** Actual backend consumer. All persistent operations here are reads; no screening engine or publisher. */
async function calculateForOwner(client: SupabaseClient, owner: string, now: string) {
  if (!UNDERLYING_INDEX_RELEASE.enabled) return { status: "disabled" as const };
  const text = await readArtifactText(client, owner);
  if (text === null)
    return { status: "not-installed" as const, sha256: UNDERLYING_INDEX_RELEASE.sha256 };
  const artifact = parseUnderlyingIndexArtifact(JSON.parse(text), now);
  const { sources, texts } = await loadActiveSources(client, owner);
  const inputDigest = sourceSetDigest(sources);
  const { dataset } = parseManualMarketData(texts);
  const before = datasetDigest(dataset);
  const report = calculateIndexDiagnostics(dataset, artifact);
  const after = datasetDigest(dataset);
  if (before !== after) throw new Error("진단 중 가격·원천 입력이 변경되어 결과를 폐기했습니다.");
  if (sourceSetDigest(await listActiveSources(client, owner)) !== inputDigest)
    throw new Error("진단 중 활성 입력 집합이 변경되어 결과를 폐기했습니다.");
  return {
    status: "ready" as const,
    sha256: UNDERLYING_INDEX_RELEASE.sha256,
    sourceSetDigest: inputDigest,
    activeSourcesRead: sources.length,
    originalBytesVerified: sources.length,
    sidecarBytesVerified: Buffer.byteLength(text),
    datasetBeforeSha256: before,
    datasetAfterSha256: after,
    priceRowsUnchanged: true as const,
    strategyApplied: false as const,
    writesPerformed: 0 as const,
    report,
  };
}

// Never run concurrent full-source parses for the same owner in one server process.
const inFlight = new Map<string, ReturnType<typeof calculateForOwner>>();
export function readUnderlyingIndexDiagnostics(client: SupabaseClient, owner: string, now: string) {
  const key = `${owner}:${UNDERLYING_INDEX_RELEASE.sha256}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = calculateForOwner(client, owner, now).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}
