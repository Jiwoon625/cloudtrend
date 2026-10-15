import { createClient } from "@supabase/supabase-js";
import { ANALYSIS_BUCKET, codeVersion, sha256, stableJson } from "./analysis-run-store";
import { listSourceRecords, loadAnalysisSourceInputs } from "./source-registry-store";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import {
  KOSPI_SHADOW_POLICY,
  stepKospiShadow,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "../src/lib/engine/kospiShadow";
import { buildKospiShadowSession } from "../src/lib/engine/kospiShadowDataset";
import {
  shadowObjectPath,
  type KospiShadowRegistry,
  type KospiShadowView,
} from "../src/lib/kospiShadowStore";
import { sourceTimingEvidence } from "../src/lib/sourceTimingEvidence";
import { isKrLiveShadowDecision } from "../src/lib/krShadowAdmission";
import { validDate } from "../src/lib/ledger/date";
import {
  activeSeriesVersion,
  hashSeriesValue,
  type FrozenModelSeries,
} from "../src/lib/ledger/modelSeries";
import {
  krExecutionBar,
  mergeKrDailyInputs,
  type KrDailyInputArchive,
} from "../src/lib/ledger/octoberShadowArchive";
import type { MarketDataset } from "../src/lib/engine/dataset";
import { assertStoredOctoberRun, type OctoberRun } from "../src/lib/ledger/octoberShadowPipeline";
import type { AdoptedKrRun } from "../src/lib/ledger/krAdoptedShadow";

class DiagnosticError extends Error {}
let diagnosticStage = "configuration";

export function publicDiagnosticError(error: unknown, stage: string) {
  return {
    status: "BLOCKED",
    stage,
    reason: error instanceof DiagnosticError ? error.message : "UPSTREAM_READ_OR_VALIDATION_FAILED",
    writesAllowed: false,
  };
}

/** Even an accidentally imported writer cannot issue a mutation through this client. */
export function readOnlyDiagnosticFetch(fetcher: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (!["GET", "HEAD"].includes(method.toUpperCase()))
      throw new Error("Shadow diagnostic forbids write requests");
    return fetcher(input, init);
  };
}

const hash = (value: unknown) => `sha256:${sha256(stableJson(value))}`;
const equal = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
function changedFields(before: object, after: object) {
  const a = before as Record<string, unknown>,
    b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((key) => !equal(a[key], b[key]));
}
function changedSymbols(before: Record<string, object>, after: Record<string, object>) {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((symbol) => !equal(before[symbol], after[symbol]));
  return {
    count: changed.length,
    truncated: changed.length > 100,
    items: changed.slice(0, 100).map((symbol) => ({
      symbol,
      fields: changedFields(before[symbol] ?? {}, after[symbol] ?? {}),
    })),
  };
}
function economics(snapshot: KospiShadowSnapshot) {
  return {
    navKrw: snapshot.daily.navKrw,
    cashKrw: snapshot.state.cashKrw,
    dailyFeesKrw: snapshot.daily.feesKrw,
    positions: Object.keys(snapshot.state.positions).length,
    trades: snapshot.trades.length,
    candidates: snapshot.candidates.length,
    awaiting: snapshot.state.awaiting.length,
    pendingEntries: snapshot.state.pendingEntries.length,
    pendingExits: Object.keys(snapshot.state.pendingExits).length,
    totalEntries: snapshot.state.totalEntries,
  };
}

/** Independent full-prefix audit, not the recovery candidate's overlay implementation. */
export function compareArchivedKrBars(
  days: KrDailyInputArchive[],
  dataset: Pick<MarketDataset, "bars">,
) {
  const changes: Array<{
    date: string;
    symbol: string;
    status: string;
    fields: string[];
    storedHash: string;
    currentHash: string | null;
  }> = [];
  let archivedRows = 0,
    matchedRows = 0,
    missingRows = 0,
    duplicateCurrentRows = 0;
  const seen = new Set<string>();
  for (const day of days) {
    if (day.version !== "kr-daily-inputs-v1" || !validDate(day.date))
      throw new DiagnosticError("Invalid archived KR daily input identity");
    for (const [symbol, rows] of Object.entries(day.inputs.bars)) {
      for (const original of rows) {
        const key = `${symbol}/${original.tradeDate}`;
        if (original.tradeDate !== day.date || seen.has(key))
          throw new DiagnosticError("Duplicate or misdated archived KR bar");
        seen.add(key);
        archivedRows++;
        const currentRows = (dataset.bars[symbol] ?? []).filter(
          (row) => row.tradeDate === day.date,
        );
        const stored = krExecutionBar(original);
        if (currentRows.length !== 1) {
          if (!currentRows.length) missingRows++;
          else duplicateCurrentRows++;
          changes.push({
            date: day.date,
            symbol,
            status: currentRows.length ? "DUPLICATE_CURRENT_ROWS" : "MISSING_CURRENT_ROW",
            fields: [],
            storedHash: hash(stored),
            currentHash: null,
          });
          continue;
        }
        const current = krExecutionBar(currentRows[0]!);
        if (equal(stored, current)) {
          matchedRows++;
          continue;
        }
        changes.push({
          date: day.date,
          symbol,
          status: "CHANGED",
          fields: changedFields(stored, current),
          storedHash: hash(stored),
          currentHash: hash(current),
        });
      }
    }
  }
  return {
    scope: "Every archived stock bar versus full merged dataset.bars, canonical krExecutionBar",
    archiveDates: days.map((day) => day.date),
    archivedRows,
    matchedRows,
    missingRows,
    duplicateCurrentRows,
    changedRows: changes.filter((item) => item.status === "CHANGED").length,
    currentStoredPrefixEqual: changes.length === 0,
    truncated: changes.length > 100,
    changes: changes.slice(0, 100),
  };
}

/** Pure counterfactual comparison. It neither changes a source hash nor persists a result. */
export function compareKospiShadowVintage(input: {
  registry: KospiShadowRegistry;
  stored: KospiShadowSnapshot;
  previous: KospiShadowSnapshot;
  latest: KospiShadowView;
  latestAuthoritative: KospiShadowSnapshot;
  candidate: KospiShadowSession;
}) {
  const { registry, stored, previous, latest, latestAuthoritative, candidate } = input;
  const preservedHash = hash({ registry, stored, previous, latest, latestAuthoritative });
  const daily = latest.history.filter((item) => item.date === stored.source.date);
  const consistency = {
    storedDateMatchesRequested: stored.source.date === candidate.date,
    storedStateDateMatchesSource: stored.state.lastDate === stored.source.date,
    predecessorMatches:
      stored.source.previousSessionDate === previous.source.date &&
      candidate.previousSessionDate === previous.source.date &&
      previous.state.lastDate === previous.source.date,
    storedConfigMatchesRegistry: stored.source.configHash === registry.configHash,
    currentConfigMatchesRegistry: candidate.configHash === registry.configHash,
    registryConfigHashValid: hash(registry.config) === registry.configHash,
    storedPolicyMatches:
      stored.policy.version === KOSPI_SHADOW_POLICY.version &&
      registry.ruleVersion === KOSPI_SHADOW_POLICY.version,
    projectionRegistryMatches: equal(latest.registry, registry),
    projectionMatchesAuthoritative: equal(latest.latest, latestAuthoritative),
    projectionContainsTargetOnce: daily.length === 1 && equal(daily[0], stored.daily),
  };
  const changedSourceFields = changedFields(stored.source, {
    ...candidate,
    rows: undefined,
  }).filter((field) => field !== "rows");
  if (Object.values(consistency).some((value) => !value))
    return {
      mode: "READ_ONLY",
      date: candidate.date,
      consistency,
      changedSourceFields,
      hashes: {
        storedSnapshot: hash(stored),
        preservedPredecessor: hash(previous),
        storedSource: stored.source.sourceHash,
        currentSource: candidate.sourceHash,
        storedConfig: stored.source.configHash,
        currentConfig: candidate.configHash,
        storedCode: stored.source.codeVersion,
        currentCode: candidate.codeVersion,
      },
      comparison: "BLOCKED_INCONSISTENT_FROZEN_INPUT",
    };
  const recomputed = stepKospiShadow(candidate, previous.state);
  if (hash({ registry, stored, previous, latest, latestAuthoritative }) !== preservedHash)
    throw new Error("Diagnostic unexpectedly altered a preserved input in memory");
  const semantic = (value: KospiShadowSnapshot) => ({
    state: value.state,
    daily: value.daily,
    candidates: value.candidates,
    trades: value.trades,
  });
  return {
    mode: "READ_ONLY",
    date: candidate.date,
    consistency,
    changedSourceFields,
    hashes: {
      storedSnapshot: hash(stored),
      preservedPredecessor: hash(previous),
      storedSource: stored.source.sourceHash,
      currentSource: candidate.sourceHash,
      storedConfig: stored.source.configHash,
      currentConfig: candidate.configHash,
      storedCode: stored.source.codeVersion,
      currentCode: candidate.codeVersion,
      storedSemantics: hash(semantic(stored)),
      recomputedSemantics: hash(semantic(recomputed)),
    },
    sourceRegistration: {
      stored: stored.source.sourceCollectedAt,
      current: candidate.sourceCollectedAt,
    },
    economicStateEqual: equal(semantic(stored), semantic(recomputed)),
    changes: {
      dailyFields: changedFields(stored.daily, recomputed.daily),
      stateFields: changedFields(stored.state, recomputed.state),
      rowFieldsBySymbol: changedSymbols(stored.state.previousRows, recomputed.state.previousRows),
      positionFieldsBySymbol: changedSymbols(stored.state.positions, recomputed.state.positions),
      tradesEqual: equal(stored.trades, recomputed.trades),
      candidatesEqual: equal(stored.candidates, recomputed.candidates),
    },
    economics: { stored: economics(stored), recomputed: economics(recomputed) },
    limitation:
      "Counterfactual current-code comparison only; equality never authorizes immutable replacement or hash substitution.",
  };
}

/** The repository is public: never log private model balances, positions, or symbols. */
export function publicDiagnosticReport(
  comparison: ReturnType<typeof compareKospiShadowVintage>,
  archive: ReturnType<typeof compareArchivedKrBars>,
) {
  const archiveFieldCounts: Record<string, number> = {};
  for (const change of archive.changes)
    for (const field of change.fields)
      archiveFieldCounts[field] = (archiveFieldCounts[field] ?? 0) + 1;
  return {
    mode: "READ_ONLY_PUBLIC_SAFE_SUMMARY",
    date: comparison.date,
    consistency: comparison.consistency,
    changedSourceFields: comparison.changedSourceFields,
    hashes: comparison.hashes,
    comparison: comparison.comparison ?? "COMPLETED",
    economicStateEqual: comparison.economicStateEqual ?? null,
    changedFieldNames: {
      daily: comparison.changes?.dailyFields ?? [],
      state: comparison.changes?.stateFields ?? [],
      rows: [
        ...new Set(
          comparison.changes?.rowFieldsBySymbol.items.flatMap((item) => item.fields) ?? [],
        ),
      ].sort(),
    },
    archivedPrefix: {
      archiveDates: archive.archiveDates,
      archivedRows: archive.archivedRows,
      matchedRows: archive.matchedRows,
      missingRows: archive.missingRows,
      duplicateCurrentRows: archive.duplicateCurrentRows,
      changedRows: archive.changedRows,
      currentStoredPrefixEqual: archive.currentStoredPrefixEqual,
      fieldCountsTruncated: archive.truncated,
      changedFieldCounts: archiveFieldCounts,
      changedPairHashes: archive.changes.map((item) => ({
        stored: item.storedHash,
        current: item.currentHash,
      })),
    },
  };
}

export async function diagnoseKospiShadowVintage() {
  const index = process.argv.indexOf("--date");
  const date = index < 0 ? undefined : process.argv[index + 1];
  if (!date || !validDate(date)) throw new DiagnosticError("A valid diagnostic date is required");
  const url = process.env["SUPABASE_URL"],
    key = process.env["SUPABASE_SERVICE_ROLE_KEY"],
    userId = process.env["SUPABASE_USER_ID"];
  if (!url || !key || !userId) throw new DiagnosticError("Diagnostic configuration is missing");
  const origin = new URL(url);
  if (
    origin.protocol !== "https:" ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new DiagnosticError("Diagnostic requires the existing configured HTTPS Supabase origin");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: readOnlyDiagnosticFetch() },
  });
  const read = async <T>(suffix: string): Promise<T> => {
    const { data, error } = await client.storage
      .from(ANALYSIS_BUCKET)
      .download(
        shadowObjectPath(userId, suffix),
        { cacheNonce: crypto.randomUUID() },
        { cache: "no-store" },
      );
    if (error || !data) throw new DiagnosticError(`Diagnostic read failed: ${suffix}`);
    return JSON.parse(await data.text()) as T;
  };
  diagnosticStage = "read_saved_prospective_objects";
  const registry = await read<KospiShadowRegistry>("registry.json");
  const stored = await read<KospiShadowSnapshot>(`sessions/${date}.json`);
  const latest = await read<KospiShadowView>("latest.json");
  const previousDate = stored.source.previousSessionDate;
  if (!previousDate || !validDate(previousDate))
    throw new DiagnosticError("Diagnostic requires a preserved predecessor snapshot");
  const previous = await read<KospiShadowSnapshot>(`sessions/${previousDate}.json`);
  const latestAuthoritative =
    latest.latest.source.date === date
      ? stored
      : await read<KospiShadowSnapshot>(`sessions/${latest.latest.source.date}.json`);
  // Disable optional validation caches; only saved registered inputs may be read.
  delete process.env["SOURCE_VALIDATION_CACHE_DIR"];
  diagnosticStage = "read_validate_active_registered_inputs";
  const inputs = await loadAnalysisSourceInputs(client, userId, "screening", { compact: true });
  if (inputs.some((item) => !item.sourceRecord))
    throw new DiagnosticError(
      "Diagnostic requires registered inputs, not an unregistered legacy fallback",
    );
  const { dataset } = parseManualMarketData(inputs.map((item) => item.text));
  if (dataset.asOfDate !== date)
    throw new DiagnosticError(
      "Current dataset is not the requested exact-date vintage; no backdated substitution allowed",
    );
  diagnosticStage = "compare_integrated_archived_prefix";
  const seriesId = `${activeSeriesVersion(previousDate)}:KR_MIXED`;
  const { data: seriesRecord, error: seriesError } = await client
    .from("ledger_model_series")
    .select("payload")
    .eq("user_id", userId)
    .eq("series_id", seriesId)
    .maybeSingle();
  const { data: runRecord, error: runError } = await client
    .from("ledger_model_sessions")
    .select("payload")
    .eq("user_id", userId)
    .eq("series_id", seriesId)
    .eq("session_date", previousDate)
    .maybeSingle();
  if (seriesError || runError || !seriesRecord || !runRecord)
    throw new DiagnosticError("Preserved integrated predecessor or registry is unavailable");
  const archivedRun = runRecord.payload as AdoptedKrRun & OctoberRun;
  await assertStoredOctoberRun(seriesRecord.payload as FrozenModelSeries, archivedRun);
  if (
    archivedRun.bookId !== seriesId ||
    archivedRun.receipt.date !== previousDate ||
    archivedRun.frozenInputArchive?.version !== "kr-daily-inputs-v1"
  )
    throw new DiagnosticError("Preserved integrated predecessor archive identity mismatch");
  const archiveReferences = archivedRun.frozenInputArchive.days;
  const archives: KrDailyInputArchive[] = [];
  for (const reference of archiveReferences) {
    if (
      !validDate(reference.date) ||
      reference.date > previousDate ||
      !/^sha256:[a-f0-9]{64}$/.test(reference.hash)
    )
      throw new DiagnosticError("Invalid preserved archive reference");
    const { data, error } = await client
      .from("ledger_provenance_archive")
      .select("payload,source_hash")
      .eq("user_id", userId)
      .eq("source_id", `october-input:KR:${reference.date}:${reference.hash.slice(7)}`)
      .eq("source_revision", "1")
      .maybeSingle();
    if (error || !data)
      throw new DiagnosticError(`Missing immutable KR archive: ${reference.date}`);
    if (
      data.source_hash !== reference.hash ||
      (await hashSeriesValue(data.payload)) !== data.source_hash ||
      data.payload.date !== reference.date
    )
      throw new DiagnosticError(`Immutable KR archive digest mismatch: ${reference.date}`);
    archives.push(data.payload as KrDailyInputArchive);
  }
  if (
    archives.at(-1)?.date !== previousDate ||
    (await hashSeriesValue(mergeKrDailyInputs(archives))) !==
      archivedRun.frozenInputArchive.prefixHash
  )
    throw new DiagnosticError("Preserved integrated archive prefix hash mismatch");
  const archivedPrefixComparison = compareArchivedKrBars(archives, dataset);
  diagnosticStage = "build_counterfactual_prospective_session";
  const origins = inputs.flatMap((item) => sourceTimingEvidence(item.sourceRecord!));
  const sourceCollectedAt = origins
    .filter((item) => item.max_date === date)
    .map((item) => item.activated_at ?? item.savedAt ?? item.created_at ?? "")
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1);
  if (!sourceCollectedAt)
    throw new DiagnosticError("No original registered source covers the target date");
  const now = new Date().toISOString();
  const config = { policy: KOSPI_SHADOW_POLICY, scoring: DEFAULT_SCORING_CONFIG };
  const candidate = buildKospiShadowSession(
    dataset,
    DEFAULT_SCORING_CONFIG,
    {
      sourceHash: `sha256:${sha256(
        inputs
          .map((item) => item.dataHash)
          .sort()
          .join("\n"),
      )}`,
      configHash: hash(config),
      codeVersion: codeVersion(),
      sourceCollectedAt,
      now,
    },
    date,
  );
  const comparison = compareKospiShadowVintage({
    registry,
    stored,
    previous,
    latest,
    latestAuthoritative,
    candidate,
  });
  diagnosticStage = "verify_read_stability";
  if (
    !equal(
      inputs.map((item) => item.sourceRecord),
      await listSourceRecords(client, userId, "screening"),
    )
  )
    throw new DiagnosticError(
      "Active input registry changed during the diagnostic; result is inconclusive",
    );
  for (const [suffix, expected] of [
    ["registry.json", registry],
    ["latest.json", latest],
    [`sessions/${date}.json`, stored],
    [`sessions/${previousDate}.json`, previous],
  ] as const) {
    if (!equal(await read(suffix), expected))
      throw new DiagnosticError(
        "Saved Shadow state changed during the diagnostic; result is inconclusive",
      );
  }
  console.log(
    JSON.stringify(
      {
        ...publicDiagnosticReport(comparison, archivedPrefixComparison),
        sourceCount: inputs.length,
        currentRows: candidate.rows.length,
        liveAdmissionAtDiagnosticTime: isKrLiveShadowDecision(date, sourceCollectedAt, now),
        collectionSlotEvidence: "UNAVAILABLE_REGISTRY_HAS_REGISTRATION_TIMES_ONLY",
        preservedObjectsUnchanged: true,
      },
      null,
      2,
    ),
  );
}

if (!process.env["VITEST"])
  diagnoseKospiShadowVintage().catch((error: unknown) => {
    // Upstream validator errors may contain raw row data or private filenames.
    console.error(JSON.stringify(publicDiagnosticError(error, diagnosticStage)));
    process.exitCode = 1;
  });
