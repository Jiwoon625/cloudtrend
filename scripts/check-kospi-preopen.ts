/** Read-only early warning. This is not an admission or a publication command. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { octoberModelCalendar, regularOpenAt } from "../src/lib/ledger/octoberShadowCalendar";
import { assertHistoricalManifest } from "./kospi-shadow-late-recovery";
import { downloadJson, trustedSupabaseClient } from "./analysis-run-store";
import type { SourceRecord } from "./source-registry-store";

export async function preopenTarget(now: string) {
  if (!Number.isFinite(Date.parse(now))) throw new Error("Invalid observation time");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
  const calendar = await octoberModelCalendar("KR", today);
  if (!calendar.regularSessions.includes(today)) return null;
  const date = calendar.regularSessions.at(-2);
  if (!date) throw new Error("No covered predecessor session");
  const cutoff = regularOpenAt("KR", today);
  if (Date.parse(now) >= Date.parse(cutoff))
    throw new Error(`KOSPI pre-open window already closed for ${date}; do not backdate evidence`);
  if (Date.parse(now) < Date.parse(`${today}T08:00:00+09:00`))
    throw new Error("KOSPI morning refresh window has not started");
  return { date, cutoff };
}

export async function checkKospiPreopen(client: SupabaseClient, uid: string, now: string) {
  const target = await preopenTarget(now);
  if (!target) return { status: "NON_SESSION", readOnly: true };
  const { date, cutoff } = target;
  const {
    data: records,
    error,
    count,
  } = await client
    .from("analysis_source_files")
    .select("*", { count: "exact" })
    .eq("user_id", uid)
    .eq("source_type", "screening")
    .order("activated_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error || count === null || records?.length !== count)
    throw new Error("Pre-open source registry incomplete or unavailable");
  if (
    records.some(
      (r: SourceRecord) =>
        r.user_id !== uid || !r.storage_path.startsWith(`${uid}/source/screening/`),
    )
  )
    throw new Error("Cross-owner source registry path");
  // Do not admit future-dated registrations even when they precede the open.
  if (
    records.some((r: SourceRecord) =>
      [r.created_at, r.updated_at, r.activated_at]
        .filter(Boolean)
        .some((at) => !Number.isFinite(Date.parse(at!)) || Date.parse(at!) > Date.parse(now)),
    )
  )
    throw new Error("Source registry contains invalid or future timestamps");
  const {
    data: runs,
    error: runError,
    count: runCount,
  } = await client
    .from("analysis_runs")
    .select("id,created_at,completed_at,data_version,result_path,code_version", { count: "exact" })
    .eq("user_id", uid)
    .eq("kind", "SCREENING")
    .eq("status", "COMPLETED")
    .eq("as_of_date", date)
    .order("created_at", { ascending: false });
  if (runError || runCount === null || runs?.length !== runCount)
    throw new Error("Pre-open screening run list incomplete or unavailable");
  const failures: string[] = [];
  for (const run of runs) {
    try {
      if (!run.result_path?.startsWith(`${uid}/results/screening/`))
        throw new Error("Invalid owner-scoped screening path");
      for (const at of [run.created_at, run.completed_at])
        if (!Number.isFinite(Date.parse(at)) || Date.parse(at) > Date.parse(now))
          throw new Error("Screening run has invalid or future timestamps");
      const bundle = await downloadJson<Parameters<typeof assertHistoricalManifest>[0]>(
        client,
        run.result_path,
      );
      if (
        `screening-${bundle.run?.id}` !== run.id ||
        Date.parse(bundle.run.createdAt) !== Date.parse(run.created_at) ||
        bundle.run.codeVersion !== run.code_version
      )
        throw new Error("Screening manifest identity mismatch");
      const proof = assertHistoricalManifest(
        bundle,
        records as SourceRecord[],
        date,
        run.data_version,
      );
      return {
        status: "PREOPEN_MANIFEST_VERIFIED",
        readOnly: true,
        date,
        cutoff,
        observedAt: now,
        sourceCollectedAt: proof.sourceCollectedAt,
        sourceCount: proof.selected.length,
        evidenceRunId: run.id,
        publicationVerified: false,
      };
    } catch (error) {
      failures.push(`${run.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `KOSPI pre-open evidence missing for ${date} before ${cutoff}. ` +
      "Complete the morning source refresh and screening before open; do not substitute after-open data. " +
      (failures.length ? failures.join("; ") : "No exact-date completed screening run."),
  );
}

if (process.argv.includes("--run")) {
  const uid = process.env.SUPABASE_USER_ID;
  if (!uid) throw new Error("SUPABASE_USER_ID is required");
  console.log(
    JSON.stringify(await checkKospiPreopen(trustedSupabaseClient(), uid, new Date().toISOString())),
  );
}
