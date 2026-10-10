import rawSummaries from "./operatingBacktestSummaries.json";

export interface PortfolioAnnualReturns {
  status: "pending" | "verified";
  definition: "FULL_CALENDAR_YEAR_NAV_RETURN_V1";
  weighting: "EQUAL_YEAR";
  partialYearsExcluded: boolean;
  years: readonly { year: number; netReturn: number }[];
  meanReturn: number | null;
  medianReturn: number | null;
}

export interface BenchmarkComparison {
  status: "pending" | "verified";
  definition: "FULL_PERIOD_CUMULATIVE_RETURN_DIFFERENCE_V1";
  label: string;
  currency: "KRW" | "USD";
  startDate: string;
  endDate: string;
  portfolioCumulativeReturn: number;
  benchmarkCumulativeReturn: number;
  excessReturn: number;
  limitation: string;
}

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
  portfolioAnnualReturns: PortfolioAnnualReturns | null;
  benchmarkComparison: BenchmarkComparison | null;
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
// Coverage is pinned to this independently audited release. US starts on the
// first 2016 session; the Korean books start partway through 2017. All end in 2026.
const COMPLETE_CALENDAR_YEARS: Readonly<Record<string, readonly [number, number]>> = {
  KOSPI_STANDALONE_DIAGNOSTIC: [2018, 2025],
  KOSDAQ_STANDALONE_DIAGNOSTIC: [2018, 2025],
  US_A0: [2016, 2025],
  ETF_V02: [2018, 2025],
  KR_COMBINED_ADOPTED: [2018, 2025],
};
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

export function isPortfolioAnnualReturnsReady(
  summary: PortfolioAnnualReturns | null,
  book: string,
): boolean {
  const coverage = COMPLETE_CALENDAR_YEARS[book];
  if (
    !summary ||
    !coverage ||
    summary.status !== "verified" ||
    summary.definition !== "FULL_CALENDAR_YEAR_NAV_RETURN_V1" ||
    summary.weighting !== "EQUAL_YEAR" ||
    summary.partialYearsExcluded !== true ||
    !Array.isArray(summary.years) ||
    summary.years.length === 0 ||
    !isFiniteRatio(summary.meanReturn) ||
    !isFiniteRatio(summary.medianReturn)
  )
    return false;
  const { years } = summary;
  if (
    years.length !== coverage[1] - coverage[0] + 1 ||
    years[0]?.year !== coverage[0] ||
    years.at(-1)?.year !== coverage[1]
  )
    return false;
  if (
    years.some(
      (row, index) =>
        !Number.isInteger(row.year) ||
        row.year < 1900 ||
        !isFiniteRatio(row.netReturn) ||
        row.netReturn < -1 ||
        (index > 0 && row.year !== years[index - 1]!.year + 1),
    )
  )
    return false;
  const sorted = years.map((row) => row.netReturn).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  return (
    Math.abs(mean - summary.meanReturn) < 1e-12 && Math.abs(median - summary.medianReturn) < 1e-12
  );
}

export function isBenchmarkComparisonReady(summary: OperatingBacktestSummary): boolean {
  const comparison = summary.benchmarkComparison;
  return (
    comparison != null &&
    comparison.status === "verified" &&
    comparison.definition === "FULL_PERIOD_CUMULATIVE_RETURN_DIFFERENCE_V1" &&
    typeof comparison.label === "string" &&
    comparison.label.trim().length > 0 &&
    typeof comparison.limitation === "string" &&
    comparison.limitation.trim().length > 0 &&
    comparison.currency === summary.currency &&
    comparison.startDate === summary.startDate &&
    comparison.endDate === summary.endDate &&
    isFiniteRatio(comparison.portfolioCumulativeReturn) &&
    comparison.portfolioCumulativeReturn >= -1 &&
    isFiniteRatio(comparison.benchmarkCumulativeReturn) &&
    comparison.benchmarkCumulativeReturn >= -1 &&
    isFiniteRatio(comparison.excessReturn) &&
    Math.abs(
      comparison.portfolioCumulativeReturn -
        comparison.benchmarkCumulativeReturn -
        comparison.excessReturn,
    ) < 1e-12
  );
}

export function formatBacktestPercentagePoints(value: number): string {
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%p`;
}
