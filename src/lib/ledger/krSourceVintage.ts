import type { DailyPrice } from "../engine/types";
import type { StrategyLedger } from "../portfolioLedgers";
import { canonicalSeriesJson, hashSeriesValue, type SeriesHash } from "./modelSeries";
import { krExecutionBar } from "./octoberShadowArchive";
import { validDate } from "./date";

export interface KrSourceVintageReview {
  id: string;
  symbol: string;
  date: string;
  notBefore: string;
  archivedHash: SeriesHash;
  incomingHash: SeriesHash;
  evidenceUrl: string;
}

export interface KrSourceVintageReceipt extends KrSourceVintageReview {
  policy: "KEEP_FROZEN_EXECUTION_PREFIX_NO_ECONOMIC_EXPOSURE_V1";
  fields: string[];
}

/** Only an independently approved private receipt may supply reviewed observations. */
export const KR_SOURCE_VINTAGE_REVIEW_ID = "reviewed-kr-vintage-v1" as const;
export const KR_SOURCE_VINTAGE_POLICY =
  "KEEP_FROZEN_EXECUTION_PREFIX_NO_ECONOMIC_EXPOSURE_V1" as const;
export const KR_SOURCE_VINTAGE_SUCCESSOR_REVIEW_ID = "reviewed-kr-vintage-v2" as const;
export interface KrSourceVintagePrivateApprovalV1 {
  registry: {
    version: "kr-source-vintage-approval-v1";
    reviewId: typeof KR_SOURCE_VINTAGE_REVIEW_ID;
    status: "APPROVED";
    receiptHash: SeriesHash;
    policy: typeof KR_SOURCE_VINTAGE_POLICY;
  };
  receipt: {
    version: "kr-source-vintage-review-v1";
    reviewId: typeof KR_SOURCE_VINTAGE_REVIEW_ID;
    reviews: KrSourceVintageReview[];
  };
}
/** One independently approved cohort extends, but never replaces, the immutable v1 authority. */
export interface KrSourceVintagePrivateApprovalV2 {
  registry: {
    version: "kr-source-vintage-approval-v2";
    reviewId: typeof KR_SOURCE_VINTAGE_SUCCESSOR_REVIEW_ID;
    status: "APPROVED";
    receiptHash: SeriesHash;
    parentRegistryHash: SeriesHash;
    policy: typeof KR_SOURCE_VINTAGE_POLICY;
  };
  receipt: {
    version: "kr-source-vintage-review-v2";
    reviewId: typeof KR_SOURCE_VINTAGE_SUCCESSOR_REVIEW_ID;
    parentReceiptHash: SeriesHash;
    reviews: KrSourceVintageReview[];
  };
  predecessor: KrSourceVintagePrivateApprovalV1;
}
export type KrSourceVintagePrivateApproval =
  KrSourceVintagePrivateApprovalV1 | KrSourceVintagePrivateApprovalV2;

const exactKeys = (object: unknown, expected: string[]) =>
  object !== null &&
  typeof object === "object" &&
  !Array.isArray(object) &&
  canonicalSeriesJson(Object.keys(object).sort()) === canonicalSeriesJson([...expected].sort());

function verifyReview(review: KrSourceVintageReview, id: string, seen: Set<string>) {
  if (
    !exactKeys(review, [
      "id",
      "symbol",
      "date",
      "notBefore",
      "archivedHash",
      "incomingHash",
      "evidenceUrl",
    ]) ||
    review.id !== id ||
    !/^[A-Z0-9._-]{1,20}$/.test(review.symbol) ||
    !validDate(review.date) ||
    !validDate(review.notBefore) ||
    review.date >= review.notBefore ||
    ![review.archivedHash, review.incomingHash].every((h) => /^sha256:[a-f0-9]{64}$/.test(h)) ||
    review.archivedHash === review.incomingHash ||
    !/^https:\/\/dart\.fss\.or\.kr\//.test(review.evidenceUrl) ||
    seen.has(`${review.symbol}:${review.date}`)
  )
    throw new Error("Invalid private KR source vintage review");
  seen.add(`${review.symbol}:${review.date}`);
}
function verifyCohort(reviews: readonly KrSourceVintageReview[]) {
  if (
    new Set(reviews.map((r) => r.symbol)).size !== 1 ||
    new Set(reviews.map((r) => r.notBefore)).size !== 1
  )
    throw new Error("Private KR source vintage scope changed");
}
async function verifyV1(value: KrSourceVintagePrivateApprovalV1) {
  const { registry, receipt } = value;
  if (
    !exactKeys(value, ["registry", "receipt"]) ||
    !exactKeys(registry, ["version", "reviewId", "status", "receiptHash", "policy"]) ||
    !exactKeys(receipt, ["version", "reviewId", "reviews"]) ||
    registry.version !== "kr-source-vintage-approval-v1" ||
    registry.reviewId !== KR_SOURCE_VINTAGE_REVIEW_ID ||
    registry.status !== "APPROVED" ||
    registry.policy !== KR_SOURCE_VINTAGE_POLICY ||
    receipt.version !== "kr-source-vintage-review-v1" ||
    receipt.reviewId !== registry.reviewId ||
    registry.receiptHash !== (await hashSeriesValue(receipt)) ||
    !Array.isArray(receipt.reviews) ||
    receipt.reviews.length !== 2
  )
    throw new Error("Unapproved private KR source vintage receipt");
  const seen = new Set<string>();
  for (const review of receipt.reviews) verifyReview(review, registry.reviewId, seen);
  verifyCohort(receipt.reviews);
  return {
    registryHash: await hashSeriesValue(registry),
    receiptHash: registry.receiptHash,
    reviews: receipt.reviews,
    activationDate: receipt.reviews[0]!.notBefore,
  };
}
export async function verifyKrSourceVintagePrivateApproval(value: KrSourceVintagePrivateApproval) {
  if (value?.registry?.version === "kr-source-vintage-approval-v1") {
    const verified = await verifyV1(value as KrSourceVintagePrivateApprovalV1);
    return { ...verified, authorizedRegistryHashes: [verified.registryHash] };
  }
  const successor = value as KrSourceVintagePrivateApprovalV2;
  const { registry, receipt, predecessor } = successor ?? {};
  if (
    !exactKeys(successor, ["registry", "receipt", "predecessor"]) ||
    !exactKeys(registry, [
      "version",
      "reviewId",
      "status",
      "receiptHash",
      "parentRegistryHash",
      "policy",
    ]) ||
    !exactKeys(receipt, ["version", "reviewId", "parentReceiptHash", "reviews"]) ||
    registry.version !== "kr-source-vintage-approval-v2" ||
    registry.reviewId !== KR_SOURCE_VINTAGE_SUCCESSOR_REVIEW_ID ||
    registry.status !== "APPROVED" ||
    registry.policy !== KR_SOURCE_VINTAGE_POLICY ||
    receipt.version !== "kr-source-vintage-review-v2" ||
    receipt.reviewId !== registry.reviewId ||
    registry.receiptHash !== (await hashSeriesValue(receipt)) ||
    !Array.isArray(receipt.reviews) ||
    receipt.reviews.length < 3 ||
    receipt.reviews.length > 258 ||
    !predecessor
  )
    throw new Error("Unapproved private KR source vintage successor");
  const parent = await verifyV1(predecessor);
  const retained = receipt.reviews.slice(0, parent.reviews.length);
  const additional = receipt.reviews.slice(parent.reviews.length);
  if (
    registry.parentRegistryHash !== parent.registryHash ||
    receipt.parentReceiptHash !== parent.receiptHash ||
    canonicalSeriesJson(retained) !== canonicalSeriesJson(parent.reviews)
  )
    throw new Error("Private KR source vintage predecessor changed or missing");
  const seen = new Set<string>();
  for (const review of retained) verifyReview(review, KR_SOURCE_VINTAGE_REVIEW_ID, seen);
  for (const review of additional) verifyReview(review, registry.reviewId, seen);
  verifyCohort(additional);
  if (
    additional[0]!.symbol === parent.reviews[0]!.symbol ||
    additional[0]!.notBefore <= parent.activationDate
  )
    throw new Error("Private KR source vintage successor scope changed");
  const registryHash = await hashSeriesValue(registry);
  return {
    registryHash,
    receiptHash: registry.receiptHash,
    reviews: receipt.reviews,
    activationDate: additional[0]!.notBefore,
    authorizedRegistryHashes: [parent.registryHash, registryHash],
  };
}

export function assertKrSourceVintageReceipt(
  receipt: KrSourceVintageReceipt,
  reviews: readonly KrSourceVintageReview[] = [],
) {
  const { policy, fields, ...review } = receipt;
  if (
    policy !== "KEEP_FROZEN_EXECUTION_PREFIX_NO_ECONOMIC_EXPOSURE_V1" ||
    !Array.isArray(fields) ||
    !fields.length ||
    new Set(fields).size !== fields.length ||
    reviews.filter((value) => canonicalSeriesJson(value) === canonicalSeriesJson(review)).length !==
      1
  )
    throw new Error("Unreviewed retained KR source vintage receipt");
}

/** Admit only a separately evidenced source vintage; never return replacement prices. */
export async function reconcileKrHistoricalSourceVintage(input: {
  symbol: string;
  archived: DailyPrice;
  incoming: DailyPrice;
  publicationDate: string;
  previousResult: StrategyLedger;
  previousReceipt?: KrSourceVintageReceipt | undefined;
  reviews?: readonly KrSourceVintageReview[];
}): Promise<KrSourceVintageReceipt | null> {
  const archived = krExecutionBar(input.archived);
  const incoming = krExecutionBar(input.incoming);
  if (!input.previousReceipt && canonicalSeriesJson(archived) === canonicalSeriesJson(incoming))
    return null;
  const fields = [...new Set([...Object.keys(archived), ...Object.keys(incoming)])]
    .filter((key) => archived[key as keyof DailyPrice] !== incoming[key as keyof DailyPrice])
    .sort();
  const fail = (detail: string): never => {
    throw new Error(`KR source revises archived historical OHLC; ${detail}`);
  };
  if (incoming.tradeDate !== archived.tradeDate || archived.tradeDate >= input.publicationDate)
    return fail("not a historical observation pair");
  const archivedHash = await hashSeriesValue(archived);
  const incomingHash = await hashSeriesValue(incoming);
  if (input.previousReceipt) {
    assertKrSourceVintageReceipt(input.previousReceipt, input.reviews);
    if (
      input.previousReceipt.symbol !== input.symbol ||
      input.previousReceipt.date !== archived.tradeDate ||
      input.previousReceipt.archivedHash !== archivedHash ||
      input.previousReceipt.incomingHash !== incomingHash
    )
      return fail("previously accepted analysis vintage reverted or changed again");
  }
  const matches = (input.reviews ?? []).filter(
    (review) =>
      review.symbol === input.symbol &&
      review.date === archived.tradeDate &&
      review.notBefore <= input.publicationDate &&
      review.archivedHash === archivedHash &&
      review.incomingHash === incomingHash,
  );
  if (matches.length !== 1) return fail("unreviewed or ambiguous source vintage");
  const review = matches[0]!;
  const priorVintageDate = (date: string | null | undefined) =>
    !date || !validDate(date) || date < review.notBefore;
  // A closed trade is also economic history. Reject every trade/candidate that
  // originated before the basis change, not merely current positions. Decisions
  // first created on/after the reviewed vintage must remain able to advance.
  if (
    input.previousResult.trades.some(
      (trade) =>
        trade.symbol === input.symbol &&
        (priorVintageDate(trade.signalDate) || priorVintageDate(trade.entryDate)),
    ) ||
    input.previousResult.candidates.some(
      (candidate) =>
        candidate.symbol === input.symbol &&
        (priorVintageDate(candidate.signalDate) ||
          priorVintageDate(candidate.originDate ?? candidate.signalDate)),
    )
  )
    return fail("economic exposure requires a separate corporate-action reconciliation");
  return {
    ...review,
    policy: "KEEP_FROZEN_EXECUTION_PREFIX_NO_ECONOMIC_EXPOSURE_V1",
    fields,
  };
}
