import admissions from "./kospiShadowRuntimeAdmissions.json";

export interface KospiShadowRuntimeAdmissions {
  version: string;
  admissions: Array<{ runtimeCodeHash: string; reviewId: string }>;
}
/** Only the declarative exact-hash review list is excluded from its own digest. */
export function reviewedKospiShadowRuntime(
  runtimeCodeHash: string,
  reviews: KospiShadowRuntimeAdmissions = admissions,
): Readonly<{ runtimeCodeHash: string; reviewId: string }> {
  if (
    !reviews ||
    reviews.version !== "kospi-shadow-publication-runtime-admissions-v1" ||
    !/^sha256:[a-f0-9]{64}$/.test(runtimeCodeHash) ||
    !Array.isArray(reviews.admissions)
  )
    throw new Error("Invalid KOSPI Shadow publication runtime admission contract");
  const seen = new Set<string>();
  for (const review of reviews.admissions) {
    if (
      !review ||
      !/^sha256:[a-f0-9]{64}$/.test(review.runtimeCodeHash) ||
      !/^[a-z0-9][a-z0-9._-]{7,127}$/.test(review.reviewId) ||
      seen.has(review.runtimeCodeHash)
    )
      throw new Error("Invalid or ambiguous KOSPI Shadow publication runtime review");
    seen.add(review.runtimeCodeHash);
  }
  const review = reviews.admissions.find((entry) => entry.runtimeCodeHash === runtimeCodeHash);
  if (!review) throw new Error("Unreviewed KOSPI Shadow publication executable runtime");
  return Object.freeze({ ...review });
}
