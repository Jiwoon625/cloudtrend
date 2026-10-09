import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScreeningSnapshot } from "./screeningSnapshot";
import { hydrateScreeningSnapshot } from "./screeningSnapshotStorage";

/** An immutable execution record, independent of the replaceable daily representative. */
export async function archiveScreeningRun(
  client: SupabaseClient,
  owner: string,
  snapshot: ScreeningSnapshot,
) {
  if (!snapshot.runId) return;
  const payload = JSON.parse(JSON.stringify(snapshot));
  const { error } = await client.from("screening_run_archive").upsert(
    {
      user_id: owner,
      run_id: snapshot.runId,
      date: snapshot.asOfDate,
      market: snapshot.market ?? "KR",
      strategy_version: snapshot.strategyVersion ?? "UNRECORDED",
      calculated_at: snapshot.savedAt,
      snapshot: payload,
    },
    { onConflict: "user_id,run_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`실행별 스크리닝 기록 보존 실패: ${error.message}`);
  const { data, error: readError } = await client
    .from("screening_run_archive")
    .select("snapshot")
    .eq("user_id", owner)
    .eq("run_id", snapshot.runId)
    .single();
  if (
    readError ||
    JSON.stringify(hydrateScreeningSnapshot(data?.snapshot)) !== JSON.stringify(snapshot)
  ) {
    // JSONB key ordering is not stable; compare canonical structures below.
    if (readError || canonical(hydrateScreeningSnapshot(data?.snapshot)) !== canonical(snapshot))
      throw new Error("실행 ID가 다른 계산 결과에 재사용되었습니다.");
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
