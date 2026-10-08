/** Publish already verified recovery signals only. Never run engines or mutate any ledger. */
import {
  ANALYSIS_BUCKET,
  stableJson,
  type trustedSupabaseClient,
  uploadJson,
} from "./analysis-run-store";
import { compactRow, publishBrowserViews } from "./us-screening-publication";
import { assertOwnerReplayPath, type UsReplaySessionSource } from "./us-replay-source";
import {
  US_PROSPECTIVE_RULE_VERSION,
  type UsProspectiveAnalysis,
} from "../src/lib/engine/usProspective";
import type { UsProspectiveCache } from "../src/lib/usProspectiveCloud";

type Client = ReturnType<typeof trustedSupabaseClient>;
export const US_RECOVERY_PUBLICATION_VERSION = "us-recovery-publication-v1" as const;
export interface UsRecoveryPublicationInput {
  client: Client;
  userId: string;
  analysis: UsProspectiveAnalysis;
  /** Previously admitted by loadVerifiedUsReplaySessions; no new source collection here. */
  source: UsReplaySessionSource;
  manifestHash: string;
  operatingPlanHash: string;
  /** The immutable replay plan's calculation time, not the time of a retry. */
  generatedAt: string;
  protectedOriginal: {
    date: string;
    data_hash: string;
    rule_version: string;
    resultHash: string;
  };
}
export interface UsRecoveryPublicationIdentity {
  date: string;
  /** Original ingest hash, which intentionally remains unchanged after recovery. */
  dataHash: string;
  ruleVersion: string;
}
const hash = (v: unknown): v is string => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
const date = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const instant = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
const record = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const sourceKinds = [
  "ATOMIC_DATED_SNAPSHOT",
  "DATED_ROSTER_RECONSTRUCTION",
  "REVIEWED_ATOMIC_QUARANTINE",
];
function artifactPath(userId: string, day: string) {
  if (!userId || userId.includes("/") || !date(day))
    throw new Error("Invalid US recovery publication owner/date");
  const path = `${userId}/results/us-recovered-screening/${day}.json`;
  assertOwnerReplayPath(path, userId);
  return path;
}
async function readText(client: Client, path: string): Promise<string | null> {
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
    throw new Error(`US recovery publication read failed: ${error.message}`);
  }
  if (!data) throw new Error("US recovery publication read returned no data");
  return data.text();
}
function assertIdentity(identity: UsRecoveryPublicationIdentity) {
  if (
    !date(identity.date) ||
    !hash(identity.dataHash) ||
    identity.ruleVersion !== US_PROSPECTIVE_RULE_VERSION
  )
    throw new Error("Invalid US recovery publication identity");
}
function assertPublishedView(value: unknown, identity: UsRecoveryPublicationIdentity) {
  const view = value as UsProspectiveCache;
  const marker = view?.source?.metadata?.["recoveryPublication"];
  const coverage = view?.source?.metadata?.["sourceCoverageComplete"];
  const quarantines = view?.source?.metadata?.["quarantinedSymbols"];
  if (
    !record(value) ||
    Object.keys(value).some(
      (k) => !["generatedAt", "dataHash", "source", "analysis"].includes(k),
    ) ||
    !instant(view.generatedAt) ||
    !hash(view.dataHash) ||
    !record(view.source) ||
    Object.keys(view.source).some(
      (k) => !["provider", "collectedAt", "schemaVersion", "metadata"].includes(k),
    ) ||
    typeof view.source.provider !== "string" ||
    !view.source.provider ||
    typeof view.source.schemaVersion !== "string" ||
    !view.source.schemaVersion ||
    !instant(view.source.collectedAt) ||
    Date.parse(view.source.collectedAt) > Date.parse(view.generatedAt) ||
    !record(view.source.metadata) ||
    Object.keys(view.source.metadata).some(
      (k) =>
        ![
          "previousSessionDate",
          "confirmedRegularClose",
          "failedSymbols",
          "sourceCoverageComplete",
          "quarantinedSymbols",
          "recoveryPublication",
        ].includes(k),
    ) ||
    !date(view.source.metadata["previousSessionDate"]) ||
    view.source.metadata["previousSessionDate"] >= identity.date ||
    view.source.metadata["confirmedRegularClose"] !== true ||
    view.source.metadata["failedSymbols"] !== 0 ||
    !record(marker) ||
    Object.keys(marker).some(
      (k) =>
        ![
          "version",
          "manifestHash",
          "operatingPlanHash",
          "originalDataHash",
          "originalResultHash",
          "sourceKind",
        ].includes(k),
    ) ||
    marker["version"] !== US_RECOVERY_PUBLICATION_VERSION ||
    !hash(marker["manifestHash"]) ||
    !hash(marker["operatingPlanHash"]) ||
    marker["originalDataHash"] !== identity.dataHash ||
    !hash(marker["originalResultHash"]) ||
    !sourceKinds.includes(String(marker["sourceKind"])) ||
    typeof coverage !== "boolean" ||
    !Array.isArray(quarantines) ||
    quarantines.some((s) => typeof s !== "string" || !s) ||
    new Set(quarantines).size !== quarantines.length ||
    coverage !== (quarantines.length === 0) ||
    !record(view.analysis) ||
    Object.keys(view.analysis).some(
      (k) => !["date", "ruleVersion", "summary", "rows"].includes(k),
    ) ||
    view.analysis.date !== identity.date ||
    view.analysis.ruleVersion !== identity.ruleVersion ||
    !record(view.analysis.summary) ||
    Object.values(view.analysis.summary).some(
      (n) => n !== null && (typeof n !== "number" || !Number.isFinite(n)),
    ) ||
    !Array.isArray(view.analysis.rows) ||
    !view.analysis.rows.length ||
    view.analysis.summary["inputRows"] !== view.analysis.rows.length
  )
    throw new Error("Malformed or mismatched US recovery publication");
  const symbols = new Set<string>();
  for (const row of view.analysis.rows) {
    if (
      !record(row) ||
      row.date !== identity.date ||
      typeof row.symbol !== "string" ||
      !row.symbol ||
      symbols.has(row.symbol) ||
      typeof row.name !== "string" ||
      !["market", "sector", "status"].every((k) => row[k] === null || typeof row[k] === "string") ||
      ![
        "open",
        "close",
        "ret120",
        "ret252",
        "ret120Rank",
        "ret252Rank",
        "coreRank",
        "betaRank",
        "tkRank",
        "relvolRank",
        "liquidityRank",
        "amihudRank",
        "adv20Usd",
        "marketCap",
      ].every((k) => row[k] === null || (typeof row[k] === "number" && Number.isFinite(row[k]))) ||
      ![
        "onset80",
        "a0Entry",
        "a0Exit",
        "a0BetaExit",
        "a2Entry",
        "a2Exit",
        "b3Entry",
        "b3Exit",
        "b3BetaExit",
      ].every((k) => typeof row[k] === "boolean") ||
      !Number.isSafeInteger(row.betaWeakStreak) ||
      row.betaWeakStreak < 0 ||
      !["ENTRY", "EXIT", "WATCH", "NONE"].includes(row.primarySignal) ||
      stableJson(row) !==
        stableJson(compactRow(row as unknown as UsProspectiveAnalysis["rows"][number]))
    )
      throw new Error("Malformed US recovery screening row");
    symbols.add(row.symbol);
  }
  for (const symbol of quarantines as string[]) {
    const row = view.analysis.rows.find((r) => r.symbol === symbol);
    if (
      !row ||
      row.open !== null ||
      row.close !== null ||
      row.ret120 !== null ||
      row.ret252 !== null ||
      row.a0Entry ||
      row.a2Entry ||
      row.b3Entry
    )
      throw new Error("US recovery quarantine is not safely excluded");
  }
  return view;
}

/** The only same-day override the normal runner may republish. Missing is not malformed. */
export async function loadPublishedUsRecoveryView(
  client: Client,
  userId: string,
  identity: UsRecoveryPublicationIdentity,
): Promise<UsProspectiveCache | null> {
  assertIdentity(identity);
  const text = await readText(client, artifactPath(userId, identity.date));
  if (text === null) return null;
  return assertPublishedView(JSON.parse(text), identity);
}

async function assertCurrentPublication(input: UsRecoveryPublicationInput) {
  const { client, userId, protectedOriginal: original } = input;
  const { data: ingest, error: ingestError } = await client
    .from("us_screening_ingest")
    .select("as_of_date,data_hash,storage_bucket,source_provider,schema_version")
    .eq("user_id", userId)
    .maybeSingle();
  if (ingestError) throw new Error(`US recovery ingest read failed: ${ingestError.message}`);
  if (
    !ingest ||
    ingest.storage_bucket !== ANALYSIS_BUCKET ||
    ingest.as_of_date !== original.date ||
    ingest.data_hash !== original.data_hash
  )
    throw new Error("Current US ingest differs from the protected original");
  const latestText = await readText(client, `${userId}/cache/us-screening/latest.json`);
  if (latestText !== null) {
    const latest = JSON.parse(latestText);
    if (!date(latest?.analysis?.date)) throw new Error("Current US latest cache is malformed");
    if (latest.analysis.date > original.date)
      throw new Error("US recovery publication cannot roll back a newer latest cache");
  }
  return ingest;
}

/** Read-only admission. Call before model/Shadow application and repeat before publication. */
export async function preflightUsRecoveryPublication(
  input: UsRecoveryPublicationInput,
): Promise<UsProspectiveCache> {
  const { client, userId, analysis, source, protectedOriginal: original } = input;
  if (!original) throw new Error("US recovery publication requires a protected original marker");
  const identity = {
    date: original.date,
    dataHash: original.data_hash,
    ruleVersion: original.rule_version,
  };
  assertIdentity(identity);
  artifactPath(userId, original.date);
  if (
    !hash(original.resultHash) ||
    !hash(input.manifestHash) ||
    !hash(input.operatingPlanHash) ||
    !instant(input.generatedAt) ||
    !source ||
    !hash(source.dataHash) ||
    source.date !== original.date ||
    analysis?.date !== original.date ||
    analysis.ruleVersion !== original.rule_version ||
    analysis.state?.lastDate !== analysis.date ||
    !Array.isArray(analysis.rows) ||
    source.rowCount !== analysis.rows.length ||
    source.symbolCount !== new Set(analysis.rows.map((r) => r.symbol)).size ||
    !instant(source.sourceCapturedAt) ||
    Date.parse(source.sourceCapturedAt) > Date.parse(input.generatedAt) ||
    !date(source.previousSessionDate) ||
    source.previousSessionDate >= source.date ||
    source.confirmedRegularClose !== true ||
    source.failedSymbols !== 0 ||
    !sourceKinds.includes(source.pit?.kind) ||
    (source.originalSource && source.originalSource.dataHash !== original.data_hash) ||
    (source.pit?.kind === "REVIEWED_ATOMIC_QUARANTINE" && !source.originalSource)
  )
    throw new Error("US recovery publication source/date/hash/rule mismatch");
  const ingest = await assertCurrentPublication(input);
  const { data: history, error: historyError } = await client
    .from("us_screening_history")
    .select("date,data_hash,rule_version")
    .eq("user_id", userId)
    .eq("date", original.date)
    .maybeSingle();
  if (historyError) throw new Error(`US recovery history read failed: ${historyError.message}`);
  if (
    !history ||
    history.date !== original.date ||
    history.data_hash !== original.data_hash ||
    history.rule_version !== original.rule_version
  )
    throw new Error("Protected US history marker changed or is missing");
  // Only the verified source's compact explanatory metadata is published. No plan,
  // full source descriptor, engine state, operating positions or ledger is copied.
  const payload: UsProspectiveCache = {
    generatedAt: input.generatedAt,
    dataHash: source.dataHash,
    source: {
      provider: ingest.source_provider,
      collectedAt: source.sourceCapturedAt,
      schemaVersion: ingest.schema_version,
      metadata: {
        previousSessionDate: source.previousSessionDate,
        confirmedRegularClose: source.confirmedRegularClose,
        failedSymbols: source.failedSymbols,
        sourceCoverageComplete: source.sourceCoverageComplete,
        quarantinedSymbols: [...source.quarantinedSymbols],
        recoveryPublication: {
          version: US_RECOVERY_PUBLICATION_VERSION,
          manifestHash: input.manifestHash,
          operatingPlanHash: input.operatingPlanHash,
          originalDataHash: original.data_hash,
          originalResultHash: original.resultHash,
          sourceKind: source.pit.kind,
        },
      },
    },
    analysis: {
      date: analysis.date,
      ruleVersion: analysis.ruleVersion,
      summary: { ...analysis.summary },
      rows: analysis.rows.map(compactRow),
    },
  };
  assertPublishedView(payload, identity);
  const existing = await loadPublishedUsRecoveryView(client, userId, identity);
  if (existing && stableJson(existing) !== stableJson(payload))
    throw new Error("Immutable US recovery publication conflict");
  return payload;
}

/** Immutable dedicated artifact first; only rebuildable presentation caches follow. */
export async function publishUsRecoveryViews(input: UsRecoveryPublicationInput) {
  const payload = await preflightUsRecoveryPublication(input);
  const { client, userId, protectedOriginal: original } = input;
  const path = artifactPath(userId, original.date);
  const body = stableJson(payload);
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(path, body, {
    contentType: "application/json",
    upsert: false,
  });
  const readback = await readText(client, path);
  if (readback === null || stableJson(JSON.parse(readback)) !== body)
    throw new Error(
      error
        ? "Immutable US recovery publication conflict"
        : "US recovery publication readback mismatch",
    );
  // Recheck only mutable current ingest/cache identity before refreshing views,
  // including retries after a partially completed cache publication.
  await assertCurrentPublication(input);
  await uploadJson(client, `${userId}/cache/us-screening/latest.json`, payload);
  await publishBrowserViews(client, userId, payload);
  return payload;
}
