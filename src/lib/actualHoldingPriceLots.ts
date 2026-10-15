import { decimal, divide, format, fromLegacyNumber } from "./ledger/decimal";
import type { NewActualPosition, NewActualTrade } from "./newActualPortfolio";

/**
 * Reconstruct open acquisition lots without changing the canonical new-actual
 * accounting. Every partial sale consumes the SAME proportional aggregate cost
 * as projectNewActualPool. The last lot receives rounding residuals (8dp).
 * Lots are analysis evidence, not separately executable brokerage orders.
 */
export interface ActualPriceLot {
  id: string;
  entryDate: string;
  entryPrice: string;
  quantity: string;
  costBasis: string;
}
export interface ActualPriceCycle {
  cycle: { id: string; date: string; gross: number; quantity: number; fee: number };
  lots: ActualPriceLot[];
}
interface MutableLot {
  id: string;
  entryDate: string;
  entryPrice: string;
  quantity: bigint;
  cost: bigint;
}
export function reconstructActualPriceCycle(
  position: Pick<NewActualPosition, "symbol" | "market" | "quantity" | "cost">,
  trades: NewActualTrade[],
): ActualPriceCycle {
  const rows = trades
    .filter((t) => t.execution.symbol === position.symbol && t.execution.market === position.market)
    .sort(
      (a, b) =>
        a.execution.date.localeCompare(b.execution.date) ||
        a.execution.order - b.execution.order ||
        a.execution.id.localeCompare(b.execution.id),
    );
  const ids = new Set<string>();
  let lots: MutableLot[] = [];
  let cycle: ActualPriceCycle["cycle"] | null = null;
  for (const t of rows) {
    if (ids.has(t.execution.id)) throw new Error("Duplicate actual fill");
    ids.add(t.execution.id);
    const qty = decimal(fromLegacyNumber(t.allocation.quantity));
    const gross = decimal(fromLegacyNumber(t.allocation.gross));
    const fee = decimal(fromLegacyNumber(t.allocation.fee));
    if (qty <= 0n || gross <= 0n || fee < 0n) throw new Error("Invalid actual fill allocation");
    if (t.execution.side === "BUY") {
      if (lots.length === 0) {
        cycle = {
          id: t.execution.id,
          date: t.execution.date,
          gross: t.allocation.gross,
          quantity: t.allocation.quantity,
          fee: t.allocation.fee,
        };
      }
      lots.push({
        id: t.execution.id,
        entryDate: t.execution.date,
        entryPrice: format(divide(gross, qty)),
        quantity: qty,
        cost: gross + fee,
      });
      continue;
    }
    if (t.execution.side !== "SELL") throw new Error("Unknown fill side");
    const totalQty = lots.reduce((sum, lot) => sum + lot.quantity, 0n);
    if (qty > totalQty || totalQty === 0n) throw new Error("Sale exceeds new-actual holdings");
    const totalCost = lots.reduce((sum, lot) => sum + lot.cost, 0n);
    const allocatedCost = qty === totalQty ? totalCost : (totalCost * qty) / totalQty;
    let usedQuantity = 0n;
    let usedCost = 0n;
    lots = lots
      .map((lot, index, all) => {
        const last = index === all.length - 1;
        const soldQty = last ? qty - usedQuantity : (lot.quantity * qty) / totalQty;
        const soldCost = last ? allocatedCost - usedCost : (lot.cost * qty) / totalQty;
        if (soldQty < 0n || soldQty > lot.quantity || soldCost < 0n || soldCost > lot.cost)
          throw new Error("Actual lot proportional allocation mismatch");
        usedQuantity += soldQty;
        usedCost += soldCost;
        return { ...lot, quantity: lot.quantity - soldQty, cost: lot.cost - soldCost };
      })
      .filter((lot) => lot.quantity > 0n);
    if (qty === totalQty) cycle = null;
  }
  if (!cycle || lots.length === 0) throw new Error("Actual holding cycle missing");
  const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0n);
  const cost = lots.reduce((sum, lot) => sum + lot.cost, 0n);
  if (quantity !== decimal(position.quantity) || cost !== decimal(position.cost))
    throw new Error("Actual holding/lot quantity or cost differs from canonical pool");
  return {
    cycle,
    lots: lots.map((lot) => ({
      id: lot.id,
      entryDate: lot.entryDate,
      entryPrice: lot.entryPrice,
      quantity: format(lot.quantity),
      costBasis: format(lot.cost),
    })),
  };
}

/** Dated cost/quantity snapshots prevent a later BUY from changing a prior close's K4 line. */
export function actualPooledBasisByDate(
  position: Pick<NewActualPosition, "symbol" | "market" | "quantity" | "cost">,
  trades: NewActualTrade[],
): Array<{ date: string; quantity: string; costBasis: string }> {
  const cycle = reconstructActualPriceCycle(position, trades);
  const sorted = trades
    .filter((t) => t.execution.symbol === position.symbol && t.execution.market === position.market)
    .sort(
      (a, b) =>
        a.execution.date.localeCompare(b.execution.date) ||
        a.execution.order - b.execution.order ||
        a.execution.id.localeCompare(b.execution.id),
    );
  const start = sorted.findIndex((t) => t.execution.id === cycle.cycle.id);
  if (start < 0) throw new Error("Actual cost timeline cycle start missing");
  const snapshots: Array<{ date: string; quantity: string; costBasis: string }> = [];
  let quantity = 0n;
  let cost = 0n;
  for (const t of sorted.slice(start)) {
    const q = decimal(fromLegacyNumber(t.allocation.quantity));
    const gross = decimal(fromLegacyNumber(t.allocation.gross));
    const fee = decimal(fromLegacyNumber(t.allocation.fee));
    if (q <= 0n || gross <= 0n || fee < 0n) throw new Error("Invalid cost timeline fill");
    if (t.execution.side === "BUY") {
      quantity += q;
      cost += gross + fee;
    } else if (t.execution.side === "SELL") {
      if (q > quantity) throw new Error("Cost timeline sale exceeds holdings");
      cost -= q === quantity ? cost : (cost * q) / quantity;
      quantity -= q;
    } else throw new Error("Unknown cost timeline side");
    if (quantity <= 0n || cost <= 0n)
      throw new Error("Unclosed actual holding cycle cannot be empty");
    const row = {
      date: t.execution.date,
      quantity: format(quantity),
      costBasis: format(cost),
    };
    if (snapshots.at(-1)?.date === row.date) snapshots[snapshots.length - 1] = row;
    else snapshots.push(row);
  }
  if (quantity !== decimal(position.quantity) || cost !== decimal(position.cost))
    throw new Error("Historical basis timeline disagrees with actual ledger");
  return snapshots;
}
