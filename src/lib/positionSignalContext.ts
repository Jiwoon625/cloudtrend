export interface DomesticPositionContext {
  heldSymbols: string[];
  lastSellDateBySymbol: Record<string, string>;
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
