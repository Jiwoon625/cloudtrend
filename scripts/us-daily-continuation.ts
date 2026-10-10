/** Same-input, resumable ordinary publication after a verified reconstructed predecessor.
 * This uses the existing four-book transactional operating RPC and immutable Shadow
 * preparations. It never fabricates the predecessor's missing screening history.
 */
import {
  ANALYSIS_BUCKET,
  stableJson,
  uploadJson,
  type trustedSupabaseClient,
} from "./analysis-run-store";
import { bytesHash } from "./us-replay-source";
import {
  planUsOperatingReplay,
  type UsOperatingRegistry,
  type UsOperatingSnapshot,
  type UsOperatingTrade,
  type UsOperatingStrategyId,
  US_OPERATING_STRATEGY_IDS,
} from "./us-operating-replay";
import { planUsShadowReplay, commitUsShadowReplay } from "./us-shadow-replay-plan";
import { octoberShadowStore } from "../src/lib/ledger/octoberShadowRepository.server";
import {
  US_PROSPECTIVE_RULE_VERSION,
  usProspectiveCompactSignals,
  type UsProspectiveInputRow,
  type UsProspectivePreviousState,
} from "../src/lib/engine/usProspective";
import { compactRow, publishBrowserViews } from "./us-screening-publication";
import { regularCloseAt } from "../src/lib/ledger/octoberShadowCalendar";

type Client = ReturnType<typeof trustedSupabaseClient>;
export interface UsDailyIngest {
  as_of_date: string;
  data_hash: string;
  storage_bucket: string;
  storage_path: string;
  row_count: number;
  symbol_count: number;
  collected_at: string;
  source_provider?: string;
  schema_version?: string;
  metadata: Record<string, unknown>;
}
interface PlanPayload {
  version: "us-daily-continuation-v1";
  input: UsDailyIngest;
  reconstructionManifestHash: string;
  calculatedAt: string;
  operating: ReturnType<typeof planUsOperatingReplay>;
  shadow: Awaited<ReturnType<typeof planUsShadowReplay>>;
}
export interface UsDailyContinuationPlan extends PlanPayload {
  planHash: string;
}
function identity(ingest: UsDailyIngest): UsDailyIngest {
  return JSON.parse(
    JSON.stringify({
      as_of_date: ingest.as_of_date,
      data_hash: ingest.data_hash,
      storage_bucket: ingest.storage_bucket,
      storage_path: ingest.storage_path,
      row_count: ingest.row_count,
      symbol_count: ingest.symbol_count,
      collected_at: ingest.collected_at,
      source_provider: ingest.source_provider,
      schema_version: ingest.schema_version,
      metadata: ingest.metadata,
    }),
  );
}
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
async function read(client: Client, path: string) {
  const latest = path.endsWith("/latest.json");
  const { data, error } = await client.storage
    .from(ANALYSIS_BUCKET)
    .download(
      path,
      latest ? { cacheNonce: crypto.randomUUID() } : undefined,
      latest ? { cache: "no-store" } : undefined,
    );
  if (error) {
    if (/not.?found|404|Object not found/i.test(error.message)) return null;
    throw new Error("US continuation evidence unavailable");
  }
  return JSON.parse(await data.text());
}
async function immutable(client: Client, path: string, value: unknown) {
  const body = stableJson(value);
  await client.storage
    .from(ANALYSIS_BUCKET)
    .upload(path, body, { contentType: "application/json", upsert: false });
  if (!same(await read(client, path), value))
    throw new Error("Immutable US continuation artifact conflict");
}
async function query<T>(
  q: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await q;
  if (error || data === null) throw new Error("US continuation model evidence read failed");
  return data;
}
const planPath = (userId: string, date: string) =>
  `${userId}/results/us-continuation/${date}.plan.json`;
export async function loadUsDailyContinuation(
  client: Client,
  userId: string,
  ingest: UsDailyIngest,
) {
  const value = (await read(
    client,
    planPath(userId, ingest.as_of_date),
  )) as UsDailyContinuationPlan | null;
  if (!value) return null;
  const { planHash, ...payload } = value;
  if (
    value.version !== "us-daily-continuation-v1" ||
    bytesHash(stableJson(payload)) !== planHash ||
    !same(value.input, identity(ingest)) ||
    value.operating?.throughDate !== ingest.as_of_date ||
    value.shadow?.analyses?.length !== 1 ||
    value.shadow.analyses[0]?.date !== ingest.as_of_date
  )
    throw new Error("Immutable US continuation input/plan conflict");
  return value;
}

export async function runUsDailyContinuation(input: {
  client: Client;
  userId: string;
  ingest: UsDailyIngest;
  rows: UsProspectiveInputRow[];
  reconstruction: { manifestHash: string; analysis: { state: UsProspectivePreviousState } };
  saved: UsDailyContinuationPlan | null;
  /** Rechecks unchanged ingest, protected reconstruction and exact allowed successor heads. */
  admit: (plan: UsDailyContinuationPlan) => Promise<void>;
}) {
  const { client, userId, ingest, saved } = input;
  const date = ingest.as_of_date,
    previousDate = String(ingest.metadata["previousSessionDate"]);
  if (saved && saved.reconstructionManifestHash !== input.reconstruction.manifestHash)
    throw new Error("US continuation predecessor identity changed");
  const calculatedAt = saved?.calculatedAt ?? new Date().toISOString();
  const captured = Date.parse(ingest.collected_at);
  if (
    !Number.isFinite(Date.parse(calculatedAt)) ||
    !Number.isFinite(captured) ||
    captured > Date.parse(calculatedAt) ||
    captured < Date.parse(regularCloseAt("US", date))
  )
    throw new Error(
      "US continuation requires a valid post-close source captured by its calculation time",
    );
  const store = octoberShadowStore(client, userId, "service");
  const shadow = await planUsShadowReplay({
    store,
    baseDate: previousDate,
    previousRankState: input.reconstruction.analysis.state,
    sessions: [
      {
        rows: input.rows,
        source: {
          date,
          previousSessionDate: previousDate,
          dataHash: ingest.data_hash,
          sourceCapturedAt: ingest.collected_at,
        },
      },
    ],
    calculatedAt,
  });
  const registries = await query<UsOperatingRegistry[]>(
    client
      .from("us_strategy_registry")
      .select("strategy_id,label,role,rule_version,config,active")
      .eq("user_id", userId)
      .in("strategy_id", [...US_OPERATING_STRATEGY_IDS]),
  );
  const snapshots = await query<UsOperatingSnapshot[]>(
    client
      .from("us_portfolio_snapshots")
      .select(
        "strategy_id,date,rule_version,nav_usd,cash_usd,benchmark_nav,daily_return,cumulative_return,turnover,fees_usd,positions_count,state",
      )
      .eq("user_id", userId)
      .eq("date", previousDate)
      .in("strategy_id", [...US_OPERATING_STRATEGY_IDS]),
  );
  const trades =
    saved?.operating.expectedPendingTrades ??
    (await query<UsOperatingTrade[]>(
      client
        .from("us_portfolio_trades")
        .select(
          "trade_key,strategy_id,signal_date,execution_date,symbol,name,sector,side,reason,status,model_price,model_shares,model_notional,fee_usd,core_rank,detail",
        )
        .eq("user_id", userId)
        .eq("status", "PENDING")
        .in(
          "strategy_id",
          US_OPERATING_STRATEGY_IDS.filter((id) => id !== "SPY_BENCHMARK"),
        ),
    ));
  const operating = planUsOperatingReplay({
    dates: [
      {
        analysis: shadow.analyses[0]!,
        previousSessionDate: previousDate,
        sourceHash: ingest.data_hash,
      },
    ],
    priorSnapshots: Object.fromEntries(snapshots.map((s) => [s.strategy_id, s])) as Record<
      UsOperatingStrategyId,
      UsOperatingSnapshot
    >,
    registries,
    existingTrades: trades,
  });
  const payload: PlanPayload = {
    version: "us-daily-continuation-v1",
    input: identity(ingest),
    reconstructionManifestHash: input.reconstruction.manifestHash,
    calculatedAt,
    operating,
    shadow,
  };
  const plan: UsDailyContinuationPlan = { ...payload, planHash: bytesHash(stableJson(payload)) };
  if (saved && !same(saved, plan))
    throw new Error("US continuation recalculation differs from immutable plan");
  const analysis = shadow.analyses[0]!;
  const result = {
    generatedAt: calculatedAt,
    dataHash: ingest.data_hash,
    source: {
      provider: ingest.source_provider,
      collectedAt: ingest.collected_at,
      schemaVersion: ingest.schema_version,
      metadata: ingest.metadata,
    },
    analysis: {
      date,
      ruleVersion: analysis.ruleVersion,
      summary: analysis.summary,
      state: analysis.state,
      rows: analysis.rows.map(compactRow),
    },
  };
  const manifest = { dataHash: ingest.data_hash, ruleVersion: US_PROSPECTIVE_RULE_VERSION };
  const resultPrefix = `${userId}/results/us-screening/${date}`;
  for (const [suffix, expected] of [
    [".manifest.json", manifest],
    [".json", result],
  ] as const) {
    const old = await read(client, resultPrefix + suffix);
    if (old && !same(old, expected))
      throw new Error("US date input is locked; immutable continuation publication conflicts");
  }
  const receipt = {
    version: "us-daily-continuation-receipt-v1",
    planHash: plan.planHash,
    operatingPlanHash: operating.planHash,
    date,
    dataHash: ingest.data_hash,
    applied: true,
    shadowStateHashes: shadow.prepared.map((p) => ({
      date: p.date,
      records: p.entries.map((e) => ({ bookId: e.series.bookId, stateHash: e.run.stateHash })),
    })),
  };
  const receiptPath = `${userId}/results/us-continuation/${date}.receipt.json`;
  const oldReceipt = await read(client, receiptPath);
  if (oldReceipt && !same(oldReceipt, receipt))
    throw new Error("Immutable US continuation receipt conflict");
  const assertCache = async () => {
    const latest = await read(client, `${userId}/cache/us-screening/latest.json`);
    if (
      latest &&
      (typeof latest.analysis?.date !== "string" ||
        latest.analysis.date > date ||
        (latest.analysis.date === date && latest.dataHash !== ingest.data_hash))
    )
      throw new Error(
        "US continuation cannot replace a malformed, conflicting or newer latest cache",
      );
  };
  await assertCache();
  const { data: validated, error: validationError } = await client.rpc(
    "apply_us_operating_replay",
    {
      p_user_id: userId,
      p_plan: operating,
      p_apply: false,
    },
  );
  if (
    validationError ||
    validated?.validated !== true ||
    validated?.planHash !== operating.planHash ||
    validated?.baseDate !== previousDate ||
    validated?.throughDate !== date
  )
    throw new Error("US continuation operating preflight failed");
  // No model writes precede the immutable, fully recalculated target plan and date lock.
  await immutable(client, planPath(userId, date), plan);
  await immutable(client, `${resultPrefix}.manifest.json`, manifest);
  await input.admit(plan);
  await commitUsShadowReplay(store, shadow);
  const { data: applied, error } = await client.rpc("apply_us_operating_replay", {
    p_user_id: userId,
    p_plan: operating,
    p_apply: true,
  });
  if (
    error ||
    applied?.version !== "us-operating-replay-v1" ||
    applied?.planHash !== operating.planHash ||
    applied?.baseDate !== previousDate ||
    applied?.throughDate !== date ||
    applied?.snapshotsInserted !== operating.snapshots.length ||
    applied?.tradesInserted !== operating.trades.length ||
    applied?.pendingResolved !== operating.pendingResolutions.length
  )
    throw new Error("US continuation operating commit was not acknowledged; retry the same input");
  await immutable(client, receiptPath, receipt);
  // A newer ingest/history must not be rolled back while publishing the completed plan.
  const latest = await query<UsDailyIngest[]>(
    client.from("us_screening_ingest").select("*").eq("user_id", userId),
  );
  if (latest.length !== 1 || !same(identity(latest[0]!), identity(ingest)))
    throw new Error("US continuation ingest changed before publication");
  const markers = await query<Array<{ date: string; data_hash: string; rule_version: string }>>(
    client
      .from("us_screening_history")
      .select("date,data_hash,rule_version")
      .eq("user_id", userId)
      .order("date", { ascending: false })
      .limit(1),
  );
  if (markers[0] && markers[0].date >= date)
    throw new Error("US continuation history advanced before publication");
  await assertCache();
  await immutable(client, `${resultPrefix}.json`, result);
  const { error: historyError } = await client.from("us_screening_history").insert({
    user_id: userId,
    date,
    data_hash: ingest.data_hash,
    rule_version: US_PROSPECTIVE_RULE_VERSION,
    summary: analysis.summary,
    signals: usProspectiveCompactSignals(analysis),
  });
  if (historyError) throw historyError;
  await uploadJson(client, `${userId}/cache/us-screening/latest.json`, result);
  await publishBrowserViews(client, userId, result);
}
