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
  validateUnderlyingIndexPreferenceDelta,
  type UnderlyingIndexArtifact,
} from "./underlyingIndexSupplement";
import { collectUnderlyingIndexEvidence } from "./underlyingIndexEvidence";
import { UNDERLYING_INDEX_RELEASE } from "./underlyingIndexSupplementRelease";

const BUCKET = "cloudtrend-data";
export const indexSha256 = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
export function underlyingIndexPath(
  owner: string,
  digest: string = UNDERLYING_INDEX_RELEASE.sha256,
) {
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
async function readPinnedArtifactText(
  client: SupabaseClient,
  owner: string,
  digest: string,
): Promise<string | null> {
  const { data, error } = await client.storage
    .from(BUCKET)
    .download(underlyingIndexPath(owner, digest));
  if (error) {
    if (missing(error)) return null;
    throw new Error(`기초지수 전용 자료 읽기 실패: ${error.message}`);
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (indexSha256(bytes) !== digest) throw new Error("저장된 기초지수 자료의 해시가 다릅니다.");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function validateOriginalArtifact(
  client: SupabaseClient,
  owner: string,
  artifact: UnderlyingIndexArtifact,
  now: string,
  suppliedOriginalText?: string,
): Promise<{ text: string; missing: boolean } | null> {
  const preference = artifact.approvedPreference;
  if (!preference) {
    if (suppliedOriginalText !== undefined)
      throw new Error("승인된 빈티지에만 검증용 원본을 함께 설치할 수 있습니다.");
    return null;
  }
  if (preference.originalArtifactSha256 !== UNDERLYING_INDEX_RELEASE.originalArtifactSha256)
    throw new Error("승인 전 원본 지수 자료의 해시가 승인된 원본과 다릅니다.");
  const storedOriginalText = await readPinnedArtifactText(
    client,
    owner,
    UNDERLYING_INDEX_RELEASE.originalArtifactSha256,
  );
  const originalText = storedOriginalText ?? suppliedOriginalText;
  if (originalText === undefined)
    throw new Error("승인 전 원본 지수 자료가 없어 승인 범위를 검증할 수 없습니다.");
  if (indexSha256(originalText) !== UNDERLYING_INDEX_RELEASE.originalArtifactSha256)
    throw new Error("승인 전 원본 지수 자료의 해시가 승인된 원본과 다릅니다.");
  validateUnderlyingIndexPreferenceDelta(
    artifact,
    parseUnderlyingIndexArtifact(JSON.parse(originalText), now),
  );
  return { text: originalText, missing: storedOriginalText === null };
}

/** Returns approved bytes only after validating the pinned original and bounded approval delta. */
export async function readArtifactText(
  client: SupabaseClient,
  owner: string,
  now = new Date().toISOString(),
): Promise<string | null> {
  const text = await readPinnedArtifactText(client, owner, UNDERLYING_INDEX_RELEASE.sha256);
  if (text === null) return null;
  const artifact = parseUnderlyingIndexArtifact(JSON.parse(text), now);
  if (artifact.cutoffDate !== UNDERLYING_INDEX_RELEASE.cutoffDate)
    throw new Error("자료 기준일이 승인된 빈티지와 다릅니다.");
  await validateOriginalArtifact(client, owner, artifact, now);
  return text;
}

function decodePinnedCompressedArtifact(
  compressedBase64: string,
  expectedDigest: string,
  now: string,
) {
  if (compressedBase64.length > 4_000_000)
    throw new Error("전용 자료의 압축 크기 제한을 초과했습니다.");
  const bytes = gunzipSync(Buffer.from(compressedBase64, "base64"), {
    maxOutputLength: 16 * 1024 * 1024,
  });
  if (indexSha256(bytes) !== expectedDigest)
    throw new Error("사전 검증된 기초지수 자료와 해시가 다릅니다.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { text, artifact: parseUnderlyingIndexArtifact(JSON.parse(text), now) };
}

/** Only pinned, reviewed extractions may be installed. No overwrite, registry mutation or activation. */
export async function installUnderlyingIndexArtifact(
  client: SupabaseClient,
  owner: string,
  compressedBase64: string,
  now: string,
  originalCompressedBase64?: string,
) {
  if (!UNDERLYING_INDEX_RELEASE.enabled)
    throw new Error("기초지수 진단 연결이 비활성화되었습니다.");
  const digest = UNDERLYING_INDEX_RELEASE.sha256;
  const { text, artifact } = decodePinnedCompressedArtifact(compressedBase64, digest, now);
  if (artifact.cutoffDate !== UNDERLYING_INDEX_RELEASE.cutoffDate)
    throw new Error("자료 기준일이 승인된 빈티지와 다릅니다.");
  const suppliedOriginal =
    originalCompressedBase64 === undefined
      ? undefined
      : decodePinnedCompressedArtifact(
          originalCompressedBase64,
          UNDERLYING_INDEX_RELEASE.originalArtifactSha256,
          now,
        );
  // Validate both pinned bytes and the complete approval delta before either object can be written.
  // A stored original is always read and reused; a corrupt object must never be replaced.
  const original = await validateOriginalArtifact(
    client,
    owner,
    artifact,
    now,
    suppliedOriginal?.text,
  );
  const beforeSources = sourceSetDigest(await listActiveSources(client, owner));
  if (
    artifact.approvedPreference &&
    beforeSources !== artifact.approvedPreference.expectedSourceSetDigest
  )
    throw new Error("활성 원천 집합이 승인 범위와 달라 전용 자료 설치를 중단했습니다.");
  const existing = await readPinnedArtifactText(client, owner, digest);
  if (sourceSetDigest(await listActiveSources(client, owner)) !== beforeSources)
    throw new Error("원천 집합이 변경되어 저장을 중단했습니다.");
  if (original?.missing) {
    let uploadError: string | undefined;
    try {
      const { error } = await client.storage
        .from(BUCKET)
        .upload(
          underlyingIndexPath(owner, UNDERLYING_INDEX_RELEASE.originalArtifactSha256),
          new Blob([original.text], { type: "application/json" }),
          { upsert: false, contentType: "application/json", cacheControl: "31536000" },
        );
      uploadError = error?.message;
    } catch (error) {
      uploadError = error instanceof Error ? error.message : "원본 저장 결과를 확인할 수 없습니다.";
    }
    // Resolve an uncertain response or concurrent identical install with one read, never overwrite/retry.
    const reread = await readPinnedArtifactText(
      client,
      owner,
      UNDERLYING_INDEX_RELEASE.originalArtifactSha256,
    );
    if (reread === null || reread !== original.text)
      throw new Error(uploadError ?? "원본 저장 후 동일성 검증에 실패했습니다.");
    if (sourceSetDigest(await listActiveSources(client, owner)) !== beforeSources)
      throw new Error("원천 집합이 변경되어 승인 자료 저장을 중단했습니다.");
  }
  if (existing !== null)
    return {
      installed: true as const,
      reused: true,
      sha256: digest,
      bytes: Buffer.byteLength(text),
      sourceSetDigest: beforeSources,
    };
  const { error } = await client.storage
    .from(BUCKET)
    .upload(underlyingIndexPath(owner), new Blob([text], { type: "application/json" }), {
      upsert: false,
      contentType: "application/json",
      cacheControl: "31536000",
    });
  // An uncertain write or concurrent identical install is resolved by one exact read, never overwrite/retry.
  const reread = await readArtifactText(client, owner, now);
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
  const text = await readArtifactText(client, owner, now);
  if (text === null)
    return { status: "not-installed" as const, sha256: UNDERLYING_INDEX_RELEASE.sha256 };
  const artifact = parseUnderlyingIndexArtifact(JSON.parse(text), now);
  const { sources, texts } = await loadActiveSources(client, owner);
  const inputDigest = sourceSetDigest(sources);
  const { dataset } = parseManualMarketData(texts);
  const before = datasetDigest(dataset);
  const report = calculateIndexDiagnostics(dataset, artifact, {
    sourceSetDigest: inputDigest,
    datasetSha256: before,
    now,
  });
  const comparisonEvidence = collectUnderlyingIndexEvidence(
    dataset,
    artifact,
    report,
    sources,
    texts,
  );
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
    comparisonEvidence,
    approvedPreferenceAudit: artifact.approvedPreference ?? null,
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
