import { reconciliationBudget } from "./execution-policy";
import { inspectNoWork } from "./quick-inspection";
import { freshInfoTransport } from "./fresh-info-transport";
import { budgetTransport } from "./budget-transport";
import type { GenerationProbe } from "./generation-cache";
import { createClient } from "@supabase/supabase-js";
import { verifyShadowRuntimeManifests } from "../verify-shadow-runtime-manifests";
import { buildReconcilePort } from "./adapter";
import { reconcile } from "./core";
import { OCTOBER_CALENDAR_EVIDENCE } from "../../src/lib/ledger/octoberShadowCalendar";
let readUsage: (() => { bytes: number; requests: number }) | undefined;
async function main() {
  await verifyShadowRuntimeManifests();
  const uid = process.env.SUPABASE_USER_ID ?? "",
    url = process.env.SUPABASE_URL ?? "",
    secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uid) ||
    !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url) ||
    !secret
  )
    throw Error("Configured owner connection required");
  const applyFlag = process.env.RECONCILE_APPLY ?? "false";
  const maxBytes = reconciliationBudget(applyFlag, process.env.RECONCILE_INSPECTION_BUDGET_MIB);
  const budget = budgetTransport({
    expectedOrigin: url,
    fetch: globalThis.fetch,
    maxBytes,
    maxRequests: 1000,
  });
  readUsage = budget.usage;
  const client = createClient(url, secret, {
    global: { fetch: freshInfoTransport({ expectedOrigin: url, fetch: budget.fetch }) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let throughDate = process.env.RECONCILE_THROUGH_DATE ?? "";
  if (!throughDate) {
    const { data, error } = await client
      .from("ledger_model_sessions")
      .select("session_date")
      .eq("user_id", uid)
      .like("series_id", "adopted-shadow-2026-10-12-v1:%")
      .order("session_date", { ascending: false })
      .limit(1);
    if (error || !data?.[0]?.session_date) throw Error("Market horizon unavailable");
    throughDate = data[0].session_date;
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(throughDate) ||
    throughDate < "2026-10-12" ||
    throughDate > OCTOBER_CALENDAR_EVIDENCE.coverageEnd ||
    new Date(`${throughDate}T00:00:00Z`).toISOString().slice(0, 10) !== throughDate
  )
    throw Error("Reviewed calendar coverage required");
  const now = new Date().toISOString();
  const freshGeneration = async (path: string): Promise<GenerationProbe> => {
    const { data, error } = await client.storage.from("cloudtrend-data").info(path);
    if (error) {
      if (String(error.statusCode) === "404" || /not found/i.test(error.message)) return null;
      throw Error("Fresh metadata unavailable");
    }
    if (!data) return null;
    if (
      !data.id ||
      !data.version ||
      !data.etag ||
      !Number.isSafeInteger(data.size) ||
      data.size! < 0
    )
      return { kind: "weak" };
    return {
      kind: "strong",
      objectId: data.id,
      version: data.version,
      etag: data.etag,
      size: data.size!,
    };
  };
  const quick = await inspectNoWork(client, uid, throughDate, freshGeneration);
  if (!quick.needsFullInspection) {
    console.log(
      JSON.stringify({
        stage: "INTEGRATED_RECONCILIATION",
        mode: applyFlag === "true" ? "APPLY" : "INSPECT",
        throughDate,
        ...quick,
        recorded: 0,
        restoredInputs: 0,
        readUsage: budget.usage(),
      }),
    );
    return;
  }
  const port = await buildReconcilePort(client, uid, now, throughDate, {
    freshGeneration,
    useVerifiedCheckpoint: true,
  });
  const report = await reconcile(port, { now, apply: applyFlag === "true" });
  // Deliberately omit owner IDs, financial data, source hashes, credentials and raw inputs.
  console.log(
    JSON.stringify({
      stage: "INTEGRATED_RECONCILIATION",
      mode: applyFlag === "true" ? "APPLY" : "INSPECT",
      ...report,
      verificationScope: port.verificationScope,
      readUsage: budget.usage(),
    }),
  );
  if (report.status === "REPAIR_REQUIRED") process.exitCode = 2;
}
main().catch(() => {
  console.error(
    "INTEGRATED_RECONCILIATION_BLOCKED: inspect committed state before retry; no raw input fallback",
  );
  if (readUsage) console.error(JSON.stringify({ stage: "BOUNDED_READ_USAGE", ...readUsage() }));
  process.exitCode = 1;
});
