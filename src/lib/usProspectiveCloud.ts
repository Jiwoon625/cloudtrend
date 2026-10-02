import { usBrowserViews, type UsProspectiveSummary } from "./usBrowserViews";
import { usOrderPreviewsServer } from "./usOrderPreview.functions";
import type { UsOrderPreviewBundle } from "./engine/usProspectiveOrderPreview";
import { ownerPath, readObject, readBinaryObject, supabase, userId } from "@/lib/cloud";

export interface UsProspectiveCacheRow {
  date: string;
  symbol: string;
  name: string;
  market: string | null;
  sector: string | null;
  status: string | null;
  open: number | null;
  close: number | null;
  ret120: number | null;
  ret252: number | null;
  ret120Rank: number | null;
  ret252Rank: number | null;
  coreRank: number | null;
  betaRank: number | null;
  tkRank: number | null;
  relvolRank: number | null;
  liquidityRank: number | null;
  amihudRank: number | null;
  adv20Usd: number | null;
  marketCap: number | null;
  onset80: boolean;
  a0Entry: boolean;
  a0Exit: boolean;
  a0BetaExit: boolean;
  a2Entry: boolean;
  a2Exit: boolean;
  b3Entry: boolean;
  b3Exit: boolean;
  b3BetaExit: boolean;
  betaWeakStreak: number;
  primarySignal: "ENTRY" | "EXIT" | "WATCH" | "NONE";
}

export interface UsProspectiveCache {
  generatedAt: string;
  dataHash: string;
  source: {
    provider: string;
    collectedAt: string;
    schemaVersion: string;
    metadata: Record<string, unknown>;
  };
  analysis: {
    date: string;
    ruleVersion: string;
    summary: Record<string, number | null>;
    rows: UsProspectiveCacheRow[];
  };
}

export interface UsPortfolioSnapshotRecord {
  strategy_id: string;
  date: string;
  rule_version: string;
  nav_usd: number;
  cash_usd: number;
  benchmark_nav: number | null;
  daily_return: number | null;
  cumulative_return: number | null;
  turnover: number;
  fees_usd: number;
  positions_count: number;
  state: Record<string, unknown> & {
    orderPreview?: UsOrderPreviewBundle | null;
    orderPreviewError?: string | null;
  };
}

export interface UsPortfolioTradeRecord {
  trade_key: string;
  strategy_id: string;
  signal_date: string;
  execution_date: string | null;
  symbol: string;
  name: string | null;
  sector: string | null;
  side: string;
  reason: string;
  status: string;
  model_price: number | null;
  model_shares: number | null;
  model_notional: number | null;
  fee_usd: number;
  core_rank: number | null;
  actual_price: number | null;
  actual_shares: number | null;
  actual_fee_usd: number | null;
  detail: Record<string, unknown>;
}

export async function loadUsProspectiveCache() {
  const bytes = await readBinaryObject(await ownerPath("cache/us-screening/view-v1.json.gz"));
  if (bytes) {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text()) as UsProspectiveCache;
  }
  return readObject<UsProspectiveCache>(await ownerPath("cache/us-screening/latest.json"));
}

export async function loadUsProspectiveSummary() {
  const summary = await readObject<UsProspectiveSummary>(
    await ownerPath("cache/us-screening/summary-v1.json"),
  );
  if (summary) return summary;
  const legacy = await loadUsProspectiveCache();
  return legacy ? usBrowserViews(legacy).summary : null;
}

export async function loadUsScreeningHistory(limit = 370) {
  const uid = await userId();
  const { data, error } = await supabase
    .from("us_screening_history")
    .select("date,data_hash,rule_version")
    .eq("user_id", uid)
    .order("date", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`US 스크리닝 이력 조회 실패: ${error.message}`);
  return data ?? [];
}

export async function loadUsStrategyRegistry() {
  const uid = await userId();
  const { data, error } = await supabase
    .from("us_strategy_registry")
    .select("*")
    .eq("user_id", uid)
    .eq("active", true)
    .order("role", { ascending: true });
  if (error) throw new Error(`US 전략 정의 조회 실패: ${error.message}`);
  return data ?? [];
}

export async function loadUsPortfolioSnapshots(limitPerStrategy = 370) {
  const uid = await userId();
  // Separate strategies avoid the REST row cap truncating a one-year, four-strategy chart.
  const results = await Promise.all(
    ["A0_QUARTER_PRIMARY", "A2_QUARTER_SHADOW", "B3_BETA_SHADOW", "SPY_BENCHMARK"].map((strategy) =>
      supabase
        .from("us_portfolio_snapshots")
        .select(
          "strategy_id,date,rule_version,nav_usd,cash_usd,benchmark_nav,daily_return,cumulative_return,turnover,fees_usd,positions_count",
        )
        .eq("user_id", uid)
        .eq("strategy_id", strategy)
        .order("date", { ascending: false })
        .limit(Math.min(limitPerStrategy, 1000)),
    ),
  );
  for (const result of results)
    if (result.error) throw new Error(`US 포트폴리오 조회 실패: ${result.error.message}`);
  const latest = await Promise.all(
    results.map(async (result) => {
      const row = result.data?.[0];
      if (!row) return null;
      const { data, error } = await supabase
        .from("us_portfolio_snapshots")
        .select("positions:state->positions,initialCapital:state->initialCapital")
        .eq("user_id", uid)
        .eq("strategy_id", row.strategy_id)
        .eq("date", row.date)
        .single();
      if (error) throw new Error(`US 보유종목 조회 실패: ${error.message}`);
      return data;
    }),
  );
  // Preview failure is independent of holdings. The endpoint authenticates with
  // getUser and returns only compact previews, never full saved engine state.
  const requests = results.flatMap((result) => {
    const row = result.data?.[0];
    return row && row.strategy_id !== "SPY_BENCHMARK"
      ? [{ strategyId: row.strategy_id, sourceDate: row.date }]
      : [];
  });
  const previews = new Map<
    string,
    { preview: UsOrderPreviewBundle | null; error: string | null }
  >();
  if (requests.length) {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) throw new Error("로그인 세션을 확인해 주세요.");
      const response = await usOrderPreviewsServer({
        data: { accessToken: data.session.access_token, requests },
      });
      for (const request of requests) {
        const result = response.find((item) => item.strategyId === request.strategyId);
        if (
          !result ||
          result.sourceDate !== request.sourceDate ||
          (result.preview && result.preview.sourceDate !== request.sourceDate)
        ) {
          previews.set(request.strategyId, {
            preview: null,
            error: "미국 모형 스냅샷이 갱신 중입니다. 새로고침해 주세요.",
          });
          continue;
        }
        previews.set(request.strategyId, {
          preview: result.error ? null : result.preview,
          error: result.error ?? (!result.preview ? "저장된 미국 주문 미리보기가 없습니다." : null),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "미국 주문 미리보기 조회 실패";
      for (const request of requests)
        previews.set(request.strategyId, { preview: null, error: message });
    }
  }
  return results
    .flatMap((result, index) =>
      (result.data ?? []).map((row, rowIndex) => ({
        ...row,
        state:
          rowIndex === 0
            ? {
                positions: latest[index]?.positions ?? [],
                initialCapital: latest[index]?.initialCapital ?? null,
                ...(row.strategy_id !== "SPY_BENCHMARK"
                  ? {
                      orderPreview: previews.get(row.strategy_id)?.preview ?? null,
                      orderPreviewError: previews.get(row.strategy_id)?.error ?? null,
                    }
                  : {}),
              }
            : {},
      })),
    )
    .sort((a, b) => b.date.localeCompare(a.date)) as UsPortfolioSnapshotRecord[];
}

export async function loadUsPortfolioTrades(limit = 500) {
  const uid = await userId();
  const results = await Promise.all([
    supabase
      .from("us_portfolio_trades")
      .select("*")
      .eq("user_id", uid)
      .eq("status", "PENDING")
      .order("signal_date", { ascending: false })
      .limit(1000),
    supabase
      .from("us_portfolio_trades")
      .select("*")
      .eq("user_id", uid)
      .in("status", ["EXECUTED", "PARTIAL"])
      .order("execution_date", { ascending: false })
      .order("trade_key", { ascending: true })
      .limit(Math.min(limit, 1000)),
  ]);
  for (const result of results)
    if (result.error) throw new Error(`US 거래 원장 조회 실패: ${result.error.message}`);
  return results.flatMap((result) => result.data ?? []) as UsPortfolioTradeRecord[];
}

export async function saveUsActualExecution(
  tradeKey: string,
  values: { actualPrice: number | null; actualShares: number | null; actualFeeUsd: number | null },
) {
  const uid = await userId();
  const { data, error } = await supabase
    .from("us_portfolio_trades")
    .update({
      actual_price: values.actualPrice,
      actual_shares: values.actualShares,
      actual_fee_usd: values.actualFeeUsd,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", uid)
    .eq("trade_key", tradeKey)
    .eq("strategy_id", "A0_QUARTER_PRIMARY")
    .in("status", ["EXECUTED", "PARTIAL"])
    .select("trade_key")
    .single();
  if (error) throw new Error(`US 실제 체결 저장 실패: ${error.message}`);
  if (!data) throw new Error("수정 가능한 A0 체결 기록을 찾지 못했습니다.");
}
