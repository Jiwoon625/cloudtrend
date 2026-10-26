import { verifyKrScreeningPublication } from "../src/lib/krScreeningPublication.server";
import { readFile } from "node:fs/promises";
import { verifyKospiShadowRuntimeManifest } from "./verify-kospi-shadow-runtime";
import { verifyShadowRuntimeManifests } from "./verify-shadow-runtime-manifests";
import process from "node:process";
import {
  ANALYSIS_BUCKET,
  codeVersion,
  sha256,
  stableJson,
  trustedSupabaseClient,
} from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { KOSPI_SHADOW_POLICY } from "../src/lib/engine/kospiShadow";
import { buildKospiShadowSession } from "../src/lib/engine/kospiShadowDataset";
import {
  persistKospiShadow,
  reuseCompletedKospiShadow,
  type ShadowObjectStore,
} from "../src/lib/kospiShadowStore";
import { isKrLiveShadowDecision } from "../src/lib/krShadowAdmission";
import {
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
  initializeKospiShadowRevision,
  openKospiShadowRevisionStore,
  kospiShadowRevisionPath,
  validateKospiShadowRevision,
  type KospiShadowRevisionApproval,
} from "../src/lib/kospiShadowSeries";
import { shadowObjectPath } from "../src/lib/kospiShadowStore";
import type { KospiShadowSession } from "../src/lib/engine/kospiShadow";
import { sourceTimingEvidence } from "../src/lib/sourceTimingEvidence";
import { recoveryCutoff, runLateRecovery } from "./kospi-shadow-late-recovery";
function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}
/** Fixed, owner-private correction approval only. No arbitrary path or in-place revision. */
export async function publishKospiShadowTarget(
  store: ShadowObjectStore,
  uid: string,
  session: KospiShadowSession,
  config: unknown,
  computedAt: string,
  initializeCorrection: boolean,
) {
  if (session.date < "2026-10-14") {
    if (initializeCorrection) throw new Error("Correction requires its exact reviewed date");
    return persistKospiShadow(store, uid, session, config);
  }
  if (!initializeCorrection) {
    const revisionStore = await openKospiShadowRevisionStore(store, uid);
    return persistKospiShadow(revisionStore, uid, session, config);
  }
  if (process.env["GITHUB_EVENT_NAME"] !== "workflow_dispatch" || session.date !== "2026-10-14")
    throw new Error("Retrospective correction requires an explicit manual exact-date dispatch");
  const root = shadowObjectPath(uid, "registry.json").replace(/\/registry\.json$/, "");
  const approved = await store.read<Omit<KospiShadowRevisionApproval, "computedAt">>(
    `${root}/correction-approvals/${KOSPI_SHADOW_CORRECTION_REVISION_ID}.json`,
  );
  const keys = [
    "revisionId",
    "predecessorDate",
    "correctionDate",
    "expectedPredecessorHash",
    "expectedOriginalTargetHash",
    "expectedCorrectedSourceHash",
  ];
  if (
    !approved ||
    JSON.stringify(Object.keys(approved).sort()) !== JSON.stringify(keys.sort()) ||
    approved.revisionId !== KOSPI_SHADOW_CORRECTION_REVISION_ID
  )
    throw new Error("Reviewed private KOSPI correction approval is required");
  const existing = await store.read(kospiShadowRevisionPath(uid, "revision.json"));
  if (existing) {
    const revision = validateKospiShadowRevision(existing);
    if (
      revision.expectedPredecessorHash !== approved.expectedPredecessorHash ||
      revision.expectedOriginalTargetHash !== approved.expectedOriginalTargetHash ||
      revision.correctedSourceHash !== approved.expectedCorrectedSourceHash ||
      revision.predecessorDate !== approved.predecessorDate ||
      revision.correctionDate !== approved.correctionDate
    )
      throw new Error("Immutable KOSPI correction approval changed");
    computedAt = revision.computedAt;
  }
  if (!Number.isFinite(Date.parse(computedAt)) || Date.parse(computedAt) > Date.now())
    throw new Error("Actual KOSPI correction calculation time required");
  return initializeKospiShadowRevision(store, uid, session, config, { ...approved, computedAt });
}

export async function runKospiShadow() {
  let recoveryMode = arg("--recovery-mode");
  let recoveryDates = arg("--recovery-dates");
  let expectedPlan = arg("--expected-plan");
  const requestPath = process.env["KOSPI_LATE_RECOVERY_REQUEST"];
  if (requestPath) {
    if (
      requestPath !== ".github/requests/kospi-late-recovery-20261021.json" ||
      process.env["GITHUB_EVENT_NAME"] !== "push" ||
      process.env["GITHUB_REF"] !== "refs/heads/main" ||
      recoveryMode ||
      recoveryDates ||
      expectedPlan
    )
      throw new Error("Invalid fixed late recovery request context");
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    const keys = Object.keys(request).sort().join(",");
    if (
      keys !== "dates,expectedPlan,mode,version" ||
      request.version !== "kospi-preopen-late-v1" ||
      !["dry-run", "apply"].includes(request.mode) ||
      JSON.stringify(request.dates) !== '["2026-10-19","2026-10-20"]' ||
      (request.mode === "apply"
        ? !/^sha256:[a-f0-9]{64}$/.test(request.expectedPlan)
        : request.expectedPlan !== null)
    )
      throw new Error("Invalid fixed late recovery request content");
    recoveryMode = request.mode;
    recoveryDates = request.dates.join(",");
    expectedPlan = request.expectedPlan;
  }
  if (recoveryMode && !["dry-run", "apply"].includes(recoveryMode))
    throw new Error("Invalid late recovery mode");
  if ((recoveryMode && !recoveryDates) || (!recoveryMode && (recoveryDates || expectedPlan)))
    throw new Error("Incomplete late recovery arguments");
  const dryRun = process.argv.includes("--dry-run");
  const verifyCompleted = process.argv.includes("--verify-completed");
  if (
    verifyCompleted &&
    (dryRun ||
      recoveryMode ||
      requestPath ||
      process.argv.includes("--initialize-correction") ||
      process.argv.filter((value) => value === "--as-of").length !== 1 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(arg("--as-of") ?? ""))
  )
    throw new Error(
      "Completed verification requires one exact --as-of and no publication/recovery mode",
    );
  const initializeCorrection = process.argv.includes("--initialize-correction");
  if (recoveryMode && (initializeCorrection || dryRun || arg("--as-of")))
    throw new Error("Late recovery cannot initialize or override current source date");
  if (
    initializeCorrection &&
    (process.argv.filter((value) => value === "--as-of").length !== 1 ||
      arg("--as-of") !== "2026-10-14")
  )
    throw new Error("Correction requires an explicitly supplied --as-of 2026-10-14");
  if (initializeCorrection && (dryRun || process.env["GITHUB_EVENT_NAME"] !== "workflow_dispatch"))
    throw new Error("Correction is a separate manual publication, not a preview or automatic run");
  if (
    !dryRun &&
    !verifyCompleted &&
    (process.env["GITHUB_ACTIONS"] !== "true" ||
      process.env["GITHUB_WORKFLOW"] !== "KOSPI prospective Shadow" ||
      process.env["GITHUB_REF"] !== "refs/heads/main")
  )
    throw new Error(
      "Shadow publication is restricted to its serialized main-branch workflow; use --dry-run locally",
    );
  await verifyShadowRuntimeManifests();
  await verifyKospiShadowRuntimeManifest();
  const uid = arg("--user") ?? process.env["SUPABASE_USER_ID"];
  if (!uid) throw new Error("SUPABASE_USER_ID is required");
  const client = trustedSupabaseClient();
  const store: ShadowObjectStore = {
    read: async <T>(path: string) => {
      const { data, error } = await client.storage
        .from(ANALYSIS_BUCKET)
        .download(path, { cacheNonce: crypto.randomUUID() }, { cache: "no-store" });
      if (error) {
        if (String(error.statusCode) === "404" || error.message === "Object not found") return null;
        throw new Error(`Shadow read failed: ${error.message}`);
      }
      return JSON.parse(await data.text()) as T;
    },
    latestSessionDate: async (path) => {
      const { data, error } = await client.storage
        .from(ANALYSIS_BUCKET)
        .list(path, { limit: 1, sortBy: { column: "name", order: "desc" } });
      if (error) throw new Error(`Shadow journal listing failed: ${error.message}`);
      const name = data?.[0]?.name;
      if (name && !/^\d{4}-\d{2}-\d{2}\.json$/.test(name))
        throw new Error("Unexpected Shadow journal object");
      return name?.replace(".json", "") ?? null;
    },
    putImmutable: async (path, value) => {
      if (verifyCompleted) throw new Error("Completed verification cannot write Shadow objects");
      const { error } = await client.storage
        .from(ANALYSIS_BUCKET)
        .upload(path, JSON.stringify(value), { upsert: false, contentType: "application/json" });
      if (error) {
        const existing = await store.read(path);
        if (existing && stableJson(existing) === stableJson(value)) return;
        throw new Error(`Shadow immutable write failed: ${error.message}`);
      }
    },
    putLatest: async (path, value) => {
      if (verifyCompleted) throw new Error("Completed verification cannot write Shadow objects");
      const { error } = await client.storage
        .from(ANALYSIS_BUCKET)
        .upload(path, JSON.stringify(value), {
          upsert: true,
          contentType: "application/json",
          cacheControl: "0",
        });
      if (error) throw new Error(`Shadow latest write failed: ${error.message}`);
    },
  };
  if (recoveryMode) {
    if (process.env["GITHUB_EVENT_NAME"] !== "workflow_dispatch" && !requestPath)
      throw new Error("Manual late recovery requires explicit dispatch");
    if (recoveryMode === "apply") {
      // Historical recovery is still a financial write. A pending current source cannot
      // bypass the same owner-wide hold by entering through the recovery branch.
      const current = await loadAnalysisSourceInputs(client, uid, "screening", { compact: true });
      const publication = await verifyKrScreeningPublication(
        client,
        uid,
        current.flatMap((input) => (input.sourceRecord ? [input.sourceRecord] : [])),
        current.map((input) => input.text),
      );
      if (publication.phase === "PRELIMINARY") {
        console.log(
          JSON.stringify({ status: "PRELIMINARY", financialSideEffects: "SKIPPED", publication }),
        );
        return;
      }
    }
    await runLateRecovery(
      client,
      store,
      uid,
      recoveryDates!.split(","),
      recoveryMode as "dry-run" | "apply",
      expectedPlan,
    );
    return;
  }
  const inputs = await loadAnalysisSourceInputs(client, uid, "screening", { compact: true });
  const publication = await verifyKrScreeningPublication(
    client,
    uid,
    inputs.flatMap((input) => (input.sourceRecord ? [input.sourceRecord] : [])),
    inputs.map((input) => input.text),
  );
  if (publication.phase === "PRELIMINARY") {
    console.log(
      JSON.stringify({ status: "PRELIMINARY", financialSideEffects: "SKIPPED", publication }),
    );
    return;
  }
  const { dataset } = parseManualMarketData(inputs.map((i) => i.text));
  const date = arg("--as-of") ?? dataset.asOfDate;
  if (!dryRun && date !== dataset.asOfDate)
    throw new Error(
      "Publishing requires an exact-date source snapshot; newer undated membership/ETF facts cannot repair an older session",
    );
  if (date < KOSPI_SHADOW_POLICY.earliestStartDate) {
    console.log("Shadow awaiting first prospective source close; older research is not imported.");
    return;
  }
  // The complete source set becomes decision-ready only when its latest required
  // constituent has been registered. Same-evening data remains preview-only.
  const relevant = inputs
    .flatMap((input) =>
      sourceTimingEvidence(
        input.sourceRecord ?? {
          min_date: input.validation.stats.minDate,
          max_date: input.validation.stats.maxDate,
          savedAt: input.savedAt,
        },
      ),
    )
    .filter((source) => source.max_date === date);
  if (!relevant.length) throw new Error("No registered source declares the requested close date");
  const sourceCollectedAt = relevant
    .map((source) => source.activated_at ?? source.savedAt ?? source.created_at ?? "")
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1)!;
  const decisionAt = new Date().toISOString();
  const official = isKrLiveShadowDecision(date, sourceCollectedAt, decisionAt);
  if (
    !dryRun &&
    !verifyCompleted &&
    !initializeCorrection &&
    !official &&
    Date.parse(decisionAt) < Date.parse(recoveryCutoff(date).cutoff)
  ) {
    // Keep evening/unrefreshed inputs preview-only without calculating a session.
    console.log(
      JSON.stringify({
        strategy: KOSPI_SHADOW_POLICY.label,
        role: "SHADOW",
        date,
        status: "PREVIEW_ONLY",
        reason: "KR Shadow waits for the next regular-session morning KRX refresh",
      }),
    );
    return;
  }
  const frozenConfig = { policy: KOSPI_SHADOW_POLICY, scoring: DEFAULT_SCORING_CONFIG };
  const session = buildKospiShadowSession(
    dataset,
    DEFAULT_SCORING_CONFIG,
    {
      sourceHash: `sha256:${sha256(
        inputs
          .map((i) => i.dataHash)
          .sort()
          .join("\n"),
      )}`,
      configHash: `sha256:${sha256(stableJson(frozenConfig))}`,
      codeVersion: codeVersion(),
      sourceCollectedAt,
      now: decisionAt,
    },
    date,
  );
  if (verifyCompleted) {
    const target = date < "2026-10-14" ? store : await openKospiShadowRevisionStore(store, uid);
    const completed = await reuseCompletedKospiShadow(target, uid, session, frozenConfig);
    if (!completed)
      throw new Error("No ordinary completed Shadow date available for read-only proof");
    console.log(
      JSON.stringify({
        strategy: KOSPI_SHADOW_POLICY.label,
        role: "SHADOW",
        date,
        status: "COMPLETED_INPUT_VERIFIED",
        readOnly: true,
        reuseReason:
          completed.view.latest.source.sourceHash === session.sourceHash
            ? "EXACT_SOURCE"
            : "VERIFIED_EQUIVALENT_INPUT",
        recordedSourceHash: completed.view.latest.source.sourceHash,
        observedSourceHash: session.sourceHash,
        recordedCodeVersion: completed.view.latest.source.codeVersion,
        observedCodeVersion: session.codeVersion,
      }),
    );
    return;
  }
  if (!dryRun && !initializeCorrection && !official) {
    // Late execution uses a verified pre-open input manifest, never a synthetic decision clock.
    if (Date.parse(decisionAt) >= Date.parse(recoveryCutoff(date).cutoff)) {
      // A completed date needs no new admission or write. Prove equivalence from
      // its authoritative journal before falling back to late-session recovery.
      const target = date < "2026-10-14" ? store : await openKospiShadowRevisionStore(store, uid);
      const completed = await reuseCompletedKospiShadow(target, uid, session, frozenConfig);
      if (completed) {
        console.log(
          JSON.stringify({
            strategy: KOSPI_SHADOW_POLICY.label,
            role: "SHADOW",
            date,
            reused: true,
            readOnly: true,
            reuseReason:
              completed.view.latest.source.sourceHash === session.sourceHash
                ? "EXACT_SOURCE"
                : "VERIFIED_EQUIVALENT_INPUT",
            recordedSourceHash: completed.view.latest.source.sourceHash,
            observedSourceHash: session.sourceHash,
            recordedCodeVersion: completed.view.latest.source.codeVersion,
            observedCodeVersion: session.codeVersion,
          }),
        );
        return;
      }
      await runLateRecovery(client, store, uid, [date], "auto");
      return;
    }
    console.log(
      JSON.stringify({
        strategy: KOSPI_SHADOW_POLICY.label,
        role: "SHADOW",
        date,
        status: "PREVIEW_ONLY",
        reason: "KR Shadow waits for the next regular-session morning KRX refresh",
      }),
    );
    return;
  }
  if (dryRun) {
    console.log(
      JSON.stringify({
        date: session.date,
        rows: session.rows.length,
        gate: session.gate.status,
        sourceHash: session.sourceHash,
        officialDecisionWindow: official,
        dryRun: true,
      }),
    );
    return;
  }
  const result = await publishKospiShadowTarget(
    store,
    uid,
    session,
    frozenConfig,
    decisionAt,
    initializeCorrection,
  );
  console.log(
    JSON.stringify({
      strategy: KOSPI_SHADOW_POLICY.label,
      role: "SHADOW",
      date,
      initializedDate: result.view.registry.initializedDate,
      reused: result.reused,
      reuseReason: result.reused
        ? result.view.latest.source.sourceHash === session.sourceHash
          ? "EXACT_SOURCE"
          : "VERIFIED_EQUIVALENT_INPUT"
        : null,
      recordedSourceHash: result.view.latest.source.sourceHash,
      observedSourceHash: session.sourceHash,
      recordedCodeVersion: result.view.latest.source.codeVersion,
      observedCodeVersion: session.codeVersion,
      navKrw: result.view.latest.daily.navKrw,
      modelEntries: result.view.latest.state.totalEntries,
      ruleVersion: KOSPI_SHADOW_POLICY.version,
    }),
  );
}
if (!process.env["VITEST"])
  runKospiShadow().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
