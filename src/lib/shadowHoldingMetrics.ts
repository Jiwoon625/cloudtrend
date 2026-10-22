import { decimal, divide, format, multiply } from "./ledger/decimal";

export interface ShadowMetricFill {
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  gross?: string | undefined;
  fee?: string | undefined;
}
/** Display-only average-cost ledger; entry fees included, unexecuted orders excluded by caller. */
export function shadowHoldingMetrics(
  fills: ShadowMetricFill[],
  holding: { symbol: string; quantity: string; price: string | null },
) {
  const unknown = { entryPrice: null, unrealizedPnl: null, realizedPnl: null };
  try {
    let quantity = 0n,
      grossBasis = 0n,
      basis = 0n,
      realized = 0n;
    for (const fill of fills) {
      if (fill.symbol !== holding.symbol) continue;
      if (fill.fee === undefined) return unknown;
      const count = decimal(fill.quantity),
        price = decimal(fill.price),
        fee = decimal(fill.fee ?? "0");
      const gross = fill.gross === undefined ? multiply(count, price) : decimal(fill.gross);
      if (count <= 0n || price <= 0n || fee < 0n || gross <= 0n) return unknown;
      if (fill.side === "BUY" || fill.side === "REBALANCE_BUY") {
        quantity += count;
        grossBasis += gross;
        basis += gross + fee;
      } else if (fill.side === "SELL" || fill.side === "REBALANCE_SELL") {
        if (count > quantity) return unknown;
        const soldBasis = count === quantity ? basis : (basis * count) / quantity;
        const soldGross = count === quantity ? grossBasis : (grossBasis * count) / quantity;
        realized += gross - fee - soldBasis;
        quantity -= count;
        basis -= soldBasis;
        grossBasis -= soldGross;
      } else return unknown;
    }
    if (quantity <= 0n || quantity !== decimal(holding.quantity)) return unknown;
    const mark = holding.price === null ? null : decimal(holding.price);
    return {
      entryPrice: format(divide(grossBasis, quantity)),
      unrealizedPnl: mark !== null && mark > 0n ? format(multiply(quantity, mark) - basis) : null,
      realizedPnl: format(realized),
    };
  } catch {
    return unknown;
  }
}
