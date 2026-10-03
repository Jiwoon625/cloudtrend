import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActualExecution } from "../portfolioLedgers";
import { canonicalJson } from "./migration";
import type { LedgerEvent, Security } from "./types";
import {
  projectWebsiteExecutions,
  validateWebsiteSource,
  type WebsiteSourceSystem,
} from "./websiteProjection";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One read-only invoker RPC snapshot. The compatibility document is never a fallback. */
export async function readWebsiteDocument<T extends { executions: ActualExecution<string>[] }>(
  client: Pick<SupabaseClient, "rpc">,
  userId: string,
  sourceSystem: WebsiteSourceSystem,
): Promise<{ revision: number; payload: T } | null> {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(userId))
    throw new Error("Verified owner ID required");
  validateWebsiteSource(sourceSystem);
  const { data, error } = await client.rpc("ledger_read_website_document", {
    p_user_id: userId,
    p_source_system: sourceSystem,
  });
  if (error) throw new Error(`Website journal read failed: ${error.message}`);
  if (data === null) return null;
  const snapshot: unknown = data;
  if (
    !isRecord(snapshot) ||
    snapshot["integrityValid"] !== true ||
    typeof snapshot["revision"] !== "number" ||
    !Number.isSafeInteger(snapshot["revision"]) ||
    snapshot["revision"] < 1 ||
    !isRecord(snapshot["payload"]) ||
    !Array.isArray(snapshot["payload"]["executions"]) ||
    !Array.isArray(snapshot["events"]) ||
    !Array.isArray(snapshot["sourceIdentities"]) ||
    !Array.isArray(snapshot["securities"])
  )
    throw new Error("Invalid website journal snapshot response");
  const projected = projectWebsiteExecutions(
    snapshot["events"] as LedgerEvent[],
    sourceSystem,
    snapshot["securities"] as Security[],
  );
  // Source registration is itself append-only. An orphan registration must not
  // disappear from a seemingly complete read when a privileged writer stops early.
  const sourceIdentities = new Map<string, string>();
  for (const identity of snapshot["sourceIdentities"]) {
    if (
      !isRecord(identity) ||
      typeof identity["sourceRecordId"] !== "string" ||
      typeof identity["eventId"] !== "string" ||
      !identity["sourceRecordId"] ||
      !identity["eventId"] ||
      sourceIdentities.has(identity["sourceRecordId"])
    )
      throw new Error("Website source registry diverged from canonical events");
    sourceIdentities.set(identity["sourceRecordId"], identity["eventId"]);
  }
  const covered = new Set<string>();
  for (const event of snapshot["events"] as LedgerEvent[]) {
    if (sourceIdentities.get(event.source.recordId) !== event.id)
      throw new Error("Website source registry diverged from canonical events");
    covered.add(event.source.recordId);
  }
  if (covered.size !== sourceIdentities.size)
    throw new Error("Website source registry diverged from canonical events");
  const byId = new Map(projected.map((execution) => [execution.id, execution]));
  const executions: ActualExecution<string>[] = [];
  const documentExecutions: unknown[] = snapshot["payload"]["executions"];
  for (const original of documentExecutions) {
    if (!isRecord(original) || typeof original["id"] !== "string")
      throw new Error("Invalid website document execution");
    const execution = byId.get(original["id"]);
    if (!execution || canonicalJson(original) !== canonicalJson(execution))
      throw new Error("Website document and canonical executions diverged");
    executions.push(execution);
    byId.delete(execution.id);
  }
  if (byId.size !== 0) throw new Error("Website document and canonical executions diverged");
  return {
    revision: snapshot["revision"],
    // Keep settings, exclusions, strategy, capital and unknown document fields intact.
    // The existing source array owns presentation order, after exact set verification.
    payload: { ...snapshot["payload"], executions } as T,
  };
}
