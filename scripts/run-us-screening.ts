import { runSignalJournalStage } from "../src/lib/signalJournalStage";
import { publishUsSignalJournal } from "../src/lib/usSignalJournal.server";
import { initialScreeningStages } from "../src/lib/screeningStages";
import { saveScreeningStages } from "../src/lib/screeningStages.server";
import { OPERATIONAL_SIGNAL_START } from "../src/lib/operationalSignalStart";
import { usesLegacyUsOperatingLedger } from "../src/lib/legacyUsLedgerBoundary";
import { loadPublishedUsRecoveryView } from "./us-recovery-publication";
import { compactRow, publishBrowserViews } from "./us-screening-publication";
import { assertUsScreeningCoverage } from "./us-replay-source";
import { readFileSync } from "node:fs";
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

/** One screening source, whether it was registered in Supabase or handed over from Drive. */
export interface UsScreeningSource {
  user_id?: string;
  as_of_date: string;
  storage_bucket: string;
  storage_path: string;
  row_count: number;
  symbol_count: number;
  data_hash: string;
  schema_version: string;
  source_provider: string;
  collected_at: string;
  metadata: Record<string, unknown>;
}

const DRIVE_BUCKET = "google-drive";

/**
 * Read a private-Drive handover: the frozen input CSV plus the collector's own
 * registered-source record. Nothing is fetched from Supabase Storage, so a source
 * that already lives in Drive costs no Supabase storage or egress.
 */
export function loadUsScreeningSourceFromFiles(
  csvPath: string,
  metadataPath: string,
  expectedHash?: string,
): { source: UsScreeningSource; csv: string } {
  const raw = readFileSync(csvPath);
  const actualHash = `sha256:${sha256(raw)}`;
  const expected = (expectedHash ?? "").trim().replace(/^sha256:/, "");
  if (expected && expected !== actualHash.slice("sha256:".length))
    throw new Error("US 입력 해시 불일치: 전달된 지문과 로컬 CSV가 다릅니다");
  const declared = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<UsScreeningSource>;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    throw new Error("US 입력 메타데이터 형식이 올바르지 않습니다");
  const text = raw.toString("utf8");
  const rows = parseUsProspectiveCsv(text);
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const asOfDate = dates.at(-1);
  if (dates.length !== 1 || !asOfDate || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate))
    throw new Error("US 입력 CSV는 단일 기준일의 행만 담아야 합니다");
  const symbolCount = new Set(rows.map((row) => row.symbol)).size;
  if (declared.data_hash !== actualHash)
    throw new Error("US 입력 해시 불일치: 등록 기록과 로컬 CSV가 다릅니다");
  if (declared.as_of_date !== asOfDate) throw new Error("US 입력 기준일이 등록 기록과 다릅니다");
  if (declared.row_count !== rows.length || declared.symbol_count !== symbolCount)
    throw new Error("US 입력 행/종목 수가 등록 기록과 다릅니다");
  if (
    !declared.metadata ||
    typeof declared.metadata !== "object" ||
    Array.isArray(declared.metadata)
  )
    throw new Error("US 입력 메타데이터가 비어 있습니다");
  const bucket = declared.storage_bucket === DRIVE_BUCKET ? DRIVE_BUCKET : ANALYSIS_BUCKET;
  if (
    typeof declared.storage_path !== "string" ||
    !declared.storage_path ||
    (bucket === DRIVE_BUCKET && !declared.storage_path.startsWith("drive://"))
  )
    throw new Error("US 입력 원천 위치 기록이 올바르지 않습니다");
  for (const key of ["schema_version", "source_provider", "collected_at"] as const)
    if (typeof declared[key] !== "string" || !declared[key])
      throw new Error(`US 입력 메타데이터에 ${key}가 없습니다`);
  if (!Number.isFinite(Date.parse(String(declared.collected_at))))
    throw new Error("US 입력 수집 시각이 올바르지 않습니다");
  assertUsScreeningCoverage(declared.metadata, rows);
  return {
    source: {
      ...declared,
      as_of_date: asOfDate,
      data_hash: actualHash,
      row_count: rows.length,
      symbol_count: symbolCount,
      storage_bucket: bucket,
      metadata: declared.metadata,
    } as UsScreeningSource,
    csv: text,
  };
}

async function loadRegisteredUsSource(
  client: ReturnType<typeof trustedSupabaseClient>,
  userId: string,
) {
  const { data: ingest, error: ingestError } = await client
    .from("us_screening_ingest")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (ingestError) throw new Error(`US ingest 조회 실패: ${ingestError.message}`);
  return ingest;
}

function requireInputMetadata(inputFile: string, metadataPath: string | undefined) {
  if (!metadataPath)
    throw new Error(
      `--input-file(${inputFile})에는 수집기가 남긴 --input-metadata 원천 기록이 함께 필요합니다.`,
    );
  return metadataPath;
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
  options: { source?: UsScreeningSource; csv?: string } = {},
) {
  const ingest = options.source ?? (await loadRegisteredUsSource(client, userId));
  if (!ingest) {
    console.log("No US ingest yet; nothing to process.");
    return;
  }
  const legacyOperating = usesLegacyUsOperatingLedger(String(ingest.as_of_date));
  // A Drive handover is verified by the caller's file hash, not by a Storage bucket.
  if (!options.source && ingest.storage_bucket !== ANALYSIS_BUCKET)
    throw new Error("Unexpected US storage bucket");

  if (options.source && typeof options.csv !== "string")
    throw new Error("US Drive 입력 본문이 함께 전달되지 않았습니다");
  const csv = options.csv ?? (await downloadText(client, String(ingest.storage_path)));
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
  const inputFile = arg("--input-file");
  const inputMetadata = arg("--input-metadata");
  const inputSha256 = arg("--input-sha256");
  const handover = inputFile
    ? loadUsScreeningSourceFromFiles(
        inputFile,
        requireInputMetadata(inputFile, inputMetadata),
        inputSha256,
      )
    : undefined;
  if (!handover && (inputMetadata || inputSha256))
    throw new Error("--input-metadata/--input-sha256는 --input-file과 함께 써야 합니다.");
  await runUsScreening(
    trustedSupabaseClient(),
    userId,
    handover ? { source: handover.source, csv: handover.csv } : {},
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      `US screening stopped; private diagnostic ${sha256(error instanceof Error ? error.message : "unknown").slice(0, 12)}. Check source and model preflight evidence before retrying.`,
    );
    process.exitCode = 1;
  });
