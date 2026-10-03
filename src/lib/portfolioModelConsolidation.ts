const EXPECTED_KINDS = [
  "KR_MIXED",
  "KR_KOSPI",
  "KR_KOSDAQ",
  "US_A0",
  "ETF_V02",
  "US_A2",
  "US_B3",
  "KR_KOSPI_CONFIRM1_BEAR",
] as const;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const nonnegativeMoney = (value: unknown) =>
  (typeof value === "string" || typeof value === "number") &&
  String(value).trim() !== "" &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0;

/** Hide the legacy comparison cards only after a current authenticated read proves replacement coverage. */
export function isPortfolioModelComparisonReady(value: unknown): boolean {
  const summary = object(value);
  if (
    summary?.["viewVersion"] !== "october-shadow-holdings-tax-v1" ||
    summary["readyForPortfolioConsolidation"] !== true ||
    !Array.isArray(summary["books"]) ||
    summary["books"].length !== EXPECTED_KINDS.length
  )
    return false;
  const books = summary["books"].map(object);
  if (books.some((book) => !book)) return false;
  const ids = books.map((book) => book!["bookId"]);
  if (
    ids.some((id) => typeof id !== "string" || !id) ||
    new Set(ids).size !== EXPECTED_KINDS.length
  )
    return false;
  return EXPECTED_KINDS.every((kind) => {
    const matching = books.filter((book) => book!["kind"] === kind);
    if (matching.length !== 1) return false;
    const book = matching[0]!;
    const us = kind.startsWith("US_");
    if (
      book["currency"] !== (us ? "USD" : "KRW") ||
      !["INITIALIZED_WAITING", "RECORDED"].includes(String(book["status"])) ||
      !nonnegativeMoney(book["initialCapital"]) ||
      Number(book["initialCapital"]) === 0 ||
      !nonnegativeMoney(book["cash"]) ||
      !Array.isArray(book["holdings"]) ||
      !Number.isInteger(book["positions"]) ||
      book["positions"] !== book["holdings"].length
    )
      return false;
    // Initial cash is deliberately not a fabricated observed-session NAV/return.
    if (
      book["status"] === "RECORDED" &&
      (!nonnegativeMoney(book["nav"]) ||
        typeof book["returnPercent"] !== "number" ||
        !Number.isFinite(book["returnPercent"]))
    )
      return false;
    const tax = object(book["tax"]);
    return !us || (!!tax && ["ESTIMATE", "PARTIAL", "UNAVAILABLE"].includes(String(tax["status"])));
  });
}
