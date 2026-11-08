import type referenceData from "./engine/verifiedKrIndexMembership.generated.json";
import { SCREENING_CACHE_VERSION } from "./screeningCacheContract";

export const PREVIOUS_KR_INDEX_CACHE_VERSION = "screening-cache-v9-current-price-20261104-v1";
export const KR_INDEX_COMPATIBLE_TARGET =
  "screening-cache-v9-current-price-verified-kr-index-20261106-v1";

/** Lazy, read-only proof: never load the full reference on the normal cache path. */
export async function verifiedKrIndexCacheCompatibility() {
  if (SCREENING_CACHE_VERSION !== KR_INDEX_COMPATIBLE_TARGET) return false;
  const { default: reference } = await import("./engine/verifiedKrIndexMembership.generated.json");
  return sameVerifiedKrIndexConstituents(reference);
}

export function sameVerifiedKrIndexConstituents(reference: typeof referenceData) {
  if (reference.snapshots.map((s) => s.asOfDate).join() !== "2026-10-08,2026-10-30,2026-11-06")
    return false;
  const previous = reference.snapshots[1]!;
  const latest = reference.snapshots[2]!;
  return (
    JSON.stringify(previous.indexes.map((i) => [i.indexCode, i.count, i.constituents])) ===
    JSON.stringify(latest.indexes.map((i) => [i.indexCode, i.count, i.constituents]))
  );
}
