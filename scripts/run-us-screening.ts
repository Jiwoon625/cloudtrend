import { runSignalJournalStage } from "../src/lib/signalJournalStage";
import { publishUsSignalJournal } from "../src/lib/usSignalJournal.server";
import { initialScreeningStages } from "../src/lib/screeningStages";
import { saveScreeningStages } from "../src/lib/screeningStages.server";
import { OPERATIONAL_SIGNAL_START } from "../src/lib/operationalSignalStart";
import { usesLegacyUsOperatingLedger } from "../src/lib/legacyUsLedgerBoundary";
import { loadPublishedUsRecoveryView } from "./us-recovery-publication";
import { compactRow, publishBrowserViews } from "./us-screening-publication";
import { assertUsScreeningCoverage } from "./us-replay-source";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  ANALYSIS_BUCKET,
  sha256,
  stableJson,
  trustedSupabaseClient,
  uploadJson,
} from "./analysis-run-store";
import {
  parseUsProspectiveCsv,
  runUsProspectiveAnalysis,
  usProspectiveCompactSignals,
  US_PROSPECTIVE_RULE_VERSION,
} from "../src/lib/engine/usProspective";

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function downloadText(client: ReturnType<typeof trustedSupabaseClient>, path: string) {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(path);
  if (error) throw new Error(`US 입력 다운로드 실패 (${path}): ${error.message}`);
  return data.text();
}

async function maybeDownloadJson<T>(
  client: ReturnType<typeof trustedSupabaseClient>,
  path: string,
) {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(path);
  if (error) {
    if (/not.?found|404|Object not found/i.test(error.message)) return null;
    throw new Error(`US 캐시 다운로드 실패 (${path}): ${error.message}`);
  }
  return JSON.parse(await data.text()) as T;
}

export async function runUsScreening(
  client: ReturnType<typeof trustedSupabaseClient>,
  userId: string,
) {
  const { data: ingest, error: ingestError } = await client
    .from("us_screening_ingest")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (ingestError) throw new Error(`US ingest 조회 실패: ${ingestError.message}`);
  if (!ingest) {
    console.log("No US ingest yet; nothing to process.");
    return;
  }
  const legacyOperating = usesLegacyUsOperatingLedger(String(ingest.as_of_date));
  if (ingest.storage_bucket !== ANALYSIS_BUCKET) throw new Error("Unexpected US storage bucket");

  const csv = await downloadText(client, String(ingest.storage_path));
  const actualHash = `sha256:${sha256(Buffer.from(csv, "utf8"))}`;
  if (actualHash !== String(ingest.data_hash))
    throw new Error(`US 입력 해시 불일치: DB ${ingest.data_hash} / Storage ${actualHash}`);
  const allParsed = parseUsProspectiveCsv(csv);
  const sourceDates = [...new Set(allParsed.map((row) => row.date))].sort();
  const latestSourceDate = sourceDates.at(-1);
  if (
    allParsed.length !== ingest.row_count ||
    new Set(allParsed.map((row) => row.symbol)).size !== ingest.symbol_count ||
    latestSourceDate !== String(ingest.as_of_date)
  )
    throw new Error("US source row count, symbol count or latest date mismatch");

  assertUsScreeningCoverage(ingest.metadata as Record<string, unknown>, allParsed);
  const runId = `us-${ingest.as_of_date}-${ingest.data_hash}`;
  const stages = initialScreeningStages();
  const saveStages = () =>
    legacyOperating ? Promise.resolve() : saveScreeningStages(client, userId, runId, stages);

  const { data: lastHistory, error: lastError } = await client
    .from("us_screening_history")
    .select("date,data_hash,rule_version")
    .eq("user_id", userId)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw lastError;
  if (lastHistory && lastHistory.date > ingest.as_of_date)
    throw new Error("Past US history cannot be replaced");
  if (
    lastHistory &&
    lastHistory.date === ingest.as_of_date &&
    (lastHistory.data_hash !== ingest.data_hash ||
      lastHistory.rule_version !== US_PROSPECTIVE_RULE_VERSION)
  )
    throw new Error("Completed US date is immutable (hash/rule mismatch)");
  if (
    lastHistory?.date !== ingest.as_of_date &&
    (await maybeDownloadJson(client, `${userId}/results/us-replay-state/${ingest.as_of_date}.json`))
  )
    throw new Error(
      "US replay publication is incomplete; resume the same immutable replay manifest",
    );
  const journal = await runSignalJournalStage(stages, saveStages, () =>
    publishUsSignalJournal(client, userId, {
      rows: allParsed,
      throughDate: String(ingest.as_of_date),
      sourceHash: String(ingest.data_hash),
      collectedAt: String(ingest.collected_at),
    }),
  );
  if (lastHistory && lastHistory.date === ingest.as_of_date) {
    if (
      lastHistory.data_hash !== ingest.data_hash ||
      lastHistory.rule_version !== US_PROSPECTIVE_RULE_VERSION
    )
      throw new Error("Completed US date is immutable (hash/rule mismatch)");
    const completed = await maybeDownloadJson<Record<string, unknown>>(
      client,
      `${userId}/results/us-screening/${ingest.as_of_date}.json`,
    );
    if (!completed) throw new Error("Completed US result is missing");
    const recoveredView = await loadPublishedUsRecoveryView(client, userId, {
      date: String(ingest.as_of_date),
      dataHash: String(ingest.data_hash),
      ruleVersion: US_PROSPECTIVE_RULE_VERSION,
    });
    await uploadJson(
      client,
      `${userId}/cache/us-screening/latest.json`,
      recoveredView ?? completed,
    );
    await publishBrowserViews(client, userId, recoveredView ?? completed);
    stages.publication = "COMPLETED";
    await saveStages();
    console.log("US date already completed; portfolio and streak unchanged.");
    return;
  }
  const sourceMetadata = ingest.metadata as {
    previousSessionDate?: string;
    confirmedRegularClose?: boolean;
    failedSymbols?: number;
  };
  assertUsScreeningCoverage(ingest.metadata as Record<string, unknown>, allParsed);
  if ((ingest.metadata as Record<string, unknown>)["sourceCoverageComplete"] === false)
    console.warn(
      "US source has explicit quarantines/holds; workflow success does not mean complete universe coverage.",
    );
  const portfolioGap =
    Boolean(lastHistory) && sourceMetadata.previousSessionDate !== lastHistory?.date;

  const latestCachePath = `${userId}/cache/us-screening/latest.json`;
  // 같은 기준일을 재실행해도 Onset 상태가 바뀌지 않도록, "현재 latest"가 아니라
  // strictly previous trading-date 결과에서만 state를 이어받는다.
  const { data: previousHistory, error: previousHistoryError } = await client
    .from("us_screening_history")
    .select("date")
    .eq("user_id", userId)
    .lt("date", String(ingest.as_of_date))
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previousHistoryError)
    throw new Error(`US 이전 스크리닝 날짜 조회 실패: ${previousHistoryError.message}`);
  const recoveredPrevious = previousHistory?.date
    ? await maybeDownloadJson<{
        version?: string;
        analysis?: {
          ruleVersion?: string;
          state?: {
            lastDate?: string;
            coreRanks?: Record<string, number>;
            betaWeakStreak?: Record<string, number>;
          };
        };
      }>(client, `${userId}/results/us-replay-state/${previousHistory.date}.json`)
    : null;
  if (
    recoveredPrevious &&
    (recoveredPrevious.version !== "us-replay-state-v1" ||
      recoveredPrevious.analysis?.ruleVersion !== US_PROSPECTIVE_RULE_VERSION ||
      recoveredPrevious.analysis?.state?.lastDate !== previousHistory?.date)
  )
    throw new Error("Recovered US rank-state identity mismatch");
  const previousResult =
    recoveredPrevious ??
    (previousHistory?.date
      ? await maybeDownloadJson<{
          analysis?: {
            state?: { coreRanks?: Record<string, number>; betaWeakStreak?: Record<string, number> };
          };
        }>(client, `${userId}/results/us-screening/${previousHistory.date}.json`)
      : null);
  if (previousHistory && !previousResult?.analysis?.state)
    throw new Error("Previous US rank state is missing");

  const latestRows = allParsed.filter((row) => row.date === String(ingest.as_of_date));
  if (!latestRows.length) throw new Error("US latest-date rows are missing");
  const analysis = runUsProspectiveAnalysis(
    latestRows,
    portfolioGap || String(ingest.as_of_date) === OPERATIONAL_SIGNAL_START
      ? {}
      : (previousResult?.analysis?.state ?? {}),
  );
  if (analysis.date !== String(ingest.as_of_date))
    throw new Error(`입력 기준일 불일치: DB ${ingest.as_of_date} / CSV ${analysis.date}`);

  // Lock a date's input before any ledger writes, including retries after partial failure.
  const manifestPath = `${userId}/results/us-screening/${analysis.date}.manifest.json`;
  const manifest = { dataHash: ingest.data_hash, ruleVersion: US_PROSPECTIVE_RULE_VERSION };
  const { error: manifestError } = await client.storage
    .from(ANALYSIS_BUCKET)
    .upload(manifestPath, JSON.stringify(manifest), {
      contentType: "application/json",
      upsert: false,
    });
  if (manifestError) {
    const frozenManifest = await maybeDownloadJson<typeof manifest>(client, manifestPath);
    if (!frozenManifest || stableJson(frozenManifest) !== stableJson(manifest))
      throw new Error("US date input is locked; cannot replay with a different input/rule");
  }
  const resultPath = `${userId}/results/us-screening/${analysis.date}.json`;
  const existingResult = await maybeDownloadJson<{
    dataHash: string;
    analysis: { ruleVersion: string };
  }>(client, resultPath);
  if (
    existingResult &&
    (existingResult.dataHash !== ingest.data_hash ||
      existingResult.analysis.ruleVersion !== US_PROSPECTIVE_RULE_VERSION)
  )
    throw new Error("Daily US result is immutable");

  const cachePayload = {
    generatedAt: new Date().toISOString(),
    dataHash: ingest.data_hash,
    source: {
      provider: ingest.source_provider,
      collectedAt: ingest.collected_at,
      schemaVersion: ingest.schema_version,
      metadata: ingest.metadata,
    },
    signalCoverage: { predecessorComplete: !portfolioGap, pending: journal.pending },
    analysis: {
      date: analysis.date,
      ruleVersion: analysis.ruleVersion,
      summary: analysis.summary,
      state: analysis.state,
      rows: analysis.rows.map(compactRow),
    },
  };
  const historyRecord = {
    user_id: userId,
    date: analysis.date,
    data_hash: ingest.data_hash,
    rule_version: US_PROSPECTIVE_RULE_VERSION,
    summary: analysis.summary,
    signals: usProspectiveCompactSignals(analysis),
  };

  // No strategy, Shadow, valuation or benchmark ledger is written by daily screening.
  if (!existingResult) await uploadJson(client, resultPath, cachePayload);
  const { error: historyError } = await client.from("us_screening_history").insert(historyRecord);
  if (historyError) throw historyError;
  await uploadJson(client, latestCachePath, existingResult ?? cachePayload);
  try {
    await publishBrowserViews(client, userId, existingResult ?? cachePayload);
    stages.publication = "COMPLETED";
  } catch {
    stages.publication = "FAILED";
    await saveStages();
    throw new Error("US browser publication failed; retry the completed immutable result");
  }
  await saveStages();

  console.log(
    JSON.stringify(
      {
        ok: true,
        date: analysis.date,
        rows: analysis.rows.length,
        ruleVersion: analysis.ruleVersion,
        summary: analysis.summary,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const userId = arg("--user") ?? process.env["SUPABASE_USER_ID"];
  if (!userId) throw new Error("--user 또는 SUPABASE_USER_ID가 필요합니다.");
  await runUsScreening(trustedSupabaseClient(), userId);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      `US screening stopped; private diagnostic ${sha256(error instanceof Error ? error.message : "unknown").slice(0, 12)}. Check source and model preflight evidence before retrying.`,
    );
    process.exitCode = 1;
  });
