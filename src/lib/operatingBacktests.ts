import rawSummaries from "./operatingBacktestSummaries.json";

/** Ratios, not percent values. The calculation basis must be explicit before publication. */
export interface OperatingBacktestSummary {
  book: string;
  markets: readonly string[];
  scopeLabel: string;
  status: "pending" | "verified";
  currency: "KRW" | "USD";
  startDate: string | null;
  endDate: string | null;
  policyVersion: string | null;
  policyLabel: string;
  returnBasis: "closed_trade";
  returnDefinitionId: "CLOSED_ROUND_TRIP_NET_RETURN_V1" | null;
  proxyClosedTradeCount: number | null;
  excludedOpenPositionCount: number | null;
  closedTradeCount: number | null;
  returnDefinition: string | null;
  meanReturn: number | null;
  medianReturn: number | null;
  mdd: number | null;
  cagr: number | null;
  limitations: readonly string[];
}

export interface OperatingBacktestRelease {
  schemaVersion: string;
  policyFamily: string;
  books: readonly OperatingBacktestSummary[];
}

// This allowlisted public summary contains no account balances, owner IDs or source paths.
export const OPERATING_BACKTESTS: OperatingBacktestRelease =
  rawSummaries as OperatingBacktestRelease;

const REQUIRED_BOOKS = [
  "KOSPI_STANDALONE_DIAGNOSTIC",
  "KOSDAQ_STANDALONE_DIAGNOSTIC",
  "US_A0",
  "ETF_V02",
  "KR_COMBINED_ADOPTED",
] as const;
const isFiniteRatio = (value: number | null): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Never publish an isolated market or confuse CAGR with arithmetic mean return. */
export function isOperatingBacktestReleaseReady(release: OperatingBacktestRelease): boolean {
  const books = REQUIRED_BOOKS.map((book) => release.books.find((row) => row.book === book));
  return books.every(
    (row) =>
      row !== undefined &&
      row.status === "verified" &&
      row.returnBasis === "closed_trade" &&
      row.returnDefinitionId === "CLOSED_ROUND_TRIP_NET_RETURN_V1" &&
      row.returnBasis === books[0]?.returnBasis &&
      Boolean(row.returnDefinition && row.startDate && row.endDate && row.policyVersion) &&
      row.closedTradeCount !== null &&
      Number.isInteger(row.closedTradeCount) &&
      row.closedTradeCount > 0 &&
      row.proxyClosedTradeCount !== null &&
      Number.isInteger(row.proxyClosedTradeCount) &&
      row.proxyClosedTradeCount >= 0 &&
      row.proxyClosedTradeCount <= row.closedTradeCount &&
      row.excludedOpenPositionCount !== null &&
      Number.isInteger(row.excludedOpenPositionCount) &&
      row.excludedOpenPositionCount >= 0 &&
      isFiniteRatio(row.meanReturn) &&
      isFiniteRatio(row.medianReturn) &&
      isFiniteRatio(row.mdd) &&
      row.mdd >= -1 &&
      row.mdd <= 0,
  );
}

export function formatBacktestRatio(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
