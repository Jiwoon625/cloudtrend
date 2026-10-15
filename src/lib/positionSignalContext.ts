export interface DomesticPositionContext {
  priceExits?: Record<
    string,
    { reason: string | null; signalDate: string | null; threshold: string | null; status: string }
  >;
  heldSymbols: string[];
  lastSellDateBySymbol: Record<string, string>;
}

export function entrySuppressionReason(
  context: DomesticPositionContext | null | undefined,
  symbol: string,
  signalDate: string,
): "held" | "sold" | null {
  if (!context) return null;
  if (context.heldSymbols.includes(symbol)) return "held";
  const lastSellDate = context.lastSellDateBySymbol[symbol];
  return lastSellDate && lastSellDate >= signalDate ? "sold" : null;
}

export function isOnsetSuppressed(
  context: DomesticPositionContext | null | undefined,
  symbol: string,
  signalDate: string,
): boolean {
  return entrySuppressionReason(context, symbol, signalDate) !== null;
}
