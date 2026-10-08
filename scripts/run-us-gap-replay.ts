import {
  preflightUsRecoveryPublication,
  publishUsRecoveryViews,
  type UsRecoveryPublicationInput,
} from "./us-recovery-publication";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { ANALYSIS_BUCKET, stableJson, trustedSupabaseClient } from "./analysis-run-store";
import {
  assertOwnerReplayPath,
  bytesHash,
  loadVerifiedUsReplaySessions,
  validateUsReplayManifest,
} from "./us-replay-source";
import { commitUsShadowReplay, planUsShadowReplay } from "./us-shadow-replay-plan";
import { octoberShadowStore } from "../src/lib/ledger/octoberShadowRepository.server";
import {
  US_PROSPECTIVE_RULE_VERSION,
  type UsProspectivePreviousState,
} from "../src/lib/engine/usProspective";
import {
  planUsOperatingReplay,
  US_OPERATING_STRATEGY_IDS,
  type UsOperatingRegistry,
  type UsOperatingSnapshot,
  type UsOperatingStrategyId,
  type UsOperatingTrade,
} from "./us-operating-replay";

type Client = ReturnType<typeof trustedSupabaseClient>;
const argument = (name: string) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
async function readText(client: Client, path: string, optional = false): Promise<string | null> {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(path);
  if (error) {
    if (optional && /not.?found|404|Object not found/i.test(error.message)) return null;
    throw new Error(`Private US recovery input unavailable: ${error.message}`);
  }
  return data.text();
}
async function immutableJson(client: Client, path: string, value: unknown) {
  const body = stableJson(value);
  const { error } = await client.storage
    .from(ANALYSIS_BUCKET)
    .upload(path, body, { contentType: "application/json", upsert: false });
  if (error) {
    const old = await readText(client, path, true);
    if (old === null || stableJson(JSON.parse(old)) !== body)
      throw new Error("Immutable US recovery artifact conflict");
  }
  const readback = await readText(client, path);
  if (!readback || stableJson(JSON.parse(readback)) !== body)
    throw new Error("US recovery artifact readback mismatch");
}
async function query<T>(
  request: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await request;
  if (error || data === null)
    throw new Error(`US recovery preflight read failed: ${error?.message ?? "missing result"}`);
  return data;
}
interface ProtectedSource {
  date: string;
  data_hash: string;
  rule_version: string;
  resultHash: string;
  manifestHash: string | null;
}
async function protectedHistory(
  client: Client,
  userId: string,
  baseDate: string,
  throughDate: string,
): Promise<ProtectedSource[]> {
  // Deliberately only immutable identities; no summary, signal rows or actual ledger query.
  const markers = await query<Array<{ date: string; data_hash: string; rule_version: string }>>(
    client
      .from("us_screening_history")
      .select("date,data_hash,rule_version")
      .eq("user_id", userId)
      .gte("date", baseDate)
      .lte("date", throughDate)
      .order("date"),
  );
  const protectedRows: ProtectedSource[] = [];
  for (const marker of markers) {
    const result = await readText(client, `${userId}/results/us-screening/${marker.date}.json`);
    const parsed = JSON.parse(result!);
    if (
      parsed.dataHash !== marker.data_hash ||
      parsed.analysis?.ruleVersion !== marker.rule_version ||
      parsed.analysis?.date !== marker.date
    )
      throw new Error("Original US screening identity is inconsistent; recovery is blocked");
    const manifest = await readText(
      client,
      `${userId}/results/us-screening/${marker.date}.manifest.json`,
      true,
    );
    protectedRows.push({
      ...marker,
      resultHash: bytesHash(result!),
      manifestHash: manifest === null ? null : bytesHash(manifest),
    });
  }
  return protectedRows;
}

export async function runUsGapReplay(input: {
  client: Client;
  userId: string;
  manifestPath: string;
  manifestHash: string;
  apply: boolean;
  calculatedAt?: string;
  expectedOperatingPlanHash?: string | undefined;
  publishRecoveredView?: boolean;
}) {
  const { client, userId } = input;
  if (input.publishRecoveredView && !input.apply)
    throw new Error("Recovered screen publication requires an applied replay");
  if (!/^[a-f0-9-]{36}$/i.test(userId) || !/^sha256:[a-f0-9]{64}$/.test(input.manifestHash))
    throw new Error("Exact US recovery owner and manifest hash are required");
  assertOwnerReplayPath(input.manifestPath, userId);
  const source = await readText(client, input.manifestPath);
  if (!source || bytesHash(source) !== input.manifestHash)
    throw new Error("US recovery manifest hash mismatch");
  const manifest = await validateUsReplayManifest(JSON.parse(source), userId);
  const sessions = await loadVerifiedUsReplaySessions(
    manifest,
    async (path) => (await readText(client, path))!,
  );
  const prefix = `${userId}/results/us-gap-replay/${input.manifestHash.slice(7)}`;
  const savedText = await readText(client, `${prefix}/plan.json`, true);
  type SavedPlan = {
    version: "us-gap-replay-plan-v1";
    manifestHash: string;
    calculatedAt: string;
    protectedHistory: ProtectedSource[];
    operating: ReturnType<typeof planUsOperatingReplay>;
    shadow: Awaited<ReturnType<typeof planUsShadowReplay>>;
  };
  const saved = savedText ? (JSON.parse(savedText) as SavedPlan) : null;
  if (
    saved &&
    (saved.version !== "us-gap-replay-plan-v1" || saved.manifestHash !== input.manifestHash)
  )
    throw new Error("US recovery plan identity mismatch");
  const calculatedAt = saved?.calculatedAt ?? input.calculatedAt ?? new Date().toISOString();
  if (
    !Number.isFinite(Date.parse(calculatedAt)) ||
    sessions.some((s) => Date.parse(s.source.sourceCapturedAt) > Date.parse(calculatedAt))
  )
    throw new Error("US replay cannot consume a source captured after its calculation time");
  const protectedRows = await protectedHistory(
    client,
    userId,
    manifest.baseDate,
    manifest.throughDate,
  );
  if (saved && stableJson(saved.protectedHistory) !== stableJson(protectedRows))
    throw new Error("Protected US screening history changed since recovery preparation");
  const baseStatePaths = [
    `${userId}/results/us-replay-state/${manifest.baseDate}.json`,
    `${userId}/results/shadow-replay/US/${manifest.baseDate}.json`,
    `${userId}/results/us-screening/${manifest.baseDate}.json`,
  ];
  let rank: UsProspectivePreviousState | undefined;
  for (const path of baseStatePaths) {
    const text = await readText(client, path, true);
    if (!text) continue;
    const value = JSON.parse(text);
    if (
      value.analysis?.ruleVersion !== US_PROSPECTIVE_RULE_VERSION ||
      value.analysis?.state?.lastDate !== manifest.baseDate
    )
      throw new Error("US recovery predecessor rank state identity mismatch");
    rank = value.analysis.state;
    break;
  }
  if (!rank) throw new Error("US recovery has no exact predecessor rank state");
  const store = octoberShadowStore(client, userId, "service");
  const shadow = await planUsShadowReplay({
    store,
    baseDate: manifest.baseDate,
    previousRankState: rank,
    sessions,
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
      .eq("date", manifest.baseDate)
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
          [...US_OPERATING_STRATEGY_IDS].filter((id) => id !== "SPY_BENCHMARK"),
        ),
    ));
  const operating = planUsOperatingReplay({
    dates: shadow.analyses.map((analysis, i) => ({
      analysis,
      previousSessionDate: sessions[i]!.source.previousSessionDate,
      sourceHash: sessions[i]!.source.dataHash,
    })),
    priorSnapshots: Object.fromEntries(
      snapshots.map((snapshot) => [snapshot.strategy_id, snapshot]),
    ) as Record<UsOperatingStrategyId, UsOperatingSnapshot>,
    registries,
    existingTrades: trades,
  });
  if (input.expectedOperatingPlanHash && input.expectedOperatingPlanHash !== operating.planHash)
    throw new Error("US recovery plan differs from the approved exact plan hash");
  const plan: SavedPlan = {
    version: "us-gap-replay-plan-v1",
    manifestHash: input.manifestHash,
    calculatedAt,
    protectedHistory: protectedRows,
    operating,
    shadow,
  };
  if (saved && stableJson(saved) !== stableJson(plan))
    throw new Error("US recovery recalculation differs from immutable prepared batch");
  const { data: validation, error: validationError } = await client.rpc(
    "apply_us_operating_replay",
    {
      p_user_id: userId,
      p_plan: operating,
      p_apply: false,
    },
  );
  if (validationError || !validation)
    throw new Error(
      `Operating recovery preflight failed: ${validationError?.message ?? "missing acknowledgement"}`,
    );
  const rankArtifacts: Array<{ path: string; artifact: unknown }> = [];
  for (const [index, analysis] of shadow.analyses.entries()) {
    const artifact = {
      version: "us-replay-state-v1",
      manifestHash: input.manifestHash,
      dataHash: sessions[index]!.source.dataHash,
      source: sessions[index]!.source,
      replayMode: "RETROSPECTIVE",
      originalScreeningPreserved: true,
      analysis: {
        date: analysis.date,
        ruleVersion: analysis.ruleVersion,
        summary: analysis.summary,
        state: analysis.state,
      },
    };
    const path = `${userId}/results/us-replay-state/${analysis.date}.json`;
    const existing = await readText(client, path, true);
    if (existing !== null && stableJson(JSON.parse(existing)) !== stableJson(artifact))
      throw new Error("Recovered US rank artifact conflicts with the prepared batch");
    rankArtifacts.push({ path, artifact });
  }
  let publicationInput: UsRecoveryPublicationInput | undefined;
  if (input.publishRecoveredView) {
    const protectedOriginal = protectedRows.find((row) => row.date === manifest.throughDate);
    if (!protectedOriginal)
      throw new Error("Recovered current-date publication requires an existing original result");
    publicationInput = {
      client,
      userId,
      analysis: shadow.analyses.at(-1)!,
      source: sessions.at(-1)!.source,
      manifestHash: input.manifestHash,
      operatingPlanHash: operating.planHash,
      generatedAt: calculatedAt,
      protectedOriginal,
    };
    await preflightUsRecoveryPublication(publicationInput);
  }
  const summary = {
    mode: input.apply ? "APPLY" : "PREFLIGHT",
    baseDate: manifest.baseDate,
    throughDate: manifest.throughDate,
    sessions: sessions.length,
    operatingPlanHash: operating.planHash,
    sourceCoverageComplete: sessions.every((s) => s.source.sourceCoverageComplete),
    protectedOriginalResults: protectedRows.length,
  };
  if (!input.apply) return { ...summary, applied: false };
  // Complete source, identity, chronology, frozen-engine and cash/price preflight ends here.
  await immutableJson(client, `${prefix}/plan.json`, plan);
  // Persist every deterministic continuation state before advancing either book.
  // With the ordinary predecessor guard, a failed artifact write cannot advance
  // future sessions from an old/bootstrap rank state.
  for (const item of rankArtifacts) await immutableJson(client, item.path, item.artifact);
  const shadowResults = await commitUsShadowReplay(store, shadow);
  const { data: applied, error } = await client.rpc("apply_us_operating_replay", {
    p_user_id: userId,
    p_plan: operating,
    p_apply: true,
  });
  if (error || !applied)
    throw new Error(
      `Operating recovery did not acknowledge commit: ${error?.message ?? "missing result"}. Retry the same immutable manifest only.`,
    );
  if (
    stableJson(protectedRows) !==
    stableJson(await protectedHistory(client, userId, manifest.baseDate, manifest.throughDate))
  )
    throw new Error("Original US result identity changed during recovery");
  await immutableJson(client, `${prefix}/receipt.json`, {
    ...summary,
    version: "us-gap-replay-receipt-v1",
    calculatedAt,
    applied: true,
    originalScreeningPreserved: true,
    operatingPlanHash: operating.planHash,
    shadowStateHashes: shadowResults.map((r) => ({
      date: r.date,
      records: r.records.map(({ bookId, stateHash }) => ({ bookId, stateHash })),
    })),
  });
  if (publicationInput) {
    const published = await publishUsRecoveryViews(publicationInput);
    await immutableJson(client, `${prefix}/publication-receipt.json`, {
      version: "us-recovery-publication-receipt-v1",
      manifestHash: input.manifestHash,
      operatingPlanHash: operating.planHash,
      date: published.analysis.date,
      dataHash: published.dataHash,
      publishedHash: bytesHash(stableJson(published)),
      originalScreeningPreserved: true,
    });
  }
  return { ...summary, applied: true, screeningPublished: Boolean(publicationInput) };
}
async function main() {
  const userId = argument("--user") ?? process.env["SUPABASE_USER_ID"];
  const manifestPath = argument("--manifest");
  const manifestHash = argument("--manifest-hash");
  if (!userId || !manifestPath || !manifestHash)
    throw new Error("--user, --manifest and --manifest-hash are required");
  const result = await runUsGapReplay({
    client: trustedSupabaseClient(),
    userId,
    manifestPath,
    manifestHash,
    apply: process.argv.includes("--apply"),
    expectedOperatingPlanHash: argument("--expected-plan-hash"),
    publishRecoveredView: process.argv.includes("--publish-recovered-view"),
  });
  console.log(JSON.stringify(result)); // Never print rows, holdings, raw plans or credentials to CI.
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      `US recovery stopped; private diagnostic ${bytesHash(error instanceof Error ? error.message : "unknown").slice(7, 19)}. Verify the immutable batch before retrying.`,
    );
    process.exitCode = 1;
  });
