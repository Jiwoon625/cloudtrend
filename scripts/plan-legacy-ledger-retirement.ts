/** Read-only inventory. There is intentionally no --apply mode and no write client. */
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { stableJson, trustedSupabaseClient } from "./analysis-run-store";

const LEGACY_STRATEGIES = [
  "A0_QUARTER_PRIMARY",
  "A2_QUARTER_SHADOW",
  "B3_BETA_SHADOW",
  "SPY_BENCHMARK",
];
const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function summarizeActualRetirement(row: Record<string, unknown>) {
  const payload = row["payload"];
  if (!record(payload) || !Array.isArray(payload["executions"]))
    throw new Error("Actual document shape is unverified; retirement is blocked");
  const metadata = payload["newActualPortfolio"];
  if (
    !record(metadata) ||
    metadata["seriesId"] !== "actual-performance-2026-10-12-v1" ||
    !record(metadata["assignments"])
  )
    throw new Error("New actual series identity is missing; retirement is blocked");
  const executions = payload["executions"];
  const ids = executions.map((e) => (record(e) && typeof e["id"] === "string" ? e["id"] : null));
  if (ids.some((id) => id === null) || new Set(ids).size !== ids.length)
    throw new Error("Actual execution identities are missing or duplicated");
  const assigned = new Set(Object.keys(metadata["assignments"]));
  if ([...assigned].some((id) => !ids.includes(id)))
    throw new Error("New actual assignment source is missing");
  return {
    revision: row["revision"],
    updatedAt: row["updated_at"],
    documentHash: digest(payload),
    newActualMetadataHash: digest(metadata),
    executionCount: executions.length,
    currentAssignedSourceIds: [...assigned].sort(),
    // IDs alone are candidates for review, not a deletion instruction. Mixed-source
    // and canceled allocation history still requires full audit reconciliation.
    unassignedHistoricalCandidateIds: executions
      .filter((e) => {
        if (!record(e) || typeof e["id"] !== "string" || assigned.has(e["id"])) return false;
        return typeof e["date"] === "string" && e["date"] < "2026-10-12";
      })
      .map((e) => (e as Record<string, unknown>)["id"])
      .sort(),
    preservedKeys: Object.keys(payload).sort(),
    mutationAllowed: false,
  };
}

export async function planLegacyLedgerRetirement(client: SupabaseClient, userId: string) {
  if (!/^[a-f0-9-]{36}$/i.test(userId)) throw new Error("Exact owner is required");
  const tablePlans = [];
  for (const [table, key] of [
    ["us_strategy_registry", "strategy_id"],
    ["us_portfolio_snapshots", "strategy_id,date"],
    ["us_portfolio_trades", "trade_key"],
  ]) {
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += 500) {
      let query = client
        .from(table!)
        .select("*")
        .eq("user_id", userId)
        .in("strategy_id", LEGACY_STRATEGIES);
      for (const column of key!.split(",")) query = query.order(column, { ascending: true });
      const { data, error } = await query.range(offset, offset + 499);
      if (error || !data) throw new Error(`Legacy inventory read failed: ${table}`);
      rows.push(...data);
      if (data.length < 500) break;
    }
    tablePlans.push({
      table,
      key: `user_id,${key}`,
      strategies: LEGACY_STRATEGIES,
      rows: rows.length,
      hash: digest(rows),
    });
  }
  const actualPlans = [];
  for (const table of ["portfolio_ledgers", "us_actual_portfolio_ledgers"]) {
    const { data, error } = await client
      .from(table)
      .select("revision,updated_at,payload")
      .eq("user_id", userId)
      .single();
    if (error || !data) throw new Error(`Actual inventory read failed: ${table}`);
    actualPlans.push({ table, ...summarizeActualRetirement(data) });
  }
  return {
    version: "legacy-ledger-retirement-plan-v1",
    mode: "READ_ONLY",
    tablePlans,
    actualPlans,
    requiredBeforeMutation: [
      "Reviewed source + exact target approval; no blanket date deletion",
      "Stop current writers and verify restart-only daily, multi-day, same-date recovery",
      "Owner-private full archive + schema/constraints + rowcount/hash verification and restore drill",
      "Recheck all source hashes/revisions under a maintenance lock",
      "Preserve new actual metadata and assigned execution sources, new model series/sessions, prices, ranks and research",
      "Review canonical trigger behavior; never directly clear original execution arrays",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--apply"))
    throw new Error("This command is read-only; --apply is unsupported");
  const at = process.argv.indexOf("--user");
  const userId = at >= 0 ? process.argv[at + 1] : undefined;
  if (!userId) throw new Error("--user is required");
  planLegacyLedgerRetirement(trustedSupabaseClient(), userId)
    .then((plan) => console.log(JSON.stringify(plan, null, 2)))
    .catch(() => {
      console.error("Read-only retirement planning failed; no data changed");
      process.exitCode = 1;
    });
}
