/** Finish a dated ATOMIC catch-up using its already calculated analyses. No model stepping. */
import {
  ANALYSIS_BUCKET,
  stableJson,
  uploadJson,
  type trustedSupabaseClient,
} from "./analysis-run-store";
import { compactRow, publishBrowserViews } from "./us-screening-publication";
import { preflightUsRecoveryPublication, publishUsRecoveryViews } from "./us-recovery-publication";
import {
  US_PROSPECTIVE_RULE_VERSION,
  usProspectiveCompactSignals,
  type UsProspectiveAnalysis,
} from "../src/lib/engine/usProspective";
import type { UsReplaySessionSource } from "./us-replay-source";

type Client = ReturnType<typeof trustedSupabaseClient>;
export interface UsReplayScreeningInput {
  client: Client;
  userId: string;
  analyses: UsProspectiveAnalysis[];
  sources: UsReplaySessionSource[];
  manifestHash: string;
  operatingPlanHash: string;
  generatedAt: string;
  protectedHistory: Array<{
    date: string;
    data_hash: string;
    rule_version: string;
    resultHash: string;
  }>;
}
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
    throw new Error(`US replay publication read failed: ${error.message}`);
  }
  const value = JSON.parse(await data.text());
  if (!value || typeof value !== "object")
    throw new Error("Malformed US daily publication artifact");
  return value;
}
async function immutable(client: Client, path: string, value: unknown) {
  const body = stableJson(value);
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(path, body, {
    contentType: "application/json",
    upsert: false,
  });
  if (stableJson(await read(client, path)) !== body)
    throw new Error(
      error ? "Immutable US daily publication conflict" : "US daily publication readback mismatch",
    );
}

async function assertCurrent(input: UsReplayScreeningInput) {
  const { client, userId, sources } = input;
  const last = sources.at(-1)!;
  const { data: ingest, error } = await client
    .from("us_screening_ingest")
    .select("as_of_date,data_hash,storage_bucket,source_provider,schema_version")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (
    !ingest ||
    ingest.storage_bucket !== ANALYSIS_BUCKET ||
    ingest.as_of_date !== last.date ||
    ingest.data_hash !== last.dataHash
  )
    throw new Error("Current US ingest differs from the preserved ATOMIC final session");
  const latest = await read(client, `${userId}/cache/us-screening/latest.json`);
  if (latest && (typeof latest.analysis?.date !== "string" || latest.analysis.date > last.date))
    throw new Error("US daily publication cannot replace a malformed or newer latest cache");
  return ingest;
}

/** Admit only missing dated results or exact retries. Existing original results remain untouched. */
export async function preflightUsReplayScreening(input: UsReplayScreeningInput) {
  const { client, userId, analyses, sources } = input;
  if (
    !analyses.length ||
    analyses.length !== sources.length ||
    sources.some(
      (source, i) =>
        source.pit.kind !== "ATOMIC_DATED_SNAPSHOT" ||
        source.originalSource ||
        source.date !== analyses[i]?.date ||
        analyses[i]?.state.lastDate !== source.date ||
        analyses[i]?.ruleVersion !== US_PROSPECTIVE_RULE_VERSION ||
        analyses[i]?.rows.length !== source.rowCount ||
        new Set(analyses[i]?.rows.map((row) => row.symbol)).size !== source.symbolCount ||
        analyses[i]?.rows.some((row) => row.date !== source.date) ||
        (i > 0 && source.previousSessionDate !== sources[i - 1]?.date),
    )
  )
    throw new Error("Daily US publication requires the exact preserved ATOMIC analysis chain");
  const ingest = await assertCurrent(input);
  const last = sources.at(-1)!;
  const entries = [];
  for (const [i, analysis] of analyses.entries()) {
    const source = sources[i]!;
    const original = input.protectedHistory.find((row) => row.date === source.date);
    // The recovery driver's immutable protection checks cover these original objects.
    if (original) {
      if (original.data_hash !== source.dataHash || original.rule_version !== analysis.ruleVersion)
        throw new Error("Original US history differs from the preserved ATOMIC source");
      continue;
    }
    const payload = {
      generatedAt: input.generatedAt,
      dataHash: source.dataHash,
      source: {
        provider: ingest.source_provider,
        collectedAt: source.sourceCapturedAt,
        schemaVersion: ingest.schema_version,
        metadata: {
          previousSessionDate: source.previousSessionDate,
          confirmedRegularClose: true,
          failedSymbols: 0,
          sourceCoverageComplete: source.sourceCoverageComplete,
          quarantinedSymbols: [...source.quarantinedSymbols],
        },
      },
      analysis: {
        date: analysis.date,
        ruleVersion: analysis.ruleVersion,
        summary: analysis.summary,
        state: analysis.state,
        rows: analysis.rows.map(compactRow),
      },
    };
    const history = {
      user_id: userId,
      date: source.date,
      data_hash: source.dataHash,
      rule_version: analysis.ruleVersion,
      summary: analysis.summary,
      signals: usProspectiveCompactSignals(analysis),
    };
    const path = `${userId}/results/us-screening/${source.date}`;
    const manifest = { dataHash: source.dataHash, ruleVersion: analysis.ruleVersion };
    for (const [suffix, value] of [
      [".json", payload],
      [".manifest.json", manifest],
    ] as const) {
      const existing = await read(client, path + suffix);
      if (existing && stableJson(existing) !== stableJson(value))
        throw new Error("Immutable US daily publication conflict");
    }
    const { data: marker, error: markerError } = await client
      .from("us_screening_history")
      .select("user_id,date,data_hash,rule_version,summary,signals")
      .eq("user_id", userId)
      .eq("date", source.date)
      .maybeSingle();
    if (markerError) throw markerError;
    if (marker && stableJson(marker) !== stableJson(history))
      throw new Error("Immutable US daily history conflict");
    entries.push({ path, manifest, payload, history, completed: Boolean(marker) });
  }
  const protectedOriginal = input.protectedHistory.find((row) => row.date === last.date);
  const recovered = protectedOriginal
    ? {
        client,
        userId,
        analysis: analyses.at(-1)!,
        source: last,
        manifestHash: input.manifestHash,
        operatingPlanHash: input.operatingPlanHash,
        generatedAt: input.generatedAt,
        protectedOriginal,
      }
    : null;
  if (recovered) await preflightUsRecoveryPublication(recovered);
  return { entries, recovered };
}

/** Called only after both replay ledgers have committed and their receipt is durable. */
export async function publishUsReplayScreening(input: UsReplayScreeningInput) {
  const { entries, recovered } = await preflightUsReplayScreening(input);
  for (const item of entries) {
    await immutable(input.client, `${item.path}.manifest.json`, item.manifest);
    await immutable(input.client, `${item.path}.json`, item.payload);
    if (!item.completed) {
      const { error } = await input.client.from("us_screening_history").insert(item.history);
      if (error) throw error; // An exact retry resumes here without stepping any model again.
    }
  }
  if (recovered) return publishUsRecoveryViews(recovered);
  await assertCurrent(input);
  const payload = entries.at(-1)!.payload;
  await uploadJson(input.client, `${input.userId}/cache/us-screening/latest.json`, payload);
  await publishBrowserViews(input.client, input.userId, payload);
  return payload;
}
