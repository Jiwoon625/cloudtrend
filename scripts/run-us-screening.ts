import { gzipSync } from "node:zlib";
import { usBrowserViews } from "../src/lib/usBrowserViews";
import type { UsProspectiveCache } from "../src/lib/usProspectiveCloud";
import process from "node:process";

import {
  ANALYSIS_BUCKET,
  sha256,
  stableJson,
  trustedSupabaseClient,
  uploadJson,
} from "./analysis-run-store";
import {
  parseUsProspectiveCsv,
  runUsProspectiveAnalysis,
  usProspectiveCompactSignals,
  US_PROSPECTIVE_RULE_VERSION,
  type UsProspectiveAnalysis,
} from "../src/lib/engine/usProspective";
import {
  stepUsProspectivePortfolio,
  US_PROSPECTIVE_STRATEGIES,
  type UsPortfolioState,
} from "../src/lib/engine/usProspectivePortfolio";

async function publishBrowserViews(
  client: ReturnType<typeof trustedSupabaseClient>,
  uid: string,
  result: unknown,
) {
  const views = usBrowserViews(result as UsProspectiveCache);
  const compressed = gzipSync(JSON.stringify(views.screening));
  const { error } = await client.storage
    .from(ANALYSIS_BUCKET)
    .upload(`${uid}/cache/us-screening/view-v1.json.gz`, compressed, {
      upsert: true,
      contentType: "application/gzip",
    });
  if (error) throw error;
  await uploadJson(client, `${uid}/cache/us-screening/summary-v1.json`, views.summary);
}

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function downloadText(client: ReturnType<typeof trustedSupabaseClient>, path: string) {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(path);
  if (error) throw new Error(`US 입력 다운로드 실패 (${path}): ${error.message}`);
  return data.text();
}

async function maybeDownloadJson<T>(
  client: ReturnType<typeof trustedSupabaseClient>,
  path: string,
) {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(path);
  if (error) {
    if (/not.?found|404|Object not found/i.test(error.message)) return null;
    throw new Error(`US 캐시 다운로드 실패 (${path}): ${error.message}`);
  }
  return JSON.parse(await data.text()) as T;
}

function compactRow(row: UsProspectiveAnalysis["rows"][number]) {
  return {
    date: row.date,
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    sector: row.sector,
    status: row.status,
    close: row.close,
    open: row.open,
    ret120: row.ret120,
    ret252: row.ret252,
    ret120Rank: row.ret120Rank,
    ret252Rank: row.ret252Rank,
    coreRank: row.coreRank,
    betaRank: row.betaRank,
    tkRank: row.tkRank,
    relvolRank: row.relvolRank,
    liquidityRank: row.liquidityRank,
    amihudRank: row.amihudRank,
    adv20Usd: row.adv20Usd,
    marketCap: row.marketCap,
    onset80: row.onset80,
    a0Entry: row.a0Entry,
    a0Exit: row.a0Exit,
    a0BetaExit: row.a0BetaExit,
    a2Entry: row.a2Entry,
    a2Exit: row.a2Exit,
    b3Entry: row.b3Entry,
    b3Exit: row.b3Exit,
    b3BetaExit: row.b3BetaExit,
    betaWeakStreak: row.betaWeakStreak,
    primarySignal: row.primarySignal,
  };
}

async function main() {
  const userId = arg("--user") ?? process.env["SUPABASE_USER_ID"];
  if (!userId) throw new Error("--user 또는 SUPABASE_USER_ID가 필요합니다.");
  const client = trustedSupabaseClient();

  const { data: ingest, error: ingestError } = await client
    .from("us_screening_ingest")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (ingestError) throw new Error(`US ingest 조회 실패: ${ingestError.message}`);
  if (!ingest) {
    console.log("No US ingest yet; nothing to process.");
    return;
  }
  if (ingest.storage_bucket !== ANALYSIS_BUCKET) throw new Error("Unexpected US storage bucket");

  const { data: lastHistory, error: lastError } = await client
    .from("us_screening_history")
    .select("date,data_hash,rule_version")
    .eq("user_id", userId)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw lastError;
  if (lastHistory && lastHistory.date > ingest.as_of_date)
    throw new Error("Past US history cannot be replaced");
  if (lastHistory?.date === ingest.as_of_date) {
    if (
      lastHistory.data_hash !== ingest.data_hash ||
      lastHistory.rule_version !== US_PROSPECTIVE_RULE_VERSION
    )
      throw new Error("Completed US date is immutable (hash/rule mismatch)");
    const completed = await maybeDownloadJson<Record<string, unknown>>(
      client,
      `${userId}/results/us-screening/${ingest.as_of_date}.json`,
    );
    if (!completed) throw new Error("Completed US result is missing");
    await uploadJson(client, `${userId}/cache/us-screening/latest.json`, completed);
    await publishBrowserViews(client, userId, completed);
    console.log("US date already completed; portfolio and streak unchanged.");
    return;
  }
  const sourceMetadata = ingest.metadata as {
    previousSessionDate?: string;
    confirmedRegularClose?: boolean;
    failedSymbols?: number;
  };
  if (!sourceMetadata.confirmedRegularClose || sourceMetadata.failedSymbols !== 0)
    throw new Error("US source is not a complete confirmed session");
  if (lastHistory && sourceMetadata.previousSessionDate !== lastHistory.date)
    throw new Error("Missing US session; collect the gap before advancing streak/portfolio");

  const latestCachePath = `${userId}/cache/us-screening/latest.json`;
  // 같은 기준일을 재실행해도 Onset 상태가 바뀌지 않도록, "현재 latest"가 아니라
  // strictly previous trading-date 결과에서만 state를 이어받는다.
  const { data: previousHistory, error: previousHistoryError } = await client
    .from("us_screening_history")
    .select("date")
    .eq("user_id", userId)
    .lt("date", String(ingest.as_of_date))
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previousHistoryError)
    throw new Error(`US 이전 스크리닝 날짜 조회 실패: ${previousHistoryError.message}`);
  const previousResult = previousHistory?.date
    ? await maybeDownloadJson<{
        analysis?: {
          state?: { coreRanks?: Record<string, number>; betaWeakStreak?: Record<string, number> };
        };
      }>(client, `${userId}/results/us-screening/${previousHistory.date}.json`)
    : null;
  if (previousHistory && !previousResult?.analysis?.state)
    throw new Error("Previous US rank state is missing");

  const csv = await downloadText(client, String(ingest.storage_path));
  const actualHash = `sha256:${sha256(Buffer.from(csv, "utf8"))}`;
  if (actualHash !== String(ingest.data_hash))
    throw new Error(`US 입력 해시 불일치: DB ${ingest.data_hash} / Storage ${actualHash}`);
  const parsed = parseUsProspectiveCsv(csv);
  if (
    parsed.length !== ingest.row_count ||
    new Set(parsed.map((r) => r.symbol)).size !== ingest.symbol_count ||
    parsed.some((r) => r.date !== ingest.as_of_date)
  )
    throw new Error("US source row count, symbol count or dates mismatch");
  const analysis = runUsProspectiveAnalysis(parsed, previousResult?.analysis?.state ?? {});
  if (analysis.date !== String(ingest.as_of_date)) {
    throw new Error(`입력 기준일 불일치: DB ${ingest.as_of_date} / CSV ${analysis.date}`);
  }

  // Lock a date's input before any ledger writes, including retries after partial failure.
  const manifestPath = `${userId}/results/us-screening/${analysis.date}.manifest.json`;
  const manifest = { dataHash: ingest.data_hash, ruleVersion: US_PROSPECTIVE_RULE_VERSION };
  const { error: manifestError } = await client.storage
    .from(ANALYSIS_BUCKET)
    .upload(manifestPath, JSON.stringify(manifest), {
      contentType: "application/json",
      upsert: false,
    });
  if (manifestError) {
    const frozenManifest = await maybeDownloadJson<typeof manifest>(client, manifestPath);
    if (!frozenManifest || stableJson(frozenManifest) !== stableJson(manifest))
      throw new Error("US date input is locked; cannot replay with a different input/rule");
  }
  const resultPath = `${userId}/results/us-screening/${analysis.date}.json`;
  const existingResult = await maybeDownloadJson<{
    dataHash: string;
    analysis: { ruleVersion: string };
  }>(client, resultPath);
  if (
    existingResult &&
    (existingResult.dataHash !== ingest.data_hash ||
      existingResult.analysis.ruleVersion !== US_PROSPECTIVE_RULE_VERSION)
  )
    throw new Error("Daily US result is immutable");

  const cachePayload = {
    generatedAt: new Date().toISOString(),
    dataHash: ingest.data_hash,
    source: {
      provider: ingest.source_provider,
      collectedAt: ingest.collected_at,
      schemaVersion: ingest.schema_version,
      metadata: ingest.metadata,
    },
    analysis: {
      date: analysis.date,
      ruleVersion: analysis.ruleVersion,
      summary: analysis.summary,
      state: analysis.state,
      rows: analysis.rows.map(compactRow),
    },
  };
  const historyRecord = {
    user_id: userId,
    date: analysis.date,
    data_hash: ingest.data_hash,
    rule_version: US_PROSPECTIVE_RULE_VERSION,
    summary: analysis.summary,
    signals: usProspectiveCompactSignals(analysis),
  };

  for (const strategy of US_PROSPECTIVE_STRATEGIES) {
    const { data: frozen, error: frozenError } = await client
      .from("us_strategy_registry")
      .select("rule_version,config")
      .eq("user_id", userId)
      .eq("strategy_id", strategy.id)
      .maybeSingle();
    if (frozenError) throw frozenError;
    if (
      frozen &&
      (frozen.rule_version !== US_PROSPECTIVE_RULE_VERSION ||
        stableJson(frozen.config) !== stableJson(strategy))
    )
      throw new Error("Frozen strategy version differs; explicit migration required");
    const { error: registryError } = await client.from("us_strategy_registry").upsert(
      {
        user_id: userId,
        strategy_id: strategy.id,
        label: strategy.label,
        role: strategy.role,
        rule_version: US_PROSPECTIVE_RULE_VERSION,
        config: strategy,
        frozen_at: "2026-09-28T00:00:00+09:00",
        active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,strategy_id" },
    );
    if (registryError) throw new Error(`US 전략 정의 저장 실패: ${registryError.message}`);

    const { data: prev, error: prevError } = await client
      .from("us_portfolio_snapshots")
      .select("*")
      .eq("user_id", userId)
      .eq("strategy_id", strategy.id)
      .lt("date", analysis.date)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prevError) throw new Error(`US 포트폴리오 이전 상태 조회 실패: ${prevError.message}`);
    if (lastHistory && prev?.date !== lastHistory.date)
      throw new Error(`Previous portfolio state is missing: ${strategy.id}`);
    const previousState = (prev?.state as UsPortfolioState | null) ?? null;
    const previousNav = prev ? Number(prev.nav_usd) : null;
    const stepped = stepUsProspectivePortfolio(strategy, analysis, previousState, previousNav);

    const { error: snapshotError } = await client.from("us_portfolio_snapshots").upsert(
      {
        user_id: userId,
        strategy_id: strategy.id,
        date: analysis.date,
        rule_version: US_PROSPECTIVE_RULE_VERSION,
        nav_usd: stepped.nav,
        cash_usd: stepped.cash,
        benchmark_nav: stepped.benchmarkNav,
        daily_return: stepped.dailyReturn,
        cumulative_return: stepped.cumulativeReturn,
        turnover: stepped.turnover,
        fees_usd: stepped.feesUsd,
        positions_count: stepped.positionsCount,
        state: stepped.state,
      },
      { onConflict: "user_id,strategy_id,date" },
    );
    if (snapshotError) throw new Error(`US 포트폴리오 스냅샷 저장 실패: ${snapshotError.message}`);

    // 전일의 PENDING 표시는 이번 step에서 체결되거나 그대로 이월될 수 있다.
    // 먼저 이전 표시를 닫고, 아래 upsert에서 아직 남은 pending만 같은 key로 다시 PENDING 처리한다.
    const { error: rollError } = await client
      .from("us_portfolio_trades")
      .update({
        status: "CANCELLED",
        detail: { resolution: "ROLLED_FORWARD_OR_RESOLVED", resolved_on: analysis.date },
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("strategy_id", strategy.id)
      .eq("status", "PENDING")
      .lt("signal_date", analysis.date);
    if (rollError) throw new Error(`US 이전 대기주문 정리 실패: ${rollError.message}`);

    if (stepped.trades.length > 0) {
      const tradeRows = stepped.trades.map((trade) => ({
        user_id: userId,
        trade_key: trade.tradeKey,
        strategy_id: trade.strategyId,
        signal_date: trade.signalDate,
        execution_date: trade.executionDate,
        symbol: trade.symbol,
        name: trade.name,
        sector: trade.sector,
        side: trade.side,
        reason: trade.reason,
        status: trade.status,
        model_price: trade.modelPrice,
        model_shares: trade.modelShares,
        model_notional: trade.modelNotional,
        fee_usd: trade.feeUsd,
        core_rank: trade.coreRank,
        detail: trade.detail,
        updated_at: new Date().toISOString(),
      }));
      const { error: tradeError } = await client
        .from("us_portfolio_trades")
        .upsert(tradeRows, { onConflict: "user_id,trade_key" });
      if (tradeError) throw new Error(`US 거래 원장 저장 실패: ${tradeError.message}`);
    }
  }

  // SPY benchmark gets its own daily snapshot for easy charting/comparison.
  const spy = analysis.rows.find((row) => row.symbol === "SPY");
  if (spy?.close) {
    const { data: firstSpy, error: firstSpyError } = await client
      .from("us_portfolio_snapshots")
      .select("state")
      .eq("user_id", userId)
      .eq("strategy_id", "SPY_BENCHMARK")
      .order("date", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (firstSpyError) throw firstSpyError;
    const basePrice = Number(
      (firstSpy?.state as { basePrice?: number } | null)?.basePrice ?? spy.close,
    );
    const nav = 100_000 * (spy.close / basePrice);
    const { error: spyRegistryError } = await client.from("us_strategy_registry").upsert(
      {
        user_id: userId,
        strategy_id: "SPY_BENCHMARK",
        label: "SPY Benchmark",
        role: "BENCHMARK",
        rule_version: US_PROSPECTIVE_RULE_VERSION,
        config: { symbol: "SPY", initialCapital: 100000 },
        frozen_at: "2026-09-28T00:00:00+09:00",
        active: true,
      },
      { onConflict: "user_id,strategy_id" },
    );
    if (spyRegistryError) throw spyRegistryError;
    const { error: spySnapshotError } = await client.from("us_portfolio_snapshots").upsert(
      {
        user_id: userId,
        strategy_id: "SPY_BENCHMARK",
        date: analysis.date,
        rule_version: US_PROSPECTIVE_RULE_VERSION,
        nav_usd: nav,
        cash_usd: 0,
        benchmark_nav: nav,
        daily_return: null,
        cumulative_return: nav / 100_000 - 1,
        turnover: 0,
        fees_usd: 0,
        positions_count: 1,
        state: { basePrice, currentPrice: spy.close, symbol: "SPY" },
      },
      { onConflict: "user_id,strategy_id,date" },
    );
    if (spySnapshotError) throw spySnapshotError;
  }

  // History is the completion marker. A failed run is replayed only from the prior date.
  // Publish immutable daily result before the marker; publish latest only after all ledgers succeed.
  if (!existingResult) await uploadJson(client, resultPath, cachePayload);
  const { error: historyError } = await client.from("us_screening_history").insert(historyRecord);
  if (historyError) throw historyError;
  await uploadJson(client, latestCachePath, existingResult ?? cachePayload);
  await publishBrowserViews(client, userId, existingResult ?? cachePayload);

  console.log(
    JSON.stringify(
      {
        ok: true,
        date: analysis.date,
        rows: analysis.rows.length,
        ruleVersion: analysis.ruleVersion,
        summary: analysis.summary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
