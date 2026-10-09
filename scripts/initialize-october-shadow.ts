import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ADOPTED_SERIES_KINDS,
  ADOPTED_SERIES_VERSION,
  freezeAdoptedSeries,
  freezeRestartSeries,
  RESTART_SERIES_VERSION,
  hashSeriesValue,
  initializeModelSeries,
  verifyFrozenSeries,
  canonicalSeriesJson,
  VERIFIED_INITIAL_FX,
  type FrozenModelSeries,
} from "../src/lib/ledger/modelSeries";
import { OCTOBER_CALENDAR_EVIDENCE } from "../src/lib/ledger/octoberShadowCalendar";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { adoptedShadowFrozenCodeHash, shadowEngineManifest } from "./october-shadow-code-manifest";
import {
  octoberShadowStore,
  type OctoberShadowStore,
} from "../src/lib/ledger/octoberShadowRepository.server";
import { trustedSupabaseClient } from "./analysis-run-store";

export async function planOctoberShadowInitialization(frozenAt = new Date().toISOString()) {
  const { manifest, codeHash: runtimeCodeHash } = await shadowEngineManifest();
  const codeHash = adoptedShadowFrozenCodeHash(runtimeCodeHash);
  const sourceManifest = {
    version: "october-shadow-opening-v1",
    source: "AUTHORIZED_FRESH_CASH_ONLY",
    calendarEvidence: OCTOBER_CALENDAR_EVIDENCE,
    initialFx: VERIFIED_INITIAL_FX,
    scoring: DEFAULT_SCORING_CONFIG,
  };
  const sourceHash = await hashSeriesValue(sourceManifest);
  const series = await Promise.all(
    ADOPTED_SERIES_KINDS.map((kind) =>
      freezeAdoptedSeries({
        kind,
        frozenAt,
        codeHash,
        sourceHash,
        ...(kind.startsWith("US_") ? { initialFx: VERIFIED_INITIAL_FX } : {}),
      }),
    ),
  );
  return {
    manifest,
    runtimeCodeHash,
    frozenCodeHash: codeHash,
    sourceManifest,
    series,
    openingStates: series.map(initializeModelSeries),
  };
}
/** Explicit fresh start: no beta positions, pending orders or originating signals. */
export async function planRestartShadowInitialization(frozenAt = new Date().toISOString()) {
  const { manifest, codeHash: runtimeCodeHash } = await shadowEngineManifest();
  const codeHash = adoptedShadowFrozenCodeHash(runtimeCodeHash);
  const sourceManifest = {
    version: "october-shadow-opening-v2",
    source: "AUTHORIZED_FRESH_CASH_ONLY",
    calendarEvidence: OCTOBER_CALENDAR_EVIDENCE,
    initialFx: { rate: "1339.2", publishedDate: "2026-10-08", source: "OWNER_APPROVED_20261009" },
    scoring: DEFAULT_SCORING_CONFIG,
  };
  const sourceHash = await hashSeriesValue(sourceManifest);
  const series = await Promise.all(
    ADOPTED_SERIES_KINDS.map((kind) =>
      freezeRestartSeries({ kind, frozenAt, codeHash, sourceHash }),
    ),
  );
  return {
    manifest,
    runtimeCodeHash,
    frozenCodeHash: codeHash,
    sourceManifest,
    series,
    openingStates: series.map(initializeModelSeries),
  };
}
export type OctoberShadowInitializationPlan = Awaited<
  | ReturnType<typeof planOctoberShadowInitialization>
  | ReturnType<typeof planRestartShadowInitialization>
>;

/** The plan is intent, not evidence of the persisted freeze timestamps or contracts.
 * Only a complete independent registry readback may become an applied-result artifact.
 */
export async function applyOctoberShadowInitialization(
  plan: OctoberShadowInitializationPlan,
  store: Pick<OctoberShadowStore, "readSeries" | "insertSeries">,
) {
  if (
    canonicalSeriesJson(plan.series.map((series) => series.policy.kind)) !==
    canonicalSeriesJson(ADOPTED_SERIES_KINDS)
  )
    throw new Error("Initialization requires the complete ordered series plan");
  const expected: FrozenModelSeries[] = [];
  const reusedBookIds = new Set<string>();
  for (const series of plan.series) {
    await verifyFrozenSeries(series);
    const existing = await store.readSeries(series.bookId);
    if (existing) reusedBookIds.add(series.bookId);
    // Retries preserve each successfully persisted contract, including its original frozenAt.
    const candidate = existing
      ? series.version === RESTART_SERIES_VERSION
        ? await freezeRestartSeries({
            kind: series.policy.kind,
            codeHash: series.codeHash,
            sourceHash: series.sourceHash,
            frozenAt: existing.frozenAt,
            existing,
          })
        : await freezeAdoptedSeries({
            kind: series.policy.kind,
            codeHash: series.codeHash,
            sourceHash: series.sourceHash,
            frozenAt: existing.frozenAt,
            ...(series.fx ? { initialFx: VERIFIED_INITIAL_FX } : {}),
            existing,
          })
      : series;
    await store.insertSeries(candidate);
    expected.push(candidate);
  }
  const verified: FrozenModelSeries[] = [];
  for (const candidate of expected) {
    const actual = await store.readSeries(candidate.bookId);
    if (!actual) throw new Error(`Applied model registry readback is missing: ${candidate.bookId}`);
    await verifyFrozenSeries(actual);
    if (canonicalSeriesJson(actual) !== canonicalSeriesJson(candidate))
      throw new Error(`Applied model registry readback differs: ${candidate.bookId}`);
    verified.push(structuredClone(actual));
  }
  return {
    artifact: "VERIFIED_REGISTRY_READBACK" as const,
    version: plan.series[0]!.version,
    verifiedAt: new Date().toISOString(),
    planHash: await hashSeriesValue({ artifact: "INITIALIZATION_PLAN", ...plan }),
    series: verified,
    reusedBookIds: [...reusedBookIds],
    reusedContracts: verified
      .filter((series) => reusedBookIds.has(series.bookId))
      .map(({ bookId, contractHash, frozenAt }) => ({ bookId, contractHash, frozenAt })),
    openingStates: verified.map(initializeModelSeries),
    sessionsInserted: 0 as const,
  };
}

export async function runOctoberShadowInitialization(args = process.argv.slice(2)) {
  const output = args[args.indexOf("--output") + 1];
  if (!args.includes("--output") || !output)
    throw new Error(
      "Usage: --output <private-directory> [--restart-20261012] [--apply --user <uuid>]",
    );
  const plan = args.includes("--restart-20261012")
    ? await planRestartShadowInitialization()
    : await planOctoberShadowInitialization();
  const folder = path.resolve(output);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const planPath = path.join(folder, "october-shadow-initialization.json");
  let verifiedPath: string | null = null;
  await writeFile(planPath, JSON.stringify({ artifact: "INITIALIZATION_PLAN", ...plan }, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  if (args.includes("--apply")) {
    const userIndex = args.indexOf("--user");
    const uid = userIndex >= 0 ? args[userIndex + 1] : process.env["SUPABASE_USER_ID"];
    if (!uid) throw new Error("A verified --user is required");
    const store = octoberShadowStore(trustedSupabaseClient(), uid);
    const verified = await applyOctoberShadowInitialization(plan, store);
    verifiedPath = path.join(folder, "october-shadow-initialization-verified.json");
    await writeFile(verifiedPath, JSON.stringify({ ownerId: uid, ...verified }, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  }
  console.log(
    JSON.stringify({
      version: plan.series[0]!.version,
      initialized: args.includes("--apply"),
      series: plan.series.map((s: FrozenModelSeries) => s.policy.kind),
      sessionsInserted: 0,
      output: folder,
      planArtifact: planPath,
      verifiedArtifact: verifiedPath,
    }),
  );
}
if (!process.env["VITEST"])
  runOctoberShadowInitialization().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
