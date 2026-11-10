import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadJson, trustedSupabaseClient } from "./analysis-run-store";
import { buildSnapshot, persistScreeningSnapshot } from "../src/lib/screeningSnapshot";
import type { ScreeningSnapshot } from "../src/lib/screeningSnapshot";
import { archiveScreeningRun } from "../src/lib/screeningRunArchive";
import { hydrateScreeningSnapshot } from "../src/lib/screeningSnapshotStorage";
import { deterministicAnalysis, stableCacheJson } from "../src/lib/screeningCacheContract";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import { validDate } from "../src/lib/ledger/date";

export const JOURNAL_OWNER = "bdfc8818-33a7-4030-9dbd-ecad39f223ac";
const RUN = /^\d{14}-[a-f0-9]{8}$/;
interface PublicationReceipt {
  version: string;
  phase: string;
  date: string;
  resultPath: string;
  resultDigest: string;
}
interface OriginalBundle {
  run: { id: string; kind: string };
  result: AnalysisResult;
}

/** Original published evidence only. No screener, prices, or strategy recalculation. */
export function verifiedJournalSnapshot(
  receipt: PublicationReceipt,
  bundle: OriginalBundle,
  runId: string,
): ScreeningSnapshot {
  if (
    !RUN.test(runId) ||
    receipt.version !== "drive-result-receipt-v1" ||
    receipt.phase !== "FINAL" ||
    !validDate(receipt.date) ||
    receipt.resultPath !== `${JOURNAL_OWNER}/results/screening/${runId}.json` ||
    bundle.run.id !== runId ||
    bundle.run.kind !== "SCREENING" ||
    bundle.result.asOfDate !== receipt.date ||
    bundle.result.krPublication?.phase === "PRELIMINARY" ||
    !Number.isFinite(Date.parse(bundle.result.calculatedAt)) ||
    createHash("sha256")
      .update(stableCacheJson(deterministicAnalysis(bundle.result)))
      .digest("hex") !== receipt.resultDigest
  )
    throw new Error("Published Drive result identity or FINAL evidence differs");
  return buildSnapshot(bundle.result, undefined, runId);
}

const dailyProjection = (snapshot: ScreeningSnapshot) => ({
  ...snapshot,
  date: snapshot.asOfDate,
  entries: snapshot.entries.map(({ evidence: _evidence, ...entry }) => entry),
  ...(snapshot.topStocks
    ? { topStocks: snapshot.topStocks.map(({ evidence: _evidence, ...entry }) => entry) }
    : {}),
  ...(snapshot.topEtfs
    ? { topEtfs: snapshot.topEtfs.map(({ evidence: _evidence, ...entry }) => entry) }
    : {}),
});

/** Shared writer lock serializes this with the screeners; older revisions never replace newer. */
export async function recordOriginalJournal(client: SupabaseClient, snapshot: ScreeningSnapshot) {
  const { data, error } = await client
    .from("screening_history")
    .select("snapshot")
    .eq("user_id", JOURNAL_OWNER)
    .eq("date", snapshot.asOfDate)
    .maybeSingle();
  if (error) throw new Error(`Journal read failed: ${error.message}`);
  const existing = data?.snapshot ? hydrateScreeningSnapshot(data.snapshot) : null;
  if (existing && !Number.isFinite(Date.parse(existing.savedAt)))
    throw new Error("Existing journal has an invalid calculation time");
  if (existing && Date.parse(existing.savedAt) > Date.parse(snapshot.savedAt)) {
    await archiveScreeningRun(client, JOURNAL_OWNER, snapshot);
    return "ARCHIVED_WITHOUT_REPLACING_NEWER";
  }
  const recorded = await persistScreeningSnapshot(client, JOURNAL_OWNER, snapshot);
  const { data: readback, error: readError } = await client
    .from("screening_history")
    .select("snapshot")
    .eq("user_id", JOURNAL_OWNER)
    .eq("date", snapshot.asOfDate)
    .single();
  if (
    readError ||
    stableCacheJson(hydrateScreeningSnapshot(readback?.snapshot)) !==
      stableCacheJson(dailyProjection(recorded))
  )
    throw new Error("Daily journal readback differs from the original result");
  return "RECORDED_VERIFIED";
}

/** Only verified owner's screening journals may be written. Financial ledgers stay blocked. */
export function installJournalBoundary() {
  const original = globalThis.fetch;
  const verified = new Set<string>();
  const network = { journalWrites: 0, denied: 0, sourceReads: 0 };
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (url.hostname.endsWith(".supabase.co")) {
      const target = decodeURIComponent(url.pathname);
      if (
        url.hostname !== "ahbvrtugugwnbrfnbxzp.supabase.co" ||
        /\/source\/(screening|us-screening)\//.test(target)
      ) {
        network.denied++;
        throw new Error("Journal repair cannot access another project or historical raw source");
      }
      if (!["GET", "HEAD"].includes(method)) {
        let allowed = false;
        if (
          method === "POST" &&
          ["/rest/v1/screening_history", "/rest/v1/screening_run_archive"].includes(target)
        ) {
          try {
            const body = JSON.parse(
              typeof init?.body === "string" ? init.body : await request!.clone().text(),
            );
            const snapshot = hydrateScreeningSnapshot(body.snapshot);
            allowed =
              body.user_id === JOURNAL_OWNER &&
              validDate(body.date) &&
              body.date === snapshot.asOfDate &&
              snapshot.date === snapshot.asOfDate &&
              snapshot.market === "KR" &&
              snapshot.krPublication?.phase !== "PRELIMINARY" &&
              !!snapshot.runId &&
              verified.has(snapshot.runId) &&
              (target.endsWith("screening_history") ||
                (body.run_id === snapshot.runId && body.market === "KR"));
          } catch {
            allowed = false;
          }
        }
        if (!allowed) {
          network.denied++;
          throw new Error("Journal repair blocked an unverified or non-journal write");
        }
        network.journalWrites++;
      }
    }
    return original(input, init);
  };
  return {
    network,
    approve: (runId: string) => {
      if (!RUN.test(runId)) throw new Error("Invalid original run identity");
      verified.add(runId);
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function main() {
  if (process.env["SUPABASE_USER_ID"] !== JOURNAL_OWNER)
    throw new Error("Journal owner differs from the reviewed account");
  const boundary = installJournalBoundary();
  const directory = path.resolve("drive-history-journal");
  await mkdir(directory, { recursive: true });
  const report: Record<string, unknown> = {
    version: "drive-result-history-v1",
    status: "VERIFYING",
    financialLedgerWrites: 0,
    sourceUploads: 0,
    network: boundary.network,
  };
  const items: Array<Record<string, unknown>> = [];
  report["items"] = items;
  try {
    const client = trustedSupabaseClient();
    const latest = await downloadJson<{ resultPath: string }>(
      client,
      `${JOURNAL_OWNER}/results/screening/latest.json`,
    );
    const latestRun = latest.resultPath.split("/").at(-1)?.replace(/\.json$/, "") ?? "";
    let runIds = [latestRun];
    if (process.env["JOURNAL_BACKFILL"] === "true") {
      const request = JSON.parse(
        await readFile(".github/operations/drive-result-history.json", "utf8"),
      ) as { version: string; owner: string; runIds: string[] };
      if (request.version !== "drive-result-history-v1" || request.owner !== JOURNAL_OWNER)
        throw new Error("Unreviewed journal recovery request");
      runIds = [...request.runIds, latestRun];
    }
    if (runIds.length > 100 || runIds.some((id) => !RUN.test(id)))
      throw new Error("Invalid journal run selection");
    const verified: ScreeningSnapshot[] = [];
    for (const runId of [...new Set(runIds)]) {
      const receipt = await downloadJson<PublicationReceipt>(
        client,
        `${JOURNAL_OWNER}/results/drive-screening/receipts/${runId}.json`,
      );
      if (receipt.phase === "PRELIMINARY") {
        items.push({ runId, status: "PRESERVED_PRELIMINARY_ONLY", date: receipt.date });
        continue;
      }
      const expectedPath = `${JOURNAL_OWNER}/results/screening/${runId}.json`;
      if (receipt.resultPath !== expectedPath) throw new Error("Unexpected original bundle path");
      const bundle = await downloadJson<OriginalBundle>(client, expectedPath);
      verified.push(verifiedJournalSnapshot(receipt, bundle, runId));
    }
    verified.sort((a, b) => Date.parse(a.savedAt) - Date.parse(b.savedAt));
    report["status"] = "RECORDING";
    for (const snapshot of verified) {
      boundary.approve(snapshot.runId!);
      const status = await recordOriginalJournal(client, snapshot);
      items.push({ runId: snapshot.runId, date: snapshot.asOfDate, status });
    }
    report["status"] = "COMPLETED_VERIFIED";
    report["verifiedOriginalRuns"] = verified.length;
    report["dates"] = [...new Set(verified.map((snapshot) => snapshot.asOfDate))].sort();
  } catch (error) {
    report["status"] = "FAILED";
    report["error"] = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    boundary.restore();
    await writeFile(
      path.join(directory, "execution-receipt.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  }
}
if (!process.env["VITEST"])
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Journal restoration failed");
    process.exitCode = 1;
  });
