import runtimeManifest from "./ledger/octoberShadowEngineManifest.generated.json";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisResult } from "./engine/pipeline";
import { readFreshCacheObject } from "./cacheObjectStorage";
import {
  deterministicAnalysis,
  SCREENING_CACHE_VERSION,
  stableCacheJson,
} from "./screeningCacheContract";

// Bump this protocol for calculation-affecting publication adapters/profiles/snapshots
// outside the transitive engine manifest; build-generated runtime hash covers engine changes.
export const SCREENING_PUBLICATION_VERSION = "screening-signals-v2";
export type ScreeningPublicationIdentity = {
  inputFingerprint: string;
  resultDigest: string;
  publicationId: string;
};
export const SCREENING_CALCULATION_VERSION = runtimeManifest.codeHash;
export function screeningPublicationPath(userId: string, expected: ScreeningPublicationIdentity) {
  const key = createHash("sha256")
    .update(
      stableCacheJson({
        inputFingerprint: expected.inputFingerprint,
        resultDigest: expected.resultDigest,
        publicationId: expected.publicationId,
        calculationVersion: SCREENING_CALCULATION_VERSION,
        version: SCREENING_PUBLICATION_VERSION,
      }),
    )
    .digest("hex");
  return `${userId}/results/screening/publications/${key}.json`;
}
export function screeningPublicationReceipt(expected: ScreeningPublicationIdentity) {
  return {
    inputFingerprint: expected.inputFingerprint,
    resultDigest: expected.resultDigest,
    publicationId: expected.publicationId,
    version: SCREENING_PUBLICATION_VERSION,
    calculationVersion: SCREENING_CALCULATION_VERSION,
  };
}

/** Called after screening/history publication. Retired financial writers are not completion dependencies. */
export async function completeScreeningPublication(
  client: SupabaseClient,
  userId: string,
  expected: ScreeningPublicationIdentity,
) {
  const path = `${userId}/cache/screening/latest.json`;
  const cached = await readFreshCacheObject<{
    version: string;
    inputFingerprint: string;
    resultDigest: string;
    publicationId: string;
    payload: { analysis: AnalysisResult };
  }>(client, "cloudtrend-data", path);
  if (!cached) throw new Error("스크리닝 완료 상태를 확인하지 못했습니다.");
  if (
    cached.version !== SCREENING_CACHE_VERSION ||
    cached.inputFingerprint !== expected.inputFingerprint ||
    cached.resultDigest !== expected.resultDigest ||
    cached.publicationId !== expected.publicationId ||
    !cached.payload?.analysis ||
    createHash("sha256")
      .update(stableCacheJson(deterministicAnalysis(cached.payload.analysis)))
      .digest("hex") !== expected.resultDigest
  )
    throw new Error("완료 확인 중 스크리닝 결과가 변경됐습니다. 최신 결과를 다시 확인하세요.");
  if (cached.payload.analysis.krPublication?.phase === "PRELIMINARY")
    throw new Error("PRELIMINARY screening cannot issue a final financial publication receipt");
  const summary = await readFreshCacheObject<{
    inputFingerprint: string;
    resultDigest: string;
  }>(client, "cloudtrend-data", `${userId}/cache/dashboard/latest.json`).catch(() => null);
  if (!summary) throw new Error("대시보드 완료 상태를 확인하지 못했습니다.");
  if (
    summary.inputFingerprint !== expected.inputFingerprint ||
    summary.resultDigest !== expected.resultDigest
  )
    throw new Error("완료 확인 중 대시보드 결과가 변경됐습니다. 최신 결과를 다시 확인하세요.");
  // Immutable identity receipt: never overwrite latest with an older captured payload.
  const { error: writeError } = await client.storage.from("cloudtrend-data").upload(
    screeningPublicationPath(userId, expected),
    new Blob([JSON.stringify(screeningPublicationReceipt(expected))], {
      type: "application/json",
    }),
    { upsert: true, contentType: "application/json", cacheControl: "0" },
  );
  if (writeError) throw new Error("스크리닝 완료 상태 저장에 실패했습니다.");
}
