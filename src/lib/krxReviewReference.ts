import { validDate } from "./ledger/date";

/** Display-only observations. Never consumed by scoring, eligibility, sizing or ledgers. */
export type KrxReviewField =
  | "marketCap"
  | "listedShares"
  | "tradingValue"
  | "nav"
  | "aum"
  | "listedUnits"
  | "underlyingIndexName"
  | "underlyingIndexClose";
export interface KrxReviewObservation {
  date: string;
  source: "KRX_STOCK" | "KRX_ETF";
  values: Partial<Record<KrxReviewField, number | string | null>>;
}
export interface KrxReviewReference {
  /** Preview sidecar only; never official scoring/order/shadow evidence. */
  preliminary?: import("./krxPreliminary").KrxPreliminary;
  reviewDate: string;
  fields: Partial<
    Record<
      KrxReviewField,
      { date: string; value: number | string; source: KrxReviewObservation["source"] }
    >
  >;
}
const fields: KrxReviewField[] = [
  "marketCap",
  "listedShares",
  "tradingValue",
  "nav",
  "aum",
  "listedUnits",
  "underlyingIndexName",
  "underlyingIndexClose",
];

/** Select each latest usable dated fact; missing today never means zero or today's fact. */
export function selectKrxReviewReference(
  observations: readonly KrxReviewObservation[],
  reviewDate: string,
): KrxReviewReference {
  const result: KrxReviewReference = { reviewDate, fields: {} };
  if (!validDate(reviewDate)) return result;
  for (const observation of [...observations]
    .filter((o) => validDate(o.date) && o.date <= reviewDate)
    .sort((a, b) => a.date.localeCompare(b.date))) {
    for (const field of fields) {
      const value = observation.values[field];
      const usable =
        field === "underlyingIndexName"
          ? typeof value === "string" && value.trim().length > 0
          : typeof value === "number" &&
            Number.isFinite(value) &&
            (field === "tradingValue" ? value >= 0 : value > 0);
      if (usable)
        result.fields[field] = {
          date: observation.date,
          value: value!,
          source: observation.source,
        };
    }
  }
  return result;
}
