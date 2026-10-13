import { usesLegacyUsOperatingLedger } from "../src/lib/legacyUsLedgerBoundary";
import {
  RESTART_ACCOUNTING_START,
  activeSeriesVersion,
  hashSeriesValue,
} from "../src/lib/ledger/modelSeries";
import { assertStoredOctoberRun, type OctoberRun } from "../src/lib/ledger/octoberShadowPipeline";
import type { UsReplayManifest } from "./us-replay-source";
import {
  preflightUsRecoveryPublication,
  publishUsRecoveryViews,
  type UsRecoveryPublicationInput,
} from "./us-recovery-publication";
import {
  preflightUsReplayScreening,
  publishUsReplayScreening,
  type UsReplayScreeningInput,
} from "./us-replay-screening-publication";
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
  runUsProspectiveAnalysis,
  parseUsProspectiveCsv,
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

async function finishDailyScreening(input: UsReplayScreeningInput) {
  await publishUsReplayScreening(input);
  await immutableJson(
    input.client,
    `${input.userId}/results/us-gap-replay/${input.manifestHash.slice(7)}/daily-publication-receipt.json`,
    {
      version: "us-daily-publication-receipt-v1",
      manifestHash: input.manifestHash,
      operatingPlanHash: input.operatingPlanHash,
      throughDate: input.sources.at(-1)!.date,
      dataHash: input.sources.at(-1)!.dataHash,
      screeningPublished: true,
    },
  );
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
  publishDailyScreen?: boolean;
}) {
  const { client, userId } = input;
  if ((input.publishRecoveredView || input.publishDailyScreen) && !input.apply)
    throw new Error("Recovered screen publication requires an applied replay");
  if (input.publishRecoveredView && input.publishDailyScreen)
    throw new Error("Choose either reviewed recovery or preserved ATOMIC daily publication");
  if (!/^[a-f0-9-]{36}$/i.test(userId) || !/^sha256:[a-f0-9]{64}$/.test(input.manifestHash))
    throw new Error("Exact US recovery owner and manifest hash are required");
  assertOwnerReplayPath(input.manifestPath, userId);
  const source = await readText(client, input.manifestPath);
  if (!source || bytesHash(source) !== input.manifestHash)
    throw new Error("US recovery manifest hash mismatch");
  const manifest = await validateUsReplayManifest(JSON.parse(source), userId);
  if (!usesLegacyUsOperatingLedger(manifest.throughDate)) {
    if (
      manifest.sessions.some((s) => s.originalSource || s.pit.kind === "REVIEWED_ATOMIC_QUARANTINE")
    )
      return runRestartReviewedPublication(input, manifest);
    return runRestartUsGapReplay(input, manifest, source);
  }
  if (
    input.publishDailyScreen &&
    manifest.sessions.some(
      (s) =>
        !(
          (s.pit.kind === "ATOMIC_DATED_SNAPSHOT" && !s.originalSource) ||
          (s.pit.kind === "REVIEWED_ATOMIC_QUARANTINE" && s.originalSource)
        ),
    )
  )
    throw new Error(
      "Automatic daily publication requires preserved ATOMIC or reviewed quarantine inputs",
    );
  const hasReviewedSource = manifest.sessions.some(
    (s) => s.pit.kind === "REVIEWED_ATOMIC_QUARANTINE",
  );
  if (hasReviewedSource && (!input.publishDailyScreen || manifest.sessions.length !== 1))
    throw new Error("Reviewed US inputs require single-session publication-only mode");
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
  // A completed model replay may have stopped while publishing history/cache. Reuse
  // its immutable analyses and receipt; never re-step models or re-read raw sources.
  if (input.publishDailyScreen && saved && !hasReviewedSource) {
    const receiptText = await readText(client, `${prefix}/receipt.json`, true);
    if (receiptText) {
      const receipt = JSON.parse(receiptText);
      if (
        receipt.version !== "us-gap-replay-receipt-v1" ||
        receipt.applied !== true ||
        receipt.operatingPlanHash !== saved.operating.planHash ||
        receipt.calculatedAt !== saved.calculatedAt ||
        receipt.baseDate !== manifest.baseDate ||
        receipt.throughDate !== manifest.throughDate ||
        receipt.sessions !== manifest.sessions.length ||
        (input.expectedOperatingPlanHash &&
          input.expectedOperatingPlanHash !== saved.operating.planHash)
      )
        throw new Error("Applied US daily replay receipt identity mismatch");
      const originals = await protectedHistory(
        client,
        userId,
        manifest.baseDate,
        manifest.throughDate,
      );
      if (
        stableJson(
          originals.filter((row) => saved.protectedHistory.some((old) => old.date === row.date)),
        ) !== stableJson(saved.protectedHistory)
      )
        throw new Error("Protected US screening history changed since recovery preparation");
      await finishDailyScreening({
        client,
        userId,
        analyses: saved.shadow.analyses,
        sources: manifest.sessions,
        manifestHash: input.manifestHash,
        operatingPlanHash: saved.operating.planHash,
        generatedAt: saved.calculatedAt,
        protectedHistory: saved.protectedHistory,
      });
      return {
        mode: "APPLY",
        baseDate: manifest.baseDate,
        throughDate: manifest.throughDate,
        sessions: manifest.sessions.length,
        operatingPlanHash: saved.operating.planHash,
        sourceCoverageComplete: manifest.sessions.every((s) => s.sourceCoverageComplete),
        protectedOriginalResults: saved.protectedHistory.length,
        applied: true,
        screeningPublished: true,
        reused: true,
      };
    }
  }
  const sessions = await loadVerifiedUsReplaySessions(
    manifest,
    async (path) => (await readText(client, path))!,
  );
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
  // A completed atomic day may be displayed with a reviewed lifecycle exclusion,
  // but must never be replayed under a new source hash into either model series.
  // This single-session route validates the existing committed plan in read-only
  // mode and recalculates screening only. It writes no continuation/rank state.
  const reviewed =
    sessions.length === 1 && sessions[0]!.source.pit.kind === "REVIEWED_ATOMIC_QUARANTINE"
      ? sessions[0]!
      : null;
  const reviewedOriginal = protectedRows.find((row) => row.date === reviewed?.source.date);
  if (hasReviewedSource) {
    if (!reviewed || !reviewedOriginal)
      throw new Error("Reviewed US publication requires protected original history");
    const { data: completed, error: completedError } = await client
      .from("us_operating_replays")
      .select("plan_hash,base_date,through_date,plan,receipt")
      .eq("user_id", userId)
      .eq("base_date", manifest.baseDate)
      .eq("through_date", manifest.throughDate)
      .maybeSingle();
    if (completedError) throw completedError;
    if (!completed)
      throw new Error("Reviewed US publication requires an exact completed original replay");
    if (completed) {
      const originalHash = reviewed.source.originalSource!.dataHash;
      const plan = completed.plan;
      const receipt = completed.receipt;
      if (
        completed.base_date !== manifest.baseDate ||
        completed.through_date !== manifest.throughDate ||
        reviewedOriginal.data_hash !== originalHash ||
        reviewedOriginal.rule_version !== US_PROSPECTIVE_RULE_VERSION ||
        plan?.version !== "us-operating-replay-v1" ||
        plan.ruleVersion !== US_PROSPECTIVE_RULE_VERSION ||
        plan.planHash !== completed.plan_hash ||
        plan.baseDate !== manifest.baseDate ||
        plan.throughDate !== manifest.throughDate ||
        !/^sha256:[a-f0-9]{64}$/.test(completed.plan_hash) ||
        stableJson(plan.dates) !==
          stableJson([
            {
              date: reviewed.source.date,
              previousSessionDate: manifest.baseDate,
              sourceHash: originalHash,
            },
          ]) ||
        receipt?.version !== plan.version ||
        receipt.planHash !== completed.plan_hash ||
        receipt.baseDate !== manifest.baseDate ||
        receipt.throughDate !== manifest.throughDate ||
        !Number.isFinite(Date.parse(receipt.committedAt)) ||
        (input.expectedOperatingPlanHash && input.expectedOperatingPlanHash !== completed.plan_hash)
      )
        throw new Error("Completed original US replay identity differs from reviewed publication");
      const { data: validation, error: validationError } = await client.rpc(
        "apply_us_operating_replay",
        {
          p_user_id: userId,
          p_plan: plan,
          p_apply: false,
        },
      );
      if (validationError || validation?.validated !== true || validation?.alreadyApplied !== true)
        throw new Error(
          `Completed original US replay verification failed: ${validationError?.message ?? "missing committed acknowledgement"}`,
        );
      const publicationPlanPath = `${prefix}/reviewed-publication-plan.json`;
      const priorPublicationText = await readText(client, publicationPlanPath, true);
      const publicationTime = priorPublicationText
        ? JSON.parse(priorPublicationText).generatedAt
        : calculatedAt;
      if (
        !Number.isFinite(Date.parse(publicationTime)) ||
        Date.parse(publicationTime) < Date.parse(reviewed.source.sourceCapturedAt)
      )
        throw new Error("Invalid reviewed US publication calculation time");
      const publication: UsReplayScreeningInput = {
        client,
        userId,
        analyses: [runUsProspectiveAnalysis(reviewed.rows, rank)],
        sources: [reviewed.source],
        manifestHash: input.manifestHash,
        operatingPlanHash: completed.plan_hash,
        generatedAt: publicationTime,
        protectedHistory: protectedRows,
      };
      await preflightUsReplayScreening(publication);
      await immutableJson(client, publicationPlanPath, {
        version: "us-reviewed-publication-only-v1",
        manifestHash: input.manifestHash,
        operatingPlanHash: completed.plan_hash,
        generatedAt: publication.generatedAt,
        protectedHistory: protectedRows,
        analysis: publication.analyses[0],
      });
      await finishDailyScreening(publication);
      return {
        mode: "PUBLICATION_ONLY",
        baseDate: manifest.baseDate,
        throughDate: manifest.throughDate,
        sessions: 1,
        operatingPlanHash: completed.plan_hash,
        sourceCoverageComplete: reviewed.source.sourceCoverageComplete,
        protectedOriginalResults: protectedRows.length,
        applied: true,
        screeningPublished: true,
        originalModelsPreserved: true,
      };
    }
  }
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
  let dailyPublicationInput: UsReplayScreeningInput | undefined;
  if (input.publishDailyScreen) {
    dailyPublicationInput = {
      client,
      userId,
      analyses: shadow.analyses,
      sources: sessions.map((s) => s.source),
      manifestHash: input.manifestHash,
      operatingPlanHash: operating.planHash,
      generatedAt: calculatedAt,
      protectedHistory: protectedRows,
    };
    await preflightUsReplayScreening(dailyPublicationInput);
  }
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
  // Retain the exact reviewed manifest bytes, including its original digest.
  // Continuation reads this evidence without inventing an ordinary source/history.
  const manifestCopy = `${prefix}/manifest.json`;
  const { error: manifestCopyError } = await client.storage
    .from(ANALYSIS_BUCKET)
    .upload(manifestCopy, source, { contentType: "application/json", upsert: false });
  const manifestReadback = await readText(client, manifestCopy, true);
  if (manifestReadback !== source)
    throw new Error(
      `Immutable US replay manifest copy conflict${manifestCopyError ? ": upload failed" : ""}`,
    );
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
  if (dailyPublicationInput) await finishDailyScreening(dailyPublicationInput);
  return {
    ...summary,
    applied: true,
    screeningPublished: Boolean(publicationInput || dailyPublicationInput),
  };
}
/** Correct the display of a completed restart day. Never step any model or rank continuation. */
async function runRestartReviewedPublication(
  input: Parameters<typeof runUsGapReplay>[0],
  manifest: UsReplayManifest,
) {
  const { client, userId } = input;
  if (
    manifest.sessions.length !== 1 ||
    manifest.sessions[0]!.date < RESTART_ACCOUNTING_START ||
    manifest.sessions[0]!.pit.kind !== "REVIEWED_ATOMIC_QUARANTINE" ||
    !manifest.sessions[0]!.originalSource ||
    input.publishRecoveredView ||
    (input.apply && !input.publishDailyScreen)
  )
    throw new Error("Restart reviewed input requires single-session publication-only mode");
  const [reviewed] = await loadVerifiedUsReplaySessions(
    manifest,
    async (path) => (await readText(client, path))!,
  );
  const source = reviewed!.source;
  const protectedRows = await protectedHistory(client, userId, manifest.baseDate, source.date);
  const original = protectedRows.find((row) => row.date === source.date);
  if (
    !original ||
    original.data_hash !== source.originalSource!.dataHash ||
    original.rule_version !== US_PROSPECTIVE_RULE_VERSION
  )
    throw new Error("Restart reviewed publication requires exact completed original history");
  const raw = (await readText(client, source.originalSource!.storagePath))!;
  if (bytesHash(raw) !== original.data_hash)
    throw new Error("Restart original source identity mismatch");
  const originalRows = parseUsProspectiveCsv(raw);
  const sourceHash = await hashSeriesValue({
    version: "us-shadow-dated-input-v1",
    date: source.date,
    rows: [...originalRows].sort((a, b) => a.symbol.localeCompare(b.symbol)),
  });
  const store = octoberShadowStore(client, userId, "service");
  async function completedModels() {
    const proofs = [];
    for (const kind of ["US_A0", "US_A2", "US_B3"]) {
      const bookId = `${activeSeriesVersion(source.date)}:${kind}`;
      const series = await store.readSeries(bookId);
      const run = await store.readSession<OctoberRun>(bookId, source.date);
      if (!series || !run) throw new Error("Restart original model completion is missing");
      if (series.bookId !== bookId || series.policy.kind !== kind)
        throw new Error("Restart model registry identity mismatch");
      await assertStoredOctoberRun(series, run);
      if (
        series.accountingStartDate !== RESTART_ACCOUNTING_START ||
        run.receipt.date !== source.date ||
        run.publication?.sourceHash !== sourceHash
      )
        throw new Error("Restart original model source identity mismatch");
      proofs.push({ bookId, contractHash: series.contractHash, stateHash: run.stateHash });
    }
    return proofs;
  }
  const models = await completedModels();
  let rank: UsProspectivePreviousState | undefined;
  if (source.date !== RESTART_ACCOUNTING_START) {
    if (manifest.baseDate < RESTART_ACCOUNTING_START)
      throw new Error("Restart reviewed predecessor crosses the restart boundary");
    const predecessor = protectedRows.find((row) => row.date === manifest.baseDate);
    if (!predecessor || predecessor.rule_version !== US_PROSPECTIVE_RULE_VERSION)
      throw new Error("Restart reviewed predecessor history is missing");
    const previous = JSON.parse(
      (await readText(client, `${userId}/results/us-screening/${manifest.baseDate}.json`))!,
    );
    if (previous.analysis?.state?.lastDate !== manifest.baseDate)
      throw new Error("Restart reviewed predecessor rank identity mismatch");
    rank = previous.analysis.state;
  }
  const originalResult = JSON.parse(
    (await readText(client, `${userId}/results/us-screening/${source.date}.json`))!,
  );
  const recomputedOriginal = runUsProspectiveAnalysis(originalRows, rank);
  if (
    stableJson(originalResult.analysis?.state) !== stableJson(recomputedOriginal.state) ||
    stableJson(originalResult.analysis?.summary) !== stableJson(recomputedOriginal.summary)
  )
    throw new Error("Restart original screening rank state does not match its predecessor");
  const prefix = `${userId}/results/us-gap-replay/${input.manifestHash.slice(7)}`;
  const planPath = `${prefix}/reviewed-publication-plan.json`;
  const prior = await readText(client, planPath, true);
  const generatedAt = prior
    ? JSON.parse(prior).generatedAt
    : (input.calculatedAt ?? new Date().toISOString());
  if (
    !Number.isFinite(Date.parse(generatedAt)) ||
    Date.parse(generatedAt) < Date.parse(source.sourceCapturedAt)
  )
    throw new Error("Invalid restart reviewed publication calculation time");
  // This digest identifies read-only completion evidence, not an old operating ledger plan.
  const proofHash = bytesHash(
    stableJson({
      version: "us-restart-publication-proof-v1",
      protectedHistory: protectedRows,
      sourceHash,
      models,
    }),
  );
  if (input.expectedOperatingPlanHash && input.expectedOperatingPlanHash !== proofHash)
    throw new Error("Restart reviewed completion proof differs from expected identity");
  const publication: UsReplayScreeningInput = {
    client,
    userId,
    analyses: [runUsProspectiveAnalysis(reviewed!.rows, rank)],
    sources: [source],
    manifestHash: input.manifestHash,
    operatingPlanHash: proofHash,
    generatedAt,
    protectedHistory: protectedRows,
  };
  await preflightUsReplayScreening(publication);
  const plan = {
    version: "us-restart-reviewed-publication-only-v1",
    manifestHash: input.manifestHash,
    operatingPlanHash: proofHash,
    generatedAt,
    protectedHistory: protectedRows,
    models,
    analysis: publication.analyses[0],
  };
  if (prior && stableJson(JSON.parse(prior)) !== stableJson(plan))
    throw new Error("Restart reviewed immutable publication plan changed");
  if (
    stableJson(await protectedHistory(client, userId, manifest.baseDate, source.date)) !==
      stableJson(protectedRows) ||
    stableJson(await completedModels()) !== stableJson(models)
  )
    throw new Error("Restart original completion changed during publication preflight");
  if (input.apply) {
    await immutableJson(client, planPath, plan);
    await finishDailyScreening(publication);
  }
  return {
    mode: input.apply ? "PUBLICATION_ONLY" : "READ_ONLY",
    baseDate: manifest.baseDate,
    throughDate: source.date,
    sessions: 1,
    operatingPlanHash: proofHash,
    sourceCoverageComplete: source.sourceCoverageComplete,
    protectedOriginalResults: protectedRows.length,
    applied: input.apply,
    screeningPublished: input.apply,
    originalModelsPreserved: true,
  };
}

/** Current recovery is a separate restart-only journal. No legacy operating reads or RPCs. */
async function runRestartUsGapReplay(
  input: Parameters<typeof runUsGapReplay>[0],
  manifest: UsReplayManifest,
  manifestBytes: string,
) {
  const { client, userId } = input;
  if (manifest.sessions.some((s) => s.date < RESTART_ACCOUNTING_START))
    throw new Error("Split historical and restart US recovery manifests at 2026-10-12");
  if (
    manifest.sessions.some((s) => s.originalSource || s.pit.kind === "REVIEWED_ATOMIC_QUARANTINE")
  )
    throw new Error(
      "Restart model replay requires original dated sources, not publication-only quarantine",
    );
  if (
    input.publishDailyScreen &&
    manifest.sessions.some((s) => s.pit.kind !== "ATOMIC_DATED_SNAPSHOT")
  )
    throw new Error("Automatic daily publication requires preserved ATOMIC inputs");
  const prefix = `${userId}/results/us-gap-replay/${input.manifestHash.slice(7)}`;
  type RestartPlan = {
    version: "us-restart-gap-replay-v1";
    manifestHash: string;
    calculatedAt: string;
    protectedHistory: ProtectedSource[];
    shadow: Awaited<ReturnType<typeof planUsShadowReplay>>;
    planHash: string;
  };
  const savedText = await readText(client, `${prefix}/plan.json`, true);
  const saved = savedText ? (JSON.parse(savedText) as RestartPlan) : null;
  if (saved) {
    const { planHash, ...payload } = saved;
    if (
      saved.version !== "us-restart-gap-replay-v1" ||
      saved.manifestHash !== input.manifestHash ||
      bytesHash(stableJson(payload)) !== planHash
    )
      throw new Error("Restart US recovery plan identity mismatch");
  }
  const sessions = await loadVerifiedUsReplaySessions(
    manifest,
    async (path) => (await readText(client, path))!,
  );
  const calculatedAt = saved?.calculatedAt ?? input.calculatedAt ?? new Date().toISOString();
  if (
    !Number.isFinite(Date.parse(calculatedAt)) ||
    sessions.some((s) => Date.parse(s.source.sourceCapturedAt) > Date.parse(calculatedAt))
  )
    throw new Error("US replay cannot consume a future source");
  const currentHistory = await protectedHistory(
    client,
    userId,
    manifest.baseDate,
    manifest.throughDate,
  );
  const protectedRows = saved?.protectedHistory ?? currentHistory;
  if (
    saved &&
    stableJson(
      currentHistory.filter((row) => protectedRows.some((old) => old.date === row.date)),
    ) !== stableJson(protectedRows)
  )
    throw new Error("Protected US screening history changed since recovery preparation");
  let rank: UsProspectivePreviousState | undefined;
  if (sessions[0]!.source.date !== RESTART_ACCOUNTING_START) {
    if (manifest.baseDate < RESTART_ACCOUNTING_START)
      throw new Error("Missing restart opening session");
    for (const path of [
      `${userId}/results/us-replay-state/${manifest.baseDate}.json`,
      `${userId}/results/shadow-replay/US/${manifest.baseDate}.json`,
      `${userId}/results/us-screening/${manifest.baseDate}.json`,
    ]) {
      const text = await readText(client, path, true);
      if (!text) continue;
      const value = JSON.parse(text);
      if (
        value.analysis?.ruleVersion !== US_PROSPECTIVE_RULE_VERSION ||
        value.analysis?.state?.lastDate !== manifest.baseDate
      )
        throw new Error("Restart US predecessor rank identity mismatch");
      rank = value.analysis.state;
      break;
    }
    if (!rank) throw new Error("Restart US recovery has no exact predecessor rank state");
  }
  const store = octoberShadowStore(client, userId, "service");
  const shadow = await planUsShadowReplay({
    store,
    baseDate: manifest.baseDate,
    previousRankState: rank,
    sessions,
    calculatedAt,
  });
  const payload = {
    version: "us-restart-gap-replay-v1" as const,
    manifestHash: input.manifestHash,
    calculatedAt,
    protectedHistory: protectedRows,
    shadow,
  };
  const plan: RestartPlan = { ...payload, planHash: bytesHash(stableJson(payload)) };
  if (
    (saved && stableJson(saved) !== stableJson(plan)) ||
    (input.expectedOperatingPlanHash && input.expectedOperatingPlanHash !== plan.planHash)
  )
    throw new Error("Restart US recovery differs from the exact immutable plan");
  const rankArtifacts = shadow.analyses.map((analysis, i) => ({
    path: `${userId}/results/us-replay-state/${analysis.date}.json`,
    artifact: {
      version: "us-replay-state-v1",
      manifestHash: input.manifestHash,
      dataHash: sessions[i]!.source.dataHash,
      source: sessions[i]!.source,
      replayMode: "RETROSPECTIVE",
      originalScreeningPreserved: true,
      analysis: {
        date: analysis.date,
        ruleVersion: analysis.ruleVersion,
        summary: analysis.summary,
        state: analysis.state,
      },
    },
  }));
  for (const item of rankArtifacts) {
    const old = await readText(client, item.path, true);
    if (old !== null && stableJson(JSON.parse(old)) !== stableJson(item.artifact))
      throw new Error("Restart rank artifact conflict");
  }
  const daily: UsReplayScreeningInput = {
    client,
    userId,
    analyses: shadow.analyses,
    sources: manifest.sessions,
    manifestHash: input.manifestHash,
    operatingPlanHash: plan.planHash,
    generatedAt: calculatedAt,
    protectedHistory: protectedRows,
  };
  let recovered: UsRecoveryPublicationInput | undefined;
  if (input.publishDailyScreen) await preflightUsReplayScreening(daily);
  if (input.publishRecoveredView) {
    const protectedOriginal = protectedRows.find((row) => row.date === manifest.throughDate);
    if (!protectedOriginal)
      throw new Error("Recovered current-date publication requires an original result");
    recovered = {
      client,
      userId,
      analysis: shadow.analyses.at(-1)!,
      source: manifest.sessions.at(-1)!,
      manifestHash: input.manifestHash,
      operatingPlanHash: plan.planHash,
      generatedAt: calculatedAt,
      protectedOriginal,
    };
    await preflightUsRecoveryPublication(recovered);
  }
  const summary = {
    mode: input.apply ? "APPLY" : "PREFLIGHT",
    baseDate: manifest.baseDate,
    throughDate: manifest.throughDate,
    sessions: sessions.length,
    restartPlanHash: plan.planHash,
    operatingPlanHash: plan.planHash,
    sourceCoverageComplete: sessions.every((s) => s.source.sourceCoverageComplete),
    protectedOriginalResults: protectedRows.length,
  };
  if (!input.apply) return { ...summary, applied: false };
  await client.storage.from(ANALYSIS_BUCKET).upload(`${prefix}/manifest.json`, manifestBytes, {
    contentType: "application/json",
    upsert: false,
  });
  if ((await readText(client, `${prefix}/manifest.json`)) !== manifestBytes)
    throw new Error("Immutable restart manifest conflict");
  await immutableJson(client, `${prefix}/plan.json`, plan);
  for (const item of rankArtifacts) await immutableJson(client, item.path, item.artifact);
  const { stageIntegratedUsEvidence, replayIntegratedAllocationAvailable } =
    await import("../src/lib/integratedAllocationReplay.server");
  for (const publication of shadow.publications)
    await stageIntegratedUsEvidence(client, userId, {
      analysis: publication.analysis,
      sourceHash: publication.sourceHash,
      availableAt: publication.availableAt,
      decisionAt: publication.decisionAt,
      calculatedAt,
    });
  const results = await commitUsShadowReplay(store, shadow);
  const after = await protectedHistory(client, userId, manifest.baseDate, manifest.throughDate);
  if (stableJson(after) !== stableJson(currentHistory))
    throw new Error("Original US history changed during restart recovery");
  await immutableJson(client, `${prefix}/receipt.json`, {
    version: "us-restart-gap-replay-receipt-v1",
    manifestHash: input.manifestHash,
    planHash: plan.planHash,
    calculatedAt,
    baseDate: manifest.baseDate,
    throughDate: manifest.throughDate,
    applied: true,
    shadowStateHashes: results.map((r) => ({
      date: r.date,
      records: r.records.map(({ bookId, stateHash }) => ({ bookId, stateHash })),
    })),
  });
  let integratedAllocation;
  try {
    integratedAllocation = await replayIntegratedAllocationAvailable(
      client,
      userId,
      manifest.throughDate,
      calculatedAt,
      "service",
    );
  } catch (error) {
    integratedAllocation = {
      recorded: 0,
      waiting:
        error instanceof Error ? error.message : "Integrated allocation evidence unavailable",
    };
  }
  if (input.publishDailyScreen) await finishDailyScreening(daily);
  if (recovered) {
    const published = await publishUsRecoveryViews(recovered);
    await immutableJson(client, `${prefix}/publication-receipt.json`, {
      version: "us-restart-recovery-publication-receipt-v1",
      manifestHash: input.manifestHash,
      planHash: plan.planHash,
      date: published.analysis.date,
      dataHash: published.dataHash,
      publishedHash: bytesHash(stableJson(published)),
    });
  }
  return {
    ...summary,
    applied: true,
    screeningPublished: Boolean(input.publishDailyScreen || recovered),
    integratedAllocation,
  };
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
    publishDailyScreen: process.argv.includes("--publish-daily-screen"),
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
