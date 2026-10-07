import type { DualPortfolioState } from "./portfolioLedgers";

export type LedgerRefreshSummary = {
  status: "UPDATED" | "REUSED" | "FAILED";
  asOfDate: string | null;
  calculatedAt: string | null;
};
export type PortfolioLedgerViewState = DualPortfolioState & {
  strategyRefresh?: LedgerRefreshSummary;
};
