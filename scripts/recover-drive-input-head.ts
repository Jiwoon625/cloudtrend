/** Head-only recovery. All publishers must be paused: fresh reads are not a storage CAS. */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { KR_OWNER } from "./drive-history-inputs";
import { downloadFreshObject } from "../src/lib/freshStorage";
import { currentDriveGeneration } from "../src/lib/driveResultPublication";
import {
  deterministicAnalysis,
  stableCacheJson,
  SCREENING_CACHE_VERSION,
  DASHBOARD_CACHE_VERSION,
} from "../src/lib/screeningCacheContract";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import { ANALYSIS_BUCKET, sha256, trustedSupabaseClient } from "./analysis-run-store";

export const HEAD_RECOVERY_EVIDENCE = Object.freeze({
  publicationId: "5f52ffb3-ecd9-420c-a293-bb86cee064d7",
  inputFingerprint: "5d36ba2fd0dce10c5f1df5ab118af9badd7b1afae5f8b27b76d04555e1d207f4",
  resultDigest: "4b6e1bd68a308b63efacacebdfb963ace16650c6797bcbe1cac08b6dc6d0f12a",
  failedDigest: "ee349d7f807c728e46a58aa48efd3501158843867370e926f36d2fce634fe95a",
  asOfDate: "2026-11-09",
});
// Untrusted JSON is explicitly validated before it is used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Boundary JSON is validated field-by-field before use.
type Json = Record<string, any>;
const equal = (a: unknown, b: unknown) => stableCacheJson(a) === stableCacheJson(b);
function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`Head recovery blocked: ${reason}`);
}
const digest = (a: AnalysisResult) => sha256(stableCacheJson(deterministicAnalysis(a)));
export async function recoverDriveInputHead(input: {
  client: SupabaseClient;
  owner: string;
  expectedOwner: string;
  apply: boolean;
  reportPath: string;
}) {
  const { client, owner } = input;
  const e = HEAD_RECOVERY_EVIDENCE;
  const report: Json = {
    version: 1,
    mode: input.apply ? "apply" : "inspect",
    writesAttempted: 0,
    verified: false,
  };
  try {
    check(/^[A-Za-z0-9_-]+$/.test(owner) && owner === input.expectedOwner, "owner mismatch");
    const headPath = `${owner}/results/drive-screening/input-head/latest.json`;
    const screeningPath = `${owner}/cache/screening/latest.json`;
    const dashboardPath = `${owner}/cache/dashboard/latest.json`;
    async function read(path: string): Promise<Json> {
      check(path.startsWith(`${owner}/`), "read outside owner");
      const { data, error } = await downloadFreshObject(client, ANALYSIS_BUCKET, path);
      if (error) throw new Error(`Recovery read failed (${path}): ${error.message}`);
      check(data, "missing object");
      const value = JSON.parse(await data.text());
      check(value && typeof value === "object" && !Array.isArray(value), "invalid JSON object");
      return value;
    }
    const readGeneration = () =>
      Promise.all([read(headPath), read(screeningPath), read(dashboardPath)]);
    const initial = await readGeneration();
    const [head, screening, dashboard] = initial;
    check(
      screening!["version"] === SCREENING_CACHE_VERSION &&
        dashboard!["version"] === DASHBOARD_CACHE_VERSION,
      "cache versions",
    );
    for (const cache of [screening!, dashboard!])
      check(
        cache["publicationId"] === e.publicationId &&
          cache["inputFingerprint"] === e.inputFingerprint &&
          cache["resultDigest"] === e.resultDigest,
        "old cache identity",
      );
    const analysis = screening!["payload"]?.analysis;
    const proof = screening!["payload"]?.source?.drivePublication;
    check(
      analysis?.asOfDate === e.asOfDate &&
        dashboard!["asOfDate"] === e.asOfDate &&
        digest(analysis) === e.resultDigest,
      "old cache actual digest/date",
    );
    check(
      proof?.version === "drive-result-publication-v1" &&
        proof.asOfDate === e.asOfDate &&
        proof.phase === "FINAL" &&
        Array.isArray(proof.sources) &&
        proof.sources.length > 0,
      "old source proof",
    );
    check(
      equal(proof, dashboard!["drivePublication"]) && equal(proof, head!["drivePublication"]),
      "source proof mismatch",
    );
    const restored = {
      version: "drive-input-head-v1",
      drivePublication: proof,
      publicationId: screening!["publicationId"],
      inputFingerprint: screening!["inputFingerprint"],
      resultDigest: screening!["resultDigest"],
    };
    const alreadyRestored = equal(head, restored);
    check(
      alreadyRestored ||
        (head!["version"] === "drive-input-head-v1" &&
          head!["inputFingerprint"] === e.inputFingerprint &&
          head!["resultDigest"] === e.failedDigest &&
          typeof head!["publicationId"] === "string" &&
          head!["publicationId"] !== e.publicationId &&
          /^[a-f0-9-]{36}$/.test(head!["publicationId"]) &&
          Object.keys(head!).sort().join() === Object.keys(restored).sort().join()),
      "unknown/newer head",
    );
    // Independent original publication evidence is mandatory.
    const latestPath = `${owner}/results/screening/latest.json`;
    const latest = await read(latestPath);
    const runId = latest["run"]?.id;
    check(typeof runId === "string" && /^[A-Za-z0-9_-]+$/.test(runId), "archive run id");
    check(latest["resultPath"] === `${owner}/results/screening/${runId}.json`, "archive target");
    const [bundle, receipt] = await Promise.all([
      read(latest["resultPath"]),
      read(`${owner}/results/drive-screening/receipts/${runId}.json`),
    ]);
    for (const metadata of [latest["publication"], receipt])
      check(
        metadata?.publicationId === e.publicationId &&
          metadata.inputFingerprint === e.inputFingerprint &&
          metadata.resultDigest === e.resultDigest,
        "original publication evidence",
      );
    check(
      receipt["version"] === "drive-result-receipt-v1" &&
        receipt["date"] === e.asOfDate &&
        receipt["phase"] === "FINAL" &&
        receipt["resultPath"] === latest["resultPath"],
      "original receipt",
    );
    check(
      bundle["run"]?.id === runId &&
        bundle["result"]?.asOfDate === e.asOfDate &&
        digest(bundle["result"]) === e.resultDigest,
      "original bundle digest",
    );
    const secondLatest = await read(latestPath);
    const second = await readGeneration();
    check(
      equal(latest, secondLatest) && equal(initial, second),
      "concurrent publication/cache change",
    );
    Object.assign(report, {
      publicationId: e.publicationId,
      inputFingerprint: e.inputFingerprint,
      resultDigest: e.resultDigest,
      alreadyRestored,
    });
    if (input.apply && !alreadyRestored) {
      // Sole network write: fixed bucket, validated owner, fixed head suffix. No retries.
      report["writesAttempted"] = 1;
      const { error } = await client.storage
        .from(ANALYSIS_BUCKET)
        .upload(headPath, JSON.stringify(restored), {
          contentType: "application/json",
          upsert: true,
        });
      if (error) throw new Error(`Recovery upload outcome must be inspected: ${error.message}`);
    }
    if (input.apply || alreadyRestored) {
      const [savedHead, savedScreening, savedDashboard] = await readGeneration();
      check(
        equal(savedHead, restored) &&
          equal(savedScreening, screening) &&
          equal(savedDashboard, dashboard),
        "recovery readback mismatch",
      );
      check(
        currentDriveGeneration(savedHead, {
          ...savedScreening,
          drivePublication: savedScreening!["payload"].source.drivePublication,
        } as never) && currentDriveGeneration(savedHead, savedDashboard as never),
        "generation readback mismatch",
      );
    }
    report["verified"] = true;
    report["status"] = alreadyRestored
      ? "already-restored"
      : input.apply
        ? "restored"
        : "eligible-no-write";
    return report;
  } catch (error) {
    report["error"] = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await writeFile(input.reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  }
}
export function recoveryCliApply(args: string[]): boolean {
  check(
    args.length === 0 || (args.length === 1 && args[0] === "--apply"),
    "usage: recover-drive-input-head.ts [--apply]",
  );
  return args[0] === "--apply";
}
async function main() {
  const apply = recoveryCliApply(process.argv.slice(2));
  check(
    process.env["SUPABASE_URL"] === "https://ahbvrtugugwnbrfnbxzp.supabase.co",
    "unexpected Supabase project",
  );
  const report = await recoverDriveInputHead({
    client: trustedSupabaseClient(),
    owner: process.env["SUPABASE_USER_ID"] ?? "",
    expectedOwner: KR_OWNER,
    apply,
    reportPath: resolve("drive-input-head-recovery-report.json"),
  });
  console.log(
    JSON.stringify({
      status: report["status"],
      verified: report["verified"],
      writesAttempted: report["writesAttempted"],
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
