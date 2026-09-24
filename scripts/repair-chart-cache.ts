import { trustedSupabaseClient } from "./analysis-run-store";
import { loadActiveSources, inputFingerprint } from "../src/lib/screeningSources.server";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { mergeScoringConfig } from "../src/lib/engine/scoring";
import { restoreChartContext, warmRecentCharts } from "../src/lib/instrumentChartStore.server";
async function main() {
  const client = trustedSupabaseClient(),
    uid = process.env.SUPABASE_USER_ID!;
  if (!uid) throw new Error("SUPABASE_USER_ID required");
  const start = Date.now();
  console.log("Starting chart cache diagnosis");
  const stage = (name: string, detail: unknown = {}) =>
    console.log(JSON.stringify({ stage: name, ms: Date.now() - start, detail }));
  const { data: blob, error } = await client.storage
    .from("cloudtrend-data")
    .download(`${uid}/cache/screening/latest.json`);
  if (error) throw error;
  const saved = JSON.parse(await blob.text());
  stage("saved-result");
  const { sources, texts } = await loadActiveSources(client, uid);
  stage("sources-loaded", { count: sources.length });
  const config = mergeScoringConfig(undefined);
  if (inputFingerprint(sources, config) !== saved.inputFingerprint)
    throw new Error("Current source/config fingerprint differs from saved screening");
  const parsed = parseManualMarketData(texts);
  stage("parsed");
  const ctx = restoreChartContext(
    parsed.dataset,
    saved.payload.analysis,
    config,
    saved.resultDigest,
  );
  stage("context-restored");
  await warmRecentCharts(client, uid, saved, ctx);
  stage("charts-ready");
  process.exit(0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
