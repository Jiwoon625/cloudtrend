import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildUsModelTaxProjection,
  type UsModelTaxProjection,
} from "./engine/usModelTaxProjection";
import { US_PROSPECTIVE_STRATEGIES } from "./engine/usProspectivePortfolio";

type SourceProof = {
  date: string;
  dataHash: string;
  ruleVersion: string;
  previousSessionDate: string | null;
  confirmedRegularClose: true;
  failedSymbols: 0;
};
type ProofCache = Map<string, Promise<SourceProof>>;
// Only compact immutable proof metadata is cached, never full source rows or access tokens.
const authenticatedProofCache: ProofCache = new Map();
let freeProofSlots = 4;
const proofWaiters: Array<() => void> = [];
async function withProofSlot<T>(read: () => Promise<T>): Promise<T> {
  if (freeProofSlots > 0) freeProofSlots--;
  else await new Promise<void>((resolve) => proofWaiters.push(resolve));
  try {
    return await read();
  } finally {
    const next = proofWaiters.shift();
    if (next) next();
    else freeProofSlots++;
  }
}
async function readSourceProof(
  client: SupabaseClient,
  uid: string,
  marker: { date: string; data_hash: string; rule_version: string },
  cache: ProofCache,
): Promise<SourceProof> {
  const key = `${uid}:${marker.date}:${marker.data_hash}:${marker.rule_version}`;
  const saved = cache.get(key);
  if (saved) return saved;
  const pending = withProofSlot(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const { data, error } = await client.storage
        .from("cloudtrend-data")
        .download(
          `${uid}/results/us-screening/${marker.date}.json`,
          {},
          { signal: controller.signal },
        );
      if (error || !data)
        throw new Error(`동결 모델 입력 ${marker.date}의 거래일 연결을 확인할 수 없습니다.`);
      if (data.size > 10_000_000)
        throw new Error("동결 모델 입력이 검증 크기 한도를 초과했습니다.");
      const raw: unknown = JSON.parse(await data.text());
      if (!raw || typeof raw !== "object") throw new Error("동결 모델 입력 형식 확인 필요");
      const result = raw as {
        dataHash?: unknown;
        analysis?: { date?: unknown; ruleVersion?: unknown };
        source?: {
          metadata?: {
            previousSessionDate?: unknown;
            confirmedRegularClose?: unknown;
            failedSymbols?: unknown;
          };
        };
      };
      const previous = result.source?.metadata?.previousSessionDate;
      if (
        result.analysis?.date !== marker.date ||
        result.analysis?.ruleVersion !== marker.rule_version ||
        result.dataHash !== marker.data_hash ||
        result.source?.metadata?.confirmedRegularClose !== true ||
        result.source?.metadata?.failedSymbols !== 0 ||
        (previous != null && typeof previous !== "string")
      )
        throw new Error(`동결 모델 입력 ${marker.date}의 해시·기준일·완료 증거가 다릅니다.`);
      return {
        date: marker.date,
        dataHash: marker.data_hash,
        ruleVersion: marker.rule_version,
        previousSessionDate: typeof previous === "string" ? previous : null,
        confirmedRegularClose: true as const,
        failedSymbols: 0 as const,
      };
    } finally {
      clearTimeout(timer);
    }
  });
  cache.set(key, pending);
  if (cache.size > 512) cache.delete(cache.keys().next().value!);
  try {
    return await pending;
  } catch (error) {
    if (cache.get(key) === pending) cache.delete(key);
    throw error;
  }
}

export interface UsModelTaxRequest {
  strategyId: string;
  sourceDate: string;
}
/** Read-only full-history projection. No upsert, source collection, credentials or frozen-state writes. */
export async function loadUsModelTaxProjection(
  client: SupabaseClient,
  uid: string,
  request: UsModelTaxRequest,
  proofCache: ProofCache = new Map(),
): Promise<UsModelTaxProjection> {
  const { strategyId, sourceDate } = request;
  if (
    !uid ||
    !US_PROSPECTIVE_STRATEGIES.some((c) => c.id === strategyId) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)
  )
    throw new Error("미국 세금 모형의 소유자·전략·기준일 확인 필요");
  const { data: registry, error } = await client
    .from("us_strategy_registry")
    .select("strategy_id,rule_version,config,frozen_at")
    .eq("user_id", uid)
    .eq("strategy_id", strategyId)
    .maybeSingle();
  if (error) throw new Error(`모델 동결 정의 조회 실패: ${error.message}`);
  if (!registry) throw new Error("동결된 모델 정의가 없어 세금 추정 불가");
  const snapshots: unknown[] = [],
    trades: unknown[] = [],
    completed: unknown[] = [];
  // Page until exhaustion. Reaching a safety cap is an error, never a claim of full coverage.
  for (const table of [
    "us_portfolio_snapshots",
    "us_portfolio_trades",
    "us_screening_history",
  ] as const) {
    const destination =
      table === "us_portfolio_snapshots"
        ? snapshots
        : table === "us_portfolio_trades"
          ? trades
          : completed;
    for (let start = 0; ; start += 500) {
      if (start >= 50000)
        throw new Error("모델 전체 이력 검증 한도 초과: 부분 원장으로 세금을 계산하지 않습니다.");
      let q = client
        .from(table)
        .select(
          table === "us_portfolio_snapshots"
            ? "strategy_id,date,rule_version,nav_usd,cash_usd,fees_usd,initializedDate:state->initializedDate,initialCapital:state->initialCapital,lastDate:state->lastDate,modelCash:state->cash,positions:state->positions"
            : table === "us_portfolio_trades"
              ? "trade_key,strategy_id,execution_date,symbol,side,status,model_price,model_shares,model_notional,fee_usd"
              : "date,rule_version,data_hash",
        )
        .eq("user_id", uid);
      if (table !== "us_screening_history") q = q.eq("strategy_id", strategyId);
      if (table === "us_portfolio_trades")
        q = q
          .in("status", ["EXECUTED", "PARTIAL"])
          .lte("execution_date", sourceDate)
          .order("execution_date")
          .order("trade_key");
      else q = q.lte("date", sourceDate).order("date");
      const page = await q.range(start, start + 499);
      if (page.error) throw new Error(`모델 전체 이력 조회 실패: ${page.error.message}`);
      const rows = (page.data ?? []) as unknown as Array<Record<string, unknown>>;
      destination.push(
        ...(table === "us_portfolio_snapshots"
          ? rows.map((row) => ({
              ...row,
              state: {
                initializedDate: row["initializedDate"],
                initialCapital: row["initialCapital"],
                lastDate: row["lastDate"],
                cash: row["modelCash"],
                positions: row["positions"],
              },
            }))
          : rows),
      );
      if (!page.data || page.data.length < 500) break;
    }
  }
  // Model registry initialization may post-date other strategies. Match only its verified start.
  const first = snapshots[0] as { state?: { initializedDate?: string } } | undefined;
  const initialized = first?.state?.initializedDate;
  const ownCompleted = initialized
    ? completed.filter((r) => (r as { date: string }).date >= initialized)
    : completed;
  const sourceProofs = await Promise.all(
    ownCompleted.map((row) =>
      readSourceProof(
        client,
        uid,
        row as { date: string; data_hash: string; rule_version: string },
        proofCache,
      ),
    ),
  );
  return buildUsModelTaxProjection({
    strategyId,
    sourceDate,
    registry,
    snapshots,
    trades,
    completed: ownCompleted,
    sourceProofs,
  });
}
export async function loadUsModelTaxProjections(
  accessToken: string,
  requests: UsModelTaxRequest[],
): Promise<UsModelTaxProjection[]> {
  if (!accessToken || requests.length > 3) throw new Error("미국 세금 모형 요청 확인 필요");
  const client = createClient(
    import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co",
    import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
      "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );
  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("로그인 세션을 확인해 주세요.");
  return Promise.all(
    requests.map(async (request) => {
      try {
        return await loadUsModelTaxProjection(
          client,
          data.user.id,
          request,
          authenticatedProofCache,
        );
      } catch (error) {
        return {
          ...request,
          taxEvidence: null,
          taxSource: null,
          missingFields: [error instanceof Error ? error.message : "모델 세금 원천 확인 실패"],
        };
      }
    }),
  );
}
