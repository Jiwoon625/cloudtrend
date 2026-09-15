import process from "node:process";

import { ANALYSIS_BUCKET, trustedSupabaseClient } from "./analysis-run-store";

function requiredUserId() {
  const userId = process.env["SUPABASE_USER_ID"]?.trim() ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("SUPABASE_USER_ID가 필요합니다.");
  return userId;
}

async function removePaths(paths: string[]) {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return { objects: 0 };
  const client = trustedSupabaseClient();
  let removed = 0;
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const { error } = await client.storage.from(ANALYSIS_BUCKET).remove(batch);
    if (error) throw new Error(`Storage 정리 실패: ${error.message}`);
    removed += batch.length;
  }
  return { objects: removed };
}

async function main() {
  const userId = requiredUserId();
  const client = trustedSupabaseClient();
  const removed: Record<string, number> = {};

  // 1) DB 감사추적 행은 유지하고, 이미 대체/삭제된 screening 원본 blob만 제거한다.
  const { data: staleSources, error: staleSourceError } = await client
    .from("analysis_source_files")
    .select("storage_path")
    .eq("user_id", userId)
    .eq("source_type", "screening")
    .in("status", ["superseded", "deleted"]);
  if (staleSourceError) throw new Error(`구형 screening 원본 조회 실패: ${staleSourceError.message}`);
  removed["staleScreeningSources"] = (
    await removePaths((staleSources ?? []).map((row) => String(row.storage_path ?? "")))
  ).objects;

  // 2) 브라우저 백테스트용 canonical JSON 사본은 더 이상 사용하지 않는다.
  // Actions는 analysis_source_files의 active raw source만 읽는다.
  const { data: legacyBacktest, error: legacyBacktestError } = await client.storage
    .from(ANALYSIS_BUCKET)
    .list(`${userId}/backtest`, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (legacyBacktestError)
    throw new Error(`legacy backtest 목록 조회 실패: ${legacyBacktestError.message}`);
  const legacyBacktestPaths = (legacyBacktest ?? [])
    .filter((entry) => entry.name.endsWith(".json"))
    .map((entry) => `${userId}/backtest/${entry.name}`);
  removed["legacyBacktestCanonical"] = (await removePaths(legacyBacktestPaths)).objects;

  // 3) 과거 브라우저 백테스트 실행 bundle도 제거한다. Actions 결과(results/backtest)는 유지한다.
  const { data: webBacktestRuns, error: webBacktestError } = await client
    .from("analysis_runs")
    .select("id,result_path")
    .eq("user_id", userId)
    .eq("kind", "BACKTEST")
    .like("result_path", `${userId}/backtest/runs/%`);
  if (webBacktestError) throw new Error(`웹 백테스트 실행 조회 실패: ${webBacktestError.message}`);
  const { data: webRunObjects, error: webRunObjectError } = await client.storage
    .from(ANALYSIS_BUCKET)
    .list(`${userId}/backtest/runs`, { limit: 1000 });
  if (webRunObjectError) throw new Error(`웹 백테스트 bundle 조회 실패: ${webRunObjectError.message}`);
  removed["legacyWebBacktestRuns"] = (
    await removePaths(
      (webRunObjects ?? [])
        .filter((entry) => entry.name.endsWith(".json"))
        .map((entry) => `${userId}/backtest/runs/${entry.name}`),
    )
  ).objects;
  const webRunIds = (webBacktestRuns ?? []).map((row) => String(row.id));
  if (webRunIds.length > 0) {
    const { error } = await client.from("analysis_runs").delete().in("id", webRunIds);
    if (error) throw new Error(`웹 백테스트 metadata 정리 실패: ${error.message}`);
  }

  // 4) screening 상세 bundle은 최신 실행 1건만 보존한다.
  // screening_history와 latest.json은 별도로 유지된다.
  const { data: screeningRuns, error: screeningRunsError } = await client
    .from("analysis_runs")
    .select("id,result_path,created_at")
    .eq("user_id", userId)
    .eq("kind", "SCREENING")
    .eq("status", "COMPLETED")
    .order("created_at", { ascending: false });
  if (screeningRunsError) throw new Error(`screening 실행 목록 조회 실패: ${screeningRunsError.message}`);
  const oldScreeningRuns = (screeningRuns ?? []).slice(1);
  removed["oldScreeningRunBundles"] = (
    await removePaths(oldScreeningRuns.map((row) => String(row.result_path ?? "")))
  ).objects;
  const oldScreeningIds = oldScreeningRuns.map((row) => String(row.id));
  if (oldScreeningIds.length > 0) {
    const { error } = await client.from("analysis_runs").delete().in("id", oldScreeningIds);
    if (error) throw new Error(`구형 screening metadata 정리 실패: ${error.message}`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        bucket: ANALYSIS_BUCKET,
        userId,
        removed,
        preserved: [
          "active screening source",
          "active backtest raw sources",
          "results/backtest GitHub Actions bundles",
          "strict 3-FOS research results",
          "screening_history",
          "results/screening/latest.json",
        ],
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
