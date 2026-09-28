import { supabase, userId } from "./cloud";
import { createPortfolioStore } from "./portfolioStoreCore";
import { portfolioServer } from "./portfolio.functions";
import type { PortfolioState } from "./portfolioStoreCore";
export type {
  PortfolioSettings,
  PortfolioTradeStatus,
  PortfolioTrade,
  PortfolioSummary,
  PortfolioState,
} from "./portfolioStoreCore";

// Pure strategy helpers and capital editing do not load market data.
const store = createPortfolioStore({
  supabase,
  userId,
  ensureManualDataset: async () => {
    throw new Error("원본 계산은 서버에서만 실행합니다.");
  },
  loadSnapshots: () => [],
});
export const isEntryOnset = store.isEntryOnset;
export const deriveExitPlan = store.deriveExitPlan;
export const savePortfolioCapital = store.savePortfolioCapital;
async function requestPortfolio(sync: boolean): Promise<PortfolioState> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("먼저 로그인해 주세요.");
  return portfolioServer({ data: { accessToken: data.session.access_token, sync } });
}
export const loadPortfolioState = () => requestPortfolio(false);
let inFlight: Promise<PortfolioState> | null = null;
export function syncPortfolioFromHistory() {
  if (!inFlight)
    inFlight = requestPortfolio(true).finally(() => {
      inFlight = null;
    });
  return inFlight;
}
