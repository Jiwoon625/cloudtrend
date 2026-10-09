/** Opt-in journal representation for adjusted comparison prices; never changes source/feature/NAV observations. */
import { decimal, representedLegacyNumber } from "../ledger/decimal";

export const US_RESEARCH_TRADE_PRICE_POLICY_ID = "US_A0_COMPARISON_PRICE_8DP_LEDGER_V1" as const;
export interface UsResearchTradePricePolicy {
  policyId: typeof US_RESEARCH_TRADE_PRICE_POLICY_ID;
}

export function validateUsResearchTradePricePolicy(policy: UsResearchTradePricePolicy): void {
  if (policy.policyId !== US_RESEARCH_TRADE_PRICE_POLICY_ID)
    throw new Error("Invalid research trade-price representation policy");
}

export function representedUsResearchTradePrice(sourcePrice: number): string {
  const represented = representedLegacyNumber(sourcePrice);
  if (!Number.isFinite(sourcePrice) || sourcePrice <= 0 || decimal(represented) <= 0n)
    throw new Error("Positive source price cannot be represented as zero in the research ledger");
  return represented;
}

export function usResearchTradePriceAudit(
  sourcePrice: number,
  accountedPrice: number,
): Record<string, unknown> {
  return {
    price_representation_policy: US_RESEARCH_TRADE_PRICE_POLICY_ID,
    source_price: sourcePrice,
    accounted_price: accountedPrice,
    price_representation_delta: accountedPrice - sourcePrice,
    source_and_valuation_prices_unchanged: true,
  };
}
