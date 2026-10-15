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
export interface KrSourceVintagePrivateApproval {
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
export async function verifyKrSourceVintagePrivateApproval(value: KrSourceVintagePrivateApproval) {
  const { registry, receipt } = value;
  const keys = (object: object, expected: string[]) =>
    canonicalSeriesJson(Object.keys(object).sort()) === canonicalSeriesJson(expected.sort());
  if (
    !registry ||
    !receipt ||
    !keys(registry, ["version", "reviewId", "status", "receiptHash", "policy"]) ||
    !keys(receipt, ["version", "reviewId", "reviews"]) ||
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
  for (const review of receipt.reviews) {
    if (
      !keys(review, [
        "id",
        "symbol",
        "date",
        "notBefore",
        "archivedHash",
        "incomingHash",
        "evidenceUrl",
      ]) ||
      review.id !== registry.reviewId ||
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
  if (
    new Set(receipt.reviews.map((r) => r.symbol)).size !== 1 ||
    new Set(receipt.reviews.map((r) => r.notBefore)).size !== 1
  )
    throw new Error("Private KR source vintage scope changed");
  return {
    registryHash: await hashSeriesValue(registry),
    receiptHash: registry.receiptHash,
    reviews: receipt.reviews,
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
