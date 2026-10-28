import type { SupabaseClient } from "@supabase/supabase-js";
import { validDate } from "./ledger/date";
import { canonicalSeriesJson } from "./ledger/modelSeries";
import {
  KR_SOURCE_VINTAGE_REVIEW_ID,
  KR_SOURCE_VINTAGE_SUCCESSOR_REVIEW_ID,
  verifyKrSourceVintagePrivateApproval,
  type KrSourceVintagePrivateApproval,
  type KrSourceVintagePrivateApprovalV1,
  type KrSourceVintagePrivateApprovalV2,
} from "./ledger/krSourceVintage";

/** Existing owner-only append-only audit is the approval registry. Receipt bodies
 * are separate records; their own declared hash is never an admission authority.
 * Provisioning is a separately approved action, never performed by source ingestion.
 */
export async function readKrSourceVintageApproval(
  client: SupabaseClient,
  uid: string,
  publicationDate?: string,
): Promise<KrSourceVintagePrivateApproval | null> {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uid))
    throw new Error("Verified private review owner required");
  if (publicationDate !== undefined && !validDate(publicationDate))
    throw new Error("Invalid private KR source vintage publication date");
  const read = async (
    key: "krSourceVintageApproval" | "krSourceVintageReview",
    reviewId: string,
  ) => {
    const { data, error } = await client
      .from("shadow_replay_audit")
      .select("details")
      .eq("user_id", uid)
      .eq("market", "KR")
      .eq("strategy_version", reviewId)
      .contains("details", { [key]: { reviewId } });
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
  const [registry, receipt, nextRegistry, nextReceipt] = await Promise.all([
    read("krSourceVintageApproval", KR_SOURCE_VINTAGE_REVIEW_ID),
    read("krSourceVintageReview", KR_SOURCE_VINTAGE_REVIEW_ID),
    read("krSourceVintageApproval", KR_SOURCE_VINTAGE_SUCCESSOR_REVIEW_ID),
    read("krSourceVintageReview", KR_SOURCE_VINTAGE_SUCCESSOR_REVIEW_ID),
  ]);
  if (!registry && !receipt && !nextRegistry && !nextReceipt) return null;
  if (!registry || !receipt) throw new Error("Incomplete private KR source vintage approval");
  const predecessor = { registry, receipt } as KrSourceVintagePrivateApprovalV1;
  await verifyKrSourceVintagePrivateApproval(predecessor);
  if (!nextRegistry && !nextReceipt) return predecessor;
  if (!nextRegistry || !nextReceipt)
    throw new Error("Incomplete private KR source vintage successor");
  const result = {
    registry: nextRegistry,
    receipt: nextReceipt,
    predecessor,
  } as KrSourceVintagePrivateApprovalV2;
  const verified = await verifyKrSourceVintagePrivateApproval(result);
  // Authority activation is explicit, never the position of a review in an aggregate list.
  return publicationDate && publicationDate < verified.activationDate ? predecessor : result;
}
