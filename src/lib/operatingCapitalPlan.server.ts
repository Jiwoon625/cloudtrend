import type { SupabaseClient } from "@supabase/supabase-js";
import type { LedgerDocument } from "./portfolioLedgers";
import { canonicalJson } from "./ledger/migration";
import { readWebsiteDocument } from "./ledger/websiteRepository.server";
import {
  CAPITAL_PLAN_ERRORS,
  prepareOperatingCapitalPlan,
  readOperatingCapitalPlan,
  type OperatingCapitalPlan,
} from "./operatingCapitalPlan";

type PlanDocument = LedgerDocument & { operatingCapitalPlan?: OperatingCapitalPlan };
export type CapitalPlanResult = { revision: number | null; plan: OperatingCapitalPlan | null };
export async function loadOperatingCapitalPlan(
  client: SupabaseClient,
  userId: string,
): Promise<CapitalPlanResult> {
  const row = await readWebsiteDocument<PlanDocument>(client, userId, "portfolio_ledgers");
  return {
    revision: row?.revision ?? null,
    plan: readOperatingCapitalPlan(row?.payload.operatingCapitalPlan),
  };
}
export async function writeOperatingCapitalPlan(
  client: SupabaseClient,
  userId: string,
  input: { action: "preview" | "save"; expectedRevision: number; plannedCapitalKrw: string },
  now = new Date().toISOString(),
) {
  const candidate = prepareOperatingCapitalPlan(input.plannedCapitalKrw, now);
  if (input.action !== "preview" && input.action !== "save")
    throw new Error(CAPITAL_PLAN_ERRORS.input);
  const row = await readWebsiteDocument<PlanDocument>(client, userId, "portfolio_ledgers");
  if (!row) throw new Error(CAPITAL_PLAN_ERRORS.missing);
  if (!Number.isSafeInteger(input.expectedRevision) || row.revision !== input.expectedRevision)
    throw new Error(CAPITAL_PLAN_ERRORS.conflict);
  const previous = readOperatingCapitalPlan(row.payload.operatingCapitalPlan);
  if (previous && previous.plannedCapitalKrw !== candidate.plannedCapitalKrw)
    throw new Error(CAPITAL_PLAN_ERRORS.immutable);
  if (previous || input.action === "preview")
    return { revision: row.revision, plan: previous ?? candidate, reused: !!previous };
  // Existing source projection verifies fills. This metadata-only write preserves every other field.
  const payload = { ...row.payload, operatingCapitalPlan: candidate };
  const saved = await client
    .from("portfolio_ledgers")
    .update({ payload, revision: row.revision + 1, updated_at: candidate.recordedAt })
    .eq("user_id", userId)
    .eq("revision", row.revision)
    .select("revision")
    .maybeSingle();
  if (saved.error) throw new Error(CAPITAL_PLAN_ERRORS.generic);
  if (!saved.data) throw new Error(CAPITAL_PLAN_ERRORS.conflict);
  const checked = await readWebsiteDocument<PlanDocument>(client, userId, "portfolio_ledgers");
  if (
    !checked ||
    checked.revision !== row.revision + 1 ||
    canonicalJson(checked.payload) !== canonicalJson(payload)
  )
    throw new Error(CAPITAL_PLAN_ERRORS.uncertain);
  return { revision: checked.revision, plan: candidate, reused: false };
}
