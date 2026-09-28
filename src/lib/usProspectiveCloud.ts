import { ownerPath, readObject, supabase, userId } from "@/lib/cloud";

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
  state: Record<string, unknown>;
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
  return readObject<UsProspectiveCache>(await ownerPath("cache/us-screening/latest.json"));
}

export async function loadUsScreeningHistory(limit = 370) {
  const uid = await userId();
  const { data, error } = await supabase
    .from("us_screening_history")
    .select("date,data_hash,rule_version,summary,signals,created_at")
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
  const { data, error } = await supabase
    .from("us_portfolio_snapshots")
    .select("*")
    .eq("user_id", uid)
    .order("date", { ascending: false })
    .limit(limitPerStrategy * 4);
  if (error) throw new Error(`US 포트폴리오 조회 실패: ${error.message}`);
  return (data ?? []) as UsPortfolioSnapshotRecord[];
}

export async function loadUsPortfolioTrades(limit = 500) {
  const uid = await userId();
  const { data, error } = await supabase
    .from("us_portfolio_trades")
    .select("*")
    .eq("user_id", uid)
    .order("signal_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`US 거래 원장 조회 실패: ${error.message}`);
  return (data ?? []) as UsPortfolioTradeRecord[];
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
