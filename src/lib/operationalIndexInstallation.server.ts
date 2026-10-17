import type { SupabaseClient } from "@supabase/supabase-js";
import { UNDERLYING_INDEX_RELEASE } from "./underlyingIndexSupplementRelease";

/** Durable owner-scoped receipt survives deleted Storage objects and rollback. No read-side writes. */
export async function hasOperationalIndexInstallation(client: SupabaseClient, owner: string) {
  const { data, error } = await client
    .from("operational_index_installations")
    .select("artifact_sha256,original_sha256")
    .eq("user_id", owner)
    .maybeSingle();
  if (error) throw new Error(`MA60 설치 이력 확인 실패: ${error.message}`);
  if (!data) return false;
  if (
    data.artifact_sha256 !== UNDERLYING_INDEX_RELEASE.sha256 ||
    data.original_sha256 !== UNDERLYING_INDEX_RELEASE.originalArtifactSha256
  )
    throw new Error("MA60 설치 이력과 승인된 해시가 다릅니다.");
  return true;
}

export async function recordOperationalIndexInstallation(client: SupabaseClient, owner: string) {
  const { error } = await client.from("operational_index_installations").upsert(
    {
      user_id: owner,
      artifact_sha256: UNDERLYING_INDEX_RELEASE.sha256,
      original_sha256: UNDERLYING_INDEX_RELEASE.originalArtifactSha256,
    },
    { onConflict: "user_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`MA60 설치 이력 저장 실패: ${error.message}`);
  if (!(await hasOperationalIndexInstallation(client, owner)))
    throw new Error("MA60 설치 이력 저장 후 검증 실패");
}
