import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { downloadFreshObject } from "./freshStorage";
import { US_PROSPECTIVE_RULE_VERSION } from "./engine/usProspective";
import { US_PROSPECTIVE_STRATEGIES, type UsPortfolioState } from "./engine/usProspectivePortfolio";
import {
  buildUsOrderPreview,
  isUsOrderPreviewBundle,
  type UsOrderPreviewBundle,
  type UsOrderPreviewQuote,
} from "./engine/usProspectiveOrderPreview";

const BUCKET = "cloudtrend-data";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface UsOrderPreviewRequest {
  strategyId: string;
  sourceDate: string;
}
export interface UsOrderPreviewResponse extends UsOrderPreviewRequest {
  preview: UsOrderPreviewBundle | null;
  error: string | null;
}

/** Only an already authenticated, owner-scoped client may call this helper.
 * The full snapshot stays on the server. No source collection, engine replay,
 * sidecar publishing, or ledger mutation happens on a preview read.
 */
export async function loadUsOrderPreview(
  client: SupabaseClient,
  uid: string,
  strategyId: string,
  expectedDate?: string,
): Promise<UsOrderPreviewBundle | null> {
  if (!uid) throw new Error("로그인 세션을 확인해 주세요.");
  const config = US_PROSPECTIVE_STRATEGIES.find((strategy) => strategy.id === strategyId);
  if (!config) throw new Error("지원하지 않는 미국 모형 전략입니다.");
  if (expectedDate !== undefined && !DATE.test(expectedDate))
    throw new Error("미국 모형 기준일을 확인해 주세요.");
  const { data: snapshot, error } = await client
    .from("us_portfolio_snapshots")
    .select("strategy_id,date,rule_version,state")
    .eq("user_id", uid)
    .eq("strategy_id", strategyId)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`미국 주문 미리보기 스냅샷 조회 실패: ${error.message}`);
  if (!snapshot) throw new Error("저장된 미국 모형 스냅샷이 없습니다.");
  if (
    snapshot.strategy_id !== strategyId ||
    typeof snapshot.date !== "string" ||
    !DATE.test(snapshot.date) ||
    (expectedDate !== undefined && snapshot.date !== expectedDate)
  )
    throw new Error("미국 모형 스냅샷이 갱신 중입니다. 새로고침해 주세요.");
  if (snapshot.rule_version !== US_PROSPECTIVE_RULE_VERSION)
    throw new Error("미국 모형 규칙 버전이 달라 주문 미리보기를 확인할 수 없습니다.");

  // A partial screening run can already have snapshots. The immutable history
  // marker is written only after all model ledgers and the dated result succeed.
  const { data: completed, error: completedError } = await client
    .from("us_screening_history")
    .select("date,rule_version,data_hash")
    .eq("user_id", uid)
    .eq("date", snapshot.date)
    .maybeSingle();
  if (completedError) throw new Error(`미국 스크리닝 완료 확인 실패: ${completedError.message}`);
  if (completed?.date !== snapshot.date || completed.rule_version !== snapshot.rule_version)
    throw new Error("미국 스크리닝이 아직 완료되지 않아 주문 미리보기를 확인할 수 없습니다.");

  const state = snapshot.state as unknown;
  if (!record(state) || state["lastDate"] !== snapshot.date)
    throw new Error("미국 모형 상태의 기준일이 일치하지 않습니다.");
  const saved = state["orderPreview"];
  if (
    isUsOrderPreviewBundle(saved, snapshot.date) &&
    Boolean(saved.nextQuarter) === config.quarterlyRebalance
  )
    return saved;

  // Legacy snapshots are projected from their exact immutable completed result,
  // never mutable latest pointers, the live feed, or another session's quotes.
  const path = `${uid}/results/us-screening/${snapshot.date}.json`;
  const { data, error: sourceError } = await downloadFreshObject(client, BUCKET, path);
  if (sourceError) throw new Error(`저장된 미국 미리보기 가격 조회 실패: ${sourceError.message}`);
  if (!data) throw new Error("저장된 미국 미리보기 가격 자료가 없습니다.");
  const result: unknown = JSON.parse(await data.text());
  if (!record(result) || !completed.data_hash || result["dataHash"] !== completed.data_hash)
    throw new Error("저장된 미국 결과의 데이터 해시가 완료 이력과 일치하지 않습니다.");
  const analysis = record(result) ? result["analysis"] : undefined;
  if (
    !record(analysis) ||
    analysis["date"] !== snapshot.date ||
    analysis["ruleVersion"] !== snapshot.rule_version ||
    !Array.isArray(analysis["rows"])
  )
    throw new Error("저장된 미국 결과의 기준일 또는 규칙 버전이 일치하지 않습니다.");
  const quotes: UsOrderPreviewQuote[] = analysis["rows"]
    .filter(
      (row): row is Record<string, unknown> =>
        record(row) && row["date"] === snapshot.date && typeof row["symbol"] === "string",
    )
    .map((row) => ({
      symbol: row["symbol"] as string,
      name: typeof row["name"] === "string" ? row["name"] : (row["symbol"] as string),
      sector: typeof row["sector"] === "string" ? row["sector"] : null,
      close:
        typeof row["close"] === "number" && Number.isFinite(row["close"]) && row["close"] > 0
          ? row["close"]
          : null,
      date: snapshot.date as string,
    }));
  const preview = buildUsOrderPreview(config, state as unknown as UsPortfolioState, quotes);
  if (!preview || !isUsOrderPreviewBundle(preview, snapshot.date))
    throw new Error("저장된 미국 모형 상태로 주문 미리보기를 만들 수 없습니다.");
  return preview;
}

/** Browser entry point: authenticate once, then isolate each strategy failure. */
export async function loadUsOrderPreviews(
  accessToken: string,
  requests: UsOrderPreviewRequest[],
): Promise<UsOrderPreviewResponse[]> {
  if (typeof accessToken !== "string" || accessToken.length < 20)
    throw new Error("먼저 로그인해 주세요.");
  if (!Array.isArray(requests) || requests.length > US_PROSPECTIVE_STRATEGIES.length)
    throw new Error("미국 모형 미리보기 요청을 확인해 주세요.");
  const client = createClient(
    import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co",
    import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
      "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );
  const { data: auth, error } = await client.auth.getUser(accessToken);
  if (error || !auth.user) throw new Error("로그인 세션을 확인해 주세요.");
  return Promise.all(
    requests.map(async ({ strategyId, sourceDate }) => {
      try {
        const preview = await loadUsOrderPreview(client, auth.user.id, strategyId, sourceDate);
        return { strategyId, sourceDate, preview, error: null };
      } catch (error) {
        return {
          strategyId,
          sourceDate,
          preview: null,
          error: error instanceof Error ? error.message : "미국 주문 미리보기 조회 실패",
        };
      }
    }),
  );
}
