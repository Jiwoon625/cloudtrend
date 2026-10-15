import admissions from "./integratedAllocationRuntimeAdmissions.json";
import type { SeriesHash } from "./ledger/modelSeries";

/** Economic contract identity, not a claim that a newer executable has these bytes. */
export const INTEGRATED_ALLOCATION_FROZEN_CODE_HASH =
  "sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4" as const;
export interface IntegratedRuntimeAdmission {
  runtimeCodeHash: SeriesHash;
  frozenCodeHash: typeof INTEGRATED_ALLOCATION_FROZEN_CODE_HASH;
  reviewId: string;
}
export interface IntegratedRuntimeAdmissions {
  version: string;
  admissions: Array<{ runtimeCodeHash: string; frozenCodeHash: string; reviewId: string }>;
}

/** The validator is hashed executable code. Only this declarative review list is outside its own digest. */
export function reviewedIntegratedRuntime(
  runtimeCodeHash: string,
  frozenCodeHash: string,
  reviews: IntegratedRuntimeAdmissions = admissions,
): Readonly<IntegratedRuntimeAdmission> {
  if (
    reviews.version !== "integrated-allocation-runtime-admissions-v1" ||
    !/^sha256:[a-f\d]{64}$/.test(runtimeCodeHash) ||
    frozenCodeHash !== INTEGRATED_ALLOCATION_FROZEN_CODE_HASH ||
    !Array.isArray(reviews.admissions)
  )
    throw new Error("Invalid integrated allocation runtime admission contract");
  const seen = new Set<string>();
  for (const review of reviews.admissions) {
    if (
      !/^sha256:[a-f\d]{64}$/.test(review.runtimeCodeHash) ||
      review.frozenCodeHash !== INTEGRATED_ALLOCATION_FROZEN_CODE_HASH ||
      !/^[a-z0-9][a-z0-9._-]{7,127}$/.test(review.reviewId) ||
      seen.has(review.runtimeCodeHash)
    )
      throw new Error("Invalid or ambiguous integrated allocation runtime review");
    seen.add(review.runtimeCodeHash);
  }
  const review = reviews.admissions.find((entry) => entry.runtimeCodeHash === runtimeCodeHash);
  if (!review) throw new Error("Unreviewed integrated allocation executable runtime");
  return Object.freeze({ ...review }) as Readonly<IntegratedRuntimeAdmission>;
}
