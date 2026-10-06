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
import { persistKospiShadow, type ShadowObjectStore } from "../src/lib/kospiShadowStore";
import { isKrOfficialShadowDecision } from "../src/lib/ledger/krShadowDecision";
function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}
export async function runKospiShadow() {
  const dryRun = process.argv.includes("--dry-run");
  if (
    !dryRun &&
    (process.env["GITHUB_ACTIONS"] !== "true" ||
      process.env["GITHUB_WORKFLOW"] !== "KOSPI prospective Shadow" ||
      process.env["GITHUB_REF"] !== "refs/heads/main")
  )
    throw new Error(
      "Shadow publication is restricted to its serialized main-branch workflow; use --dry-run locally",
    );
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
  const inputs = await loadAnalysisSourceInputs(client, uid, "screening", { compact: true });
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
  const relevant = inputs.filter((i) => i.validation.stats.maxDate === date);
  if (!relevant.length) throw new Error("No registered source declares the requested close date");
  const sourceCollectedAt = relevant
    .map((i) => i.savedAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1)!;
  const decisionAt = new Date().toISOString();
  const official = isKrOfficialShadowDecision(date, sourceCollectedAt, decisionAt);
  if (!dryRun && !official) {
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
  const result = await persistKospiShadow(store, uid, session, frozenConfig);
  console.log(
    JSON.stringify({
      strategy: KOSPI_SHADOW_POLICY.label,
      role: "SHADOW",
      date,
      initializedDate: result.view.registry.initializedDate,
      reused: result.reused,
      navKrw: result.view.latest.daily.navKrw,
      modelEntries: result.view.latest.state.totalEntries,
      ruleVersion: KOSPI_SHADOW_POLICY.version,
    }),
  );
}
runKospiShadow().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
