import type { ReactNode } from "react";
import { AppShell } from "./AppShell";
import { OperatingCapitalPlan } from "./OperatingCapitalPlan";
import { NewActualPortfolio } from "./NewActualPortfolio";

export type PortfolioAsset = "KR" | "US" | "ETF";

/** Keep the route contract while intentionally excluding every legacy ledger view. */
export function PortfolioAssetHub({
  selectedAsset,
  onAssetChange,
}: {
  domestic: ReactNode;
  selectedAsset?: PortfolioAsset;
  onAssetChange?: (asset: PortfolioAsset) => void;
}) {
  return (
    <AppShell loadAnalysis={false}>
      <NewActualPortfolio selectedAsset={selectedAsset} onAssetChange={onAssetChange}>
        <OperatingCapitalPlan editable />
      </NewActualPortfolio>
    </AppShell>
  );
}
