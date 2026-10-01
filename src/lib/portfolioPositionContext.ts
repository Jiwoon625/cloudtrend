import { supabase } from "./cloud";
import { portfolioLedgersServer, portfolioPositionContextServer } from "./portfolioLedgers.functions";
import type { DualPortfolioState } from "./portfolioLedgers";
import type { DomesticPositionContext } from "./positionSignalContext";

export type { DomesticPositionContext } from "./positionSignalContext";

export async function loadDomesticPositionContext(): Promise<DomesticPositionContext> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("먼저 로그인해 주세요.");
  return portfolioPositionContextServer({
    data: { accessToken: data.session.access_token },
  });
}


export async function loadDomesticPortfolioLedger(): Promise<DualPortfolioState> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("먼저 로그인해 주세요.");
  return portfolioLedgersServer({
    data: { accessToken: data.session.access_token, action: "load" },
  });
}
