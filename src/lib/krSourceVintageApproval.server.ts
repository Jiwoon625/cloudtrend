import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalSeriesJson } from "./ledger/modelSeries";
import {
  KR_SOURCE_VINTAGE_REVIEW_ID,
  verifyKrSourceVintagePrivateApproval,
  type KrSourceVintagePrivateApproval,
} from "./ledger/krSourceVintage";

/** Existing owner-only append-only audit is the approval registry. Receipt bodies
 * are separate records; their own declared hash is never an admission authority.
 * Provisioning is a separately approved action, never performed by source ingestion.
 */
export async function readKrSourceVintageApproval(
  client: SupabaseClient,
  uid: string,
): Promise<KrSourceVintagePrivateApproval | null> {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uid))
    throw new Error("Verified private review owner required");
  const read = async (key: "krSourceVintageApproval" | "krSourceVintageReview") => {
    const { data, error } = await client
      .from("shadow_replay_audit")
      .select("details")
      .eq("user_id", uid)
      .eq("market", "KR")
      .eq("strategy_version", KR_SOURCE_VINTAGE_REVIEW_ID)
      .contains("details", { [key]: { reviewId: KR_SOURCE_VINTAGE_REVIEW_ID } });
    if (error) throw new Error("Private KR source vintage approval lookup failed");
    let selected: unknown = null;
    for (const row of data ?? []) {
      const value = row.details?.[key];
      if (!value || (selected && canonicalSeriesJson(selected) !== canonicalSeriesJson(value)))
        throw new Error("Conflicting private KR source vintage approval records");
      selected = value;
    }
    return selected;
  };
  const [registry, receipt] = await Promise.all([
    read("krSourceVintageApproval"),
    read("krSourceVintageReview"),
  ]);
  if (!registry && !receipt) return null;
  if (!registry || !receipt) throw new Error("Incomplete private KR source vintage approval");
  const result = { registry, receipt } as KrSourceVintagePrivateApproval;
  await verifyKrSourceVintagePrivateApproval(result);
  return result;
}
