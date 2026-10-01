import type { ScreeningRow } from "@/lib/engine/pipeline";
import {
  getHeldOperationalExitSignal,
  getOperationalStatus,
  isOperationalEntry,
} from "@/lib/engine/operationalStrategy";
import { isKospiRelativeMomentumConfirmed } from "@/lib/kospiRelativeQuality";
import { isOnsetSuppressed, type DomesticPositionContext } from "@/lib/positionSignalContext";

/** Status is a signal, not evidence of an actual holding. Portfolio tracks holdings. */
export function getDisplayStatus(row: ScreeningRow): string {
  if (row.instrument.instrumentType === "STOCK") {
    const status = getOperationalStatus(row, row.instrument.market);
    if (status === "관찰" && row.instrument.market === "KOSDAQ") {
      if (row.grade === "A") return "관심 후보";
      if (row.grade === "B") return "관찰 후보";
    }
    return row.kospi80Onset && isKospiRelativeMomentumConfirmed(row)
      ? `${status} · RS 확인`
      : status;
  }
  return row.actionLabelText || "관찰";
}


function heldExitStatus(row: ScreeningRow): string | null {
  const exit = getHeldOperationalExitSignal(
    row.instrument.market,
    row.operatingScore10,
    row.scoreDelta1d,
  );
  if (exit === "UP95") return "청산 대기 · KOSPI 9.5점 상향돌파";
  if (exit === "UP90") return "청산 대기 · KOSDAQ 9.0점 상향 재돌파";
  if (exit === "DOWN30") return "청산 대기 · KOSDAQ 3.0점 하향 이탈";
  return null;
}

export function isPortfolioAwareOperationalEntry(
  row: ScreeningRow,
  context: DomesticPositionContext | null | undefined,
  signalDate: string,
): boolean {
  return isOperationalEntry(row) && !isOnsetSuppressed(context, row.instrument.symbol, signalDate);
}

/** Reconcile user-facing status with the canonical actual ledger without mutating raw screening history. */
export function getPortfolioAwareDisplayStatus(
  row: ScreeningRow,
  context: DomesticPositionContext | null | undefined,
  signalDate: string,
): string {
  if (row.instrument.instrumentType !== "STOCK" || !context) return getDisplayStatus(row);
  const symbol = row.instrument.symbol;
  if (context.heldSymbols.includes(symbol)) return heldExitStatus(row) ?? "보유";
  if (isOnsetSuppressed(context, symbol, signalDate) && isOperationalEntry(row))
    return "당일 매도 · 재진입 제외";
  return getDisplayStatus(row);
}
