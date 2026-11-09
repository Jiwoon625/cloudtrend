import type { CanonicalSourceRow } from "../src/lib/sourceData";

/**
 * A v7 verified index part (KOSPI/KOSDAQ) carries prices and flow only. Index rows are never
 * STOCK/ETF capitalization targets, so such a part must not be asked for an official market cap.
 */
export function isIndexOnlyDatePart(
  rows: readonly CanonicalSourceRow[],
  asOfDate: string,
): boolean {
  const dated = rows.filter((row) => row.date === asOfDate);
  return dated.length > 0 && dated.every((row) => row.type === "INDEX");
}
