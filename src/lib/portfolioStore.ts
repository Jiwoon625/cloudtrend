import { supabase, userId } from "@/lib/cloud";
import { ensureManualDataset } from "@/lib/manualDataStore";
import { loadSnapshots } from "@/lib/screeningHistory";
import { createPortfolioStore } from "@/lib/portfolioCore";
export type {
  PortfolioSettings,
  PortfolioTradeStatus,
  PortfolioTrade,
  PortfolioSummary,
  PortfolioState,
} from "@/lib/portfolioCore";
const store = createPortfolioStore({ supabase, userId, ensureManualDataset, loadSnapshots });
export const {
  isEntryOnset,
  deriveExitPlan,
  loadPortfolioState,
  savePortfolioCapital,
  syncPortfolioFromHistory,
} = store;
