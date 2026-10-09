import { usHistorySnapshot } from "./usScreeningHistory";
import { supabase, userId } from "./cloud";
import { hydrateScreeningSnapshot } from "./screeningSnapshotStorage";
import type { ScreeningSnapshot } from "./screeningSnapshot";

export async function listScreeningArchive(date?: string): Promise<ScreeningSnapshot[]> {
  const uid = await userId();
  let runQuery = supabase
    .from("screening_run_archive")
    .select("run_id,date,market,strategy_version,calculated_at,created_at")
    .eq("user_id", uid);
  let dailyQuery = supabase
    .from("screening_history")
    .select("date,savedAt:snapshot->>savedAt,strategyVersion:snapshot->>strategyVersion")
    .eq("user_id", uid);
  let usQuery = supabase
    .from("us_screening_history")
    .select("date,data_hash,rule_version,created_at")
    .eq("user_id", uid);
  if (date) {
    runQuery = runQuery.eq("date", date);
    dailyQuery = dailyQuery.eq("date", date);
    usQuery = usQuery.eq("date", date);
  }
  const [runs, daily, us] = await Promise.all([
    runQuery.order("calculated_at", { ascending: false }).limit(90),
    dailyQuery.order("date", { ascending: false }).limit(90),
    usQuery.order("date", { ascending: false }).limit(90),
  ]);
  if (runs.error || daily.error || us.error)
    throw new Error(runs.error?.message ?? daily.error?.message ?? us.error!.message);
  const base = {
    marketGateStatus: "",
    totalCount: 0,
    passedCount: 0,
    gradeACount: 0,
    gradeBCount: 0,
    entries: [],
  };
  const all: ScreeningSnapshot[] = (runs.data ?? []).map((r) => ({
    ...base,
    runId: r.run_id,
    date: r.date,
    asOfDate: r.date,
    savedAt: r.calculated_at,
    storedAt: r.created_at,
    market: r.market,
    strategyVersion: r.strategy_version,
  }));
  for (const row of daily.data ?? []) {
    const s: ScreeningSnapshot = {
      ...base,
      date: row.date,
      asOfDate: row.date,
      savedAt: row.savedAt,
      ...(row.strategyVersion ? { strategyVersion: row.strategyVersion } : {}),
    };
    if (
      !all.some(
        (r) =>
          r.market !== "US" &&
          r.asOfDate === s.asOfDate &&
          Date.parse(r.savedAt) === Date.parse(s.savedAt),
      )
    )
      all.push(s);
  }
  all.push(...(us.data ?? []).map(usHistorySnapshot));
  return all.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
export async function readScreeningArchive(
  runId: string,
  date: string,
  savedAt: string,
  identity: {
    market?: string | undefined;
    strategyVersion?: string | undefined;
    dataHash?: string | undefined;
  } = {},
): Promise<ScreeningSnapshot> {
  const uid = await userId();
  if (!runId && identity.market === "US") {
    const { data, error } = await supabase
      .from("us_screening_history")
      .select("date,data_hash,rule_version,created_at,signals")
      .eq("user_id", uid)
      .eq("date", date)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("요청한 과거 실행 기록이 없습니다.");
    if (
      Date.parse(data.created_at) !== Date.parse(savedAt) ||
      (identity.strategyVersion && data.rule_version !== identity.strategyVersion) ||
      (identity.dataHash && data.data_hash !== identity.dataHash)
    )
      throw new Error("요청한 기록과 저장된 실행이 다릅니다. 최신 결과로 대체하지 않습니다.");
    return usHistorySnapshot(data);
  }
  const query = runId
    ? supabase
        .from("screening_run_archive")
        .select("snapshot,created_at")
        .eq("user_id", uid)
        .eq("run_id", runId)
    : supabase.from("screening_history").select("snapshot").eq("user_id", uid).eq("date", date);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("요청한 과거 실행 기록이 없습니다.");
  const snapshot = hydrateScreeningSnapshot(data.snapshot);
  if (
    snapshot.asOfDate !== date ||
    Date.parse(snapshot.savedAt) !== Date.parse(savedAt) ||
    (runId && snapshot.runId !== runId) ||
    (identity.market && (snapshot.market ?? "KR") !== identity.market) ||
    (identity.strategyVersion && snapshot.strategyVersion !== identity.strategyVersion) ||
    (identity.dataHash && snapshot.dataHash !== identity.dataHash)
  )
    throw new Error("요청한 기록과 저장된 실행이 다릅니다. 최신 결과로 대체하지 않습니다.");
  return "created_at" in data && typeof data.created_at === "string"
    ? { ...snapshot, storedAt: data.created_at }
    : snapshot;
}
