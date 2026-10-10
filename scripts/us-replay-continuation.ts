/** Read-only admission of a completed reconstruction as an ordinary day's predecessor.
 * A rank file alone is a PREPARE marker, never evidence that either ledger committed.
 * No synthetic screening history, source, or actual-ledger record is created here.
 */
import { ANALYSIS_BUCKET, stableJson, type trustedSupabaseClient } from "./analysis-run-store";
import { bytesHash, validateUsReplayManifest } from "./us-replay-source";
import {
  US_OPERATING_STRATEGY_IDS,
  US_OPERATING_REPLAY_VERSION,
  usOperatingSnapshotProjection,
  usOperatingStableJson,
  usOperatingTradeProjection,
  type UsOperatingReplayPlan,
  type UsOperatingSnapshot,
  type UsOperatingTrade,
} from "./us-operating-replay";
import { US_REPLAY_BOOK_IDS, type planUsShadowReplay } from "./us-shadow-replay-plan";
import { octoberShadowStore } from "../src/lib/ledger/octoberShadowRepository.server";
import { assertStoredOctoberRun, type OctoberRun } from "../src/lib/ledger/octoberShadowPipeline";
import { hashSeriesValue, canonicalSeriesJson } from "../src/lib/ledger/modelSeries";
import { assertAdoptedShadowRuntime } from "../src/lib/ledger/octoberShadowRuntime";
import engineManifest from "../src/lib/ledger/octoberShadowEngineManifest.generated.json";
import {
  US_PROSPECTIVE_RULE_VERSION,
  type UsProspectiveInputRow,
} from "../src/lib/engine/usProspective";
import { nextScheduledUsSession } from "../src/lib/engine/usProspectiveOrderPreview";

type Client = ReturnType<typeof trustedSupabaseClient>;
type ShadowPlan = Awaited<ReturnType<typeof planUsShadowReplay>>;
type History = { date: string; data_hash: string; rule_version: string };
interface SavedPlan {
  version: string;
  manifestHash: string;
  calculatedAt: string;
  protectedHistory: Array<History & { resultHash: string; manifestHash: string | null }>;
  operating: UsOperatingReplayPlan;
  shadow: ShadowPlan;
}
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
function fail(detail: string): never {
  throw new Error(
    `Previous US replay publication is incomplete or conflicts (${detail}); resume the same immutable replay manifest`,
  );
}
async function text(client: Client, path: string): Promise<string> {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(path);
  if (error || !data) fail("missing reconstruction evidence");
  return data.text();
}
async function rows<T>(
  q: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await q;
  if (error || data === null) fail("predecessor read failed");
  return data;
}

export async function loadUsReconstructionContinuation(input: {
  client: Client;
  userId: string;
  currentDate: string;
  previousSessionDate: string;
  lastHistory: History | null;
  rankArtifact: unknown;
  currentRows: UsProspectiveInputRow[];
  /** Only an independently revalidated, immutable same-input successor plan may resume. */
  successor?: { operating: UsOperatingReplayPlan; shadow: ShadowPlan } | null;
}) {
  const { client, userId, currentDate, previousSessionDate: previousDate } = input;
  const rank = input.rankArtifact as { manifestHash?: string };
  if (
    !/^sha256:[a-f0-9]{64}$/.test(rank?.manifestHash ?? "") ||
    !input.lastHistory ||
    input.lastHistory.date >= previousDate ||
    nextScheduledUsSession(previousDate) !== currentDate
  )
    fail("reconstruction identity");
  if (
    !same(
      JSON.parse(await text(client, `${userId}/results/us-replay-state/${previousDate}.json`)),
      input.rankArtifact,
    )
  )
    fail("rank artifact changed during admission");
  const manifestHash = rank.manifestHash!;
  const prefix = `${userId}/results/us-gap-replay/${manifestHash.slice(7)}`;
  const manifestText = await text(client, `${prefix}/manifest.json`);
  if (bytesHash(manifestText) !== manifestHash) fail("manifest hash");
  const manifest = await validateUsReplayManifest(JSON.parse(manifestText), userId);
  if (
    manifest.baseDate !== input.lastHistory!.date ||
    manifest.throughDate !== previousDate ||
    manifest.sessions.some((s) => s.pit.kind !== "DATED_ROSTER_RECONSTRUCTION" || s.originalSource)
  )
    fail("only a complete dated reconstruction can replace a missing predecessor marker");
  const plan = JSON.parse(await text(client, `${prefix}/plan.json`)) as SavedPlan;
  const receipt = JSON.parse(await text(client, `${prefix}/receipt.json`));
  if (
    plan.version !== "us-gap-replay-plan-v1" ||
    plan.manifestHash !== manifestHash ||
    !Number.isFinite(Date.parse(plan.calculatedAt)) ||
    manifest.sessions.some((s) => Date.parse(s.sourceCapturedAt) > Date.parse(plan.calculatedAt)) ||
    receipt.version !== "us-gap-replay-receipt-v1" ||
    receipt.mode !== "APPLY" ||
    receipt.applied !== true ||
    receipt.originalScreeningPreserved !== true ||
    receipt.baseDate !== manifest.baseDate ||
    receipt.throughDate !== manifest.throughDate ||
    receipt.sessions !== manifest.sessions.length ||
    receipt.calculatedAt !== plan.calculatedAt ||
    receipt.operatingPlanHash !== plan.operating?.planHash
  )
    fail("applied receipt identity");
  const { canonicalPayload, planHash, ...payload } = plan.operating;
  if (
    payload.version !== US_OPERATING_REPLAY_VERSION ||
    payload.ruleVersion !== US_PROSPECTIVE_RULE_VERSION ||
    typeof canonicalPayload !== "string" ||
    bytesHash(canonicalPayload) !== planHash ||
    canonicalPayload !== usOperatingStableJson(payload) ||
    payload.baseDate !== manifest.baseDate ||
    payload.throughDate !== manifest.throughDate ||
    !same(
      payload.dates,
      manifest.sessions.map((s) => ({
        date: s.date,
        previousSessionDate: s.previousSessionDate,
        sourceHash: s.dataHash,
      })),
    )
  )
    fail("operating plan digest or dates");
  const shadow = plan.shadow;
  if (
    shadow?.runtimeCodeHash !== engineManifest.codeHash ||
    shadow.analyses?.length !== manifest.sessions.length ||
    shadow.publications?.length !== manifest.sessions.length ||
    shadow.prepared?.length !== manifest.sessions.length
  )
    fail("complete Shadow plan");
  for (const [i, source] of manifest.sessions.entries()) {
    const analysis = shadow.analyses[i]!;
    const publication = shadow.publications[i]!;
    const prepared = shadow.prepared[i]!;
    const { preparedHash, ...preparedBody } = prepared;
    if (
      analysis.date !== source.date ||
      analysis.state.lastDate !== source.date ||
      analysis.ruleVersion !== US_PROSPECTIVE_RULE_VERSION ||
      !same(publication.analysis, analysis) ||
      publication.market !== "US" ||
      publication.previousSessionDate !== source.previousSessionDate ||
      prepared.market !== "US" ||
      prepared.date !== source.date ||
      prepared.runtimeCodeHash !== engineManifest.codeHash ||
      prepared.sourceHash !== publication.sourceHash ||
      prepared.codeHash !== publication.codeHash ||
      preparedHash !== (await hashSeriesValue(preparedBody)) ||
      prepared.inputHash !==
        (await hashSeriesValue(
          JSON.parse(
            JSON.stringify({
              ...publication,
              decisionAt: null,
              codeHash: null,
            }),
          ),
        )) ||
      !same(
        prepared.entries.map((e) => e.series.bookId),
        US_REPLAY_BOOK_IDS,
      )
    )
      fail("Shadow plan identity");
  }
  const expectedHashes = shadow.prepared.map((p) => ({
    date: p.date,
    records: p.entries.map((e) => ({ bookId: e.series.bookId, stateHash: e.run.stateHash })),
  }));
  if (!same(receipt.shadowStateHashes, expectedHashes)) fail("Shadow receipt hashes");
  if (
    !same(receipt, {
      mode: "APPLY",
      baseDate: manifest.baseDate,
      throughDate: manifest.throughDate,
      sessions: manifest.sessions.length,
      operatingPlanHash: planHash,
      sourceCoverageComplete: manifest.sessions.every((s) => s.sourceCoverageComplete),
      protectedOriginalResults: plan.protectedHistory.length,
      version: "us-gap-replay-receipt-v1",
      calculatedAt: plan.calculatedAt,
      applied: true,
      originalScreeningPreserved: true,
      shadowStateHashes: expectedHashes,
    })
  )
    fail("exact applied receipt");
  const source = manifest.sessions.at(-1)!;
  const analysis = shadow.analyses.at(-1)!;
  const expectedRank = {
    version: "us-replay-state-v1",
    manifestHash,
    dataHash: source.dataHash,
    source,
    replayMode: "RETROSPECTIVE",
    originalScreeningPreserved: true,
    analysis: {
      date: analysis.date,
      ruleVersion: analysis.ruleVersion,
      summary: analysis.summary,
      state: analysis.state,
    },
  };
  if (!same(input.rankArtifact, expectedRank)) fail("rank artifact identity");

  // Check current history, not merely the runner's earlier read: a concurrent date
  // completion or source replacement is never permission to use this exception.
  const latestHistory = await rows<History[]>(
    client
      .from("us_screening_history")
      .select("date,data_hash,rule_version")
      .eq("user_id", userId)
      .order("date", { ascending: false })
      .limit(1),
  );
  if (latestHistory.length !== 1 || !same(latestHistory[0], input.lastHistory))
    fail("concurrent history date");
  if (
    plan.protectedHistory?.length !== 1 ||
    !same(
      {
        date: plan.protectedHistory[0]!.date,
        data_hash: plan.protectedHistory[0]!.data_hash,
        rule_version: plan.protectedHistory[0]!.rule_version,
      },
      input.lastHistory,
    )
  )
    fail("protected history identity");
  const original = plan.protectedHistory[0]!;
  if (
    bytesHash(await text(client, `${userId}/results/us-screening/${original.date}.json`)) !==
    original.resultHash
  )
    fail("protected original result");
  if (
    original.manifestHash !== null &&
    bytesHash(
      await text(client, `${userId}/results/us-screening/${original.date}.manifest.json`),
    ) !== original.manifestHash
  )
    fail("protected original manifest");
  const registries = await rows<unknown[]>(
    client
      .from("us_strategy_registry")
      .select("strategy_id,label,role,rule_version,config,active")
      .eq("user_id", userId)
      .in("strategy_id", [...US_OPERATING_STRATEGY_IDS]),
  );
  const sortById = <T extends { strategy_id: string }>(values: T[]) =>
    [...values].sort((a, b) => a.strategy_id.localeCompare(b.strategy_id));
  if (
    !same(
      sortById(registries as Array<{ strategy_id: string }>),
      sortById(payload.expectedRegistries),
    )
  )
    fail("operating registry changed");
  const terminalSnapshots = payload.snapshots.filter((s) => s.date === previousDate);
  if (
    !same(terminalSnapshots.map((s) => s.strategy_id).sort(), [...US_OPERATING_STRATEGY_IDS].sort())
  )
    fail("complete operating book set");
  const advancedOperating: boolean[] = [];
  for (const expected of terminalSnapshots) {
    const latest = await rows<UsOperatingSnapshot[]>(
      client
        .from("us_portfolio_snapshots")
        .select(
          "strategy_id,date,rule_version,nav_usd,cash_usd,benchmark_nav,daily_return,cumulative_return,turnover,fees_usd,positions_count,state",
        )
        .eq("user_id", userId)
        .eq("strategy_id", expected.strategy_id)
        .order("date", { ascending: false })
        .limit(1),
    );
    const planned = input.successor?.operating.snapshots.find(
      (s) => s.strategy_id === expected.strategy_id && s.date === currentDate,
    );
    const advanced =
      latest.length === 1 && !!planned && same(usOperatingSnapshotProjection(latest[0]!), planned);
    if (
      latest.length !== 1 ||
      (!advanced && !same(usOperatingSnapshotProjection(latest[0]!), expected))
    )
      fail("operating predecessor missing, changed or advanced");
    advancedOperating.push(advanced);
    if (advanced) {
      const previous = await rows<UsOperatingSnapshot[]>(
        client
          .from("us_portfolio_snapshots")
          .select(
            "strategy_id,date,rule_version,nav_usd,cash_usd,benchmark_nav,daily_return,cumulative_return,turnover,fees_usd,positions_count,state",
          )
          .eq("user_id", userId)
          .eq("strategy_id", expected.strategy_id)
          .eq("date", previousDate),
      );
      if (previous.length !== 1 || !same(usOperatingSnapshotProjection(previous[0]!), expected))
        fail("protected operating predecessor changed");
    }
  }
  const pending = await rows<UsOperatingTrade[]>(
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
  );
  // The operating RPC is atomic. A subset of target snapshots is never an authorized resume.
  if (advancedOperating.some(Boolean) && !advancedOperating.every(Boolean))
    fail("partial operating successor is not atomic");
  const pendingPlan = advancedOperating.every(Boolean) ? input.successor!.operating : payload;
  const expectedPending = [
    ...pendingPlan.expectedPendingTrades.filter(
      (t) => !pendingPlan.pendingResolutions.some((r) => r.trade_key === t.trade_key),
    ),
    ...pendingPlan.trades.filter((t) => t.status === "PENDING"),
  ];
  const sortTrades = (values: UsOperatingTrade[]) =>
    values.map(usOperatingTradeProjection).sort((a, b) => a.trade_key.localeCompare(b.trade_key));
  if (!same(sortTrades(pending), sortTrades(expectedPending))) fail("pending model trades changed");
  // The saved-plan RPC verifies all executed/partial trades and prior pending
  // resolutions, including legitimate later resolutions, without changing a row.
  const { data: validatedPredecessor, error: predecessorError } = await client.rpc(
    "apply_us_operating_replay",
    {
      p_user_id: userId,
      p_plan: plan.operating,
      p_apply: false,
    },
  );
  if (
    predecessorError ||
    validatedPredecessor?.validated !== true ||
    validatedPredecessor?.alreadyApplied !== true ||
    validatedPredecessor?.planHash !== planHash ||
    validatedPredecessor?.baseDate !== manifest.baseDate ||
    validatedPredecessor?.throughDate !== previousDate
  )
    fail("committed operating ledger differs from reconstruction receipt");
  const requirePrices = (state: {
    positions?: Record<string, unknown>;
    pendingTargets?: Record<string, unknown>;
    pendingExits?: Record<string, unknown>;
  }) => {
    for (const symbol of new Set([
      ...Object.keys(state.positions ?? {}),
      ...Object.keys(state.pendingTargets ?? {}),
      ...Object.keys(state.pendingExits ?? {}),
      "SPY",
    ])) {
      const row = input.currentRows.find((r) => r.symbol === symbol && r.date === currentDate);
      if (
        !row ||
        [row.open, row.high, row.low, row.close].some(
          (n) => typeof n !== "number" || !Number.isFinite(n) || n <= 0,
        )
      )
        fail(`held/pending security lacks current prices: ${symbol}`);
    }
  };
  for (const snapshot of terminalSnapshots)
    requirePrices(snapshot.state as Parameters<typeof requirePrices>[0]);
  const store = octoberShadowStore(client, userId, "service");
  const prepared = shadow.prepared.at(-1)!;
  if (
    canonicalSeriesJson(await store.readPrepared("US", previousDate)) !==
    canonicalSeriesJson(prepared)
  )
    fail("committed Shadow preparation");
  for (const entry of prepared.entries) {
    const series = await store.readSeries(entry.series.bookId);
    const latest = await store.readLatest<OctoberRun>(entry.series.bookId);
    const planned = input.successor?.shadow.prepared
      .find((p) => p.date === currentDate)
      ?.entries.find((e) => e.series.bookId === entry.series.bookId);
    const advanced = !!planned && same(latest, planned.run);
    if (
      !series ||
      !latest ||
      !same(series, entry.series) ||
      (!advanced && !same(latest, entry.run))
    )
      fail("Shadow predecessor missing, changed or advanced");
    if (advanced && !same(await store.readSession(entry.series.bookId, previousDate), entry.run))
      fail("protected Shadow predecessor changed");
    assertAdoptedShadowRuntime(engineManifest.codeHash, series.codeHash);
    await assertStoredOctoberRun(series, latest);
    requirePrices(
      (entry.run.result as unknown as { state: Parameters<typeof requirePrices>[0] }).state,
    );
  }
  return expectedRank;
}
