import { supabase } from "./cloud";
import {
  portfolioPositionContextServer,
  type DomesticPositionContext,
} from "./portfolioLedgers.functions";

export type { DomesticPositionContext };

export async function loadDomesticPositionContext(): Promise<DomesticPositionContext> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("먼저 로그인해 주세요.");
  return portfolioPositionContextServer({
    data: { accessToken: data.session.access_token },
  });
}

export function isOnsetSuppressed(
  context: DomesticPositionContext | null | undefined,
  symbol: string,
  signalDate: string,
): boolean {
  if (!context) return false;
  if (context.heldSymbols.includes(symbol)) return true;
  const lastSellDate = context.lastSellDateBySymbol[symbol];
  return Boolean(lastSellDate && lastSellDate >= signalDate);
}
