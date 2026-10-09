import type { ScreeningRow } from "@/lib/engine/pipeline";
import {
  getHeldOperationalExitSignal,
  getOperationalStatus,
  getStoredOperationalExit,
  isOperationalEntry,
} from "@/lib/engine/operationalStrategy";
import { isOnsetSuppressed, type DomesticPositionContext } from "@/lib/positionSignalContext";

function pendingStatus(row: ScreeningRow): string | null {
  if (row.hardFilterStatus !== "PENDING") return null;
  return `판단 보류 · ${row.pendingRules?.join(" · ") || "필수 자료 미확인"}`;
}

/** Status is a signal, not evidence of an actual holding. Portfolio tracks holdings. */
export function getDisplayStatus(row: ScreeningRow): string {
  if (row.instrument.instrumentType === "STOCK") {
    const pending = pendingStatus(row);
    if (pending) return pending;
    const status = getOperationalStatus(row, row.instrument.market);
    if (status === "관찰" && row.instrument.market === "KOSDAQ") {
      if (row.grade === "A") return "관심 후보";
      if (row.grade === "B") return "관찰 후보";
    }
    return status;
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

/** The filter and table share the exact same holding-perspective predicate. */
export function isHeldExit(row: ScreeningRow, context: DomesticPositionContext | null | undefined) {
  return !!context?.heldSymbols.includes(row.instrument.symbol) && heldExitStatus(row) !== null;
}
function unheldStatus(row: ScreeningRow) {
  return getStoredOperationalExit(row, row.instrument.market) ? "관찰" : getDisplayStatus(row);
}

export function isPortfolioAwareOperationalEntry(
  row: ScreeningRow,
  context: DomesticPositionContext | null | undefined,
  signalDate: string,
): boolean {
  return (
    isOperationalEntry(row, signalDate) &&
    !isOnsetSuppressed(context, row.instrument.symbol, row.kospiEntry?.originDate ?? signalDate)
  );
}

/** Reconcile user-facing status with the canonical actual ledger without mutating raw screening history. */
export function getPortfolioAwareDisplayStatus(
  row: ScreeningRow,
  context: DomesticPositionContext | null | undefined,
  signalDate: string,
): string {
  if (row.instrument.instrumentType !== "STOCK") return getDisplayStatus(row);
  const pending = pendingStatus(row);
  if (context?.heldSymbols.includes(row.instrument.symbol)) {
    const heldStatus = heldExitStatus(row) ?? "보유";
    return pending ? `${heldStatus} · 신규 진입 ${pending}` : heldStatus;
  }
  if (pending) {
    return pending;
  }
  if (
    row.kospiEntry?.state === "confirmed" &&
    row.kospiEntry.date !== signalDate &&
    !context?.heldSymbols.includes(row.instrument.symbol)
  )
    return "기한 지난 확인 · 진입 제외";
  if (!context) return unheldStatus(row);
  const symbol = row.instrument.symbol;
  if (
    isOnsetSuppressed(context, symbol, row.kospiEntry?.originDate ?? signalDate) &&
    (isOperationalEntry(row, signalDate) || row.kospiEntry?.state === "pending")
  )
    return "당일 매도 · 재진입 제외";
  if (row.kospiEntry?.state === "confirmed" && row.kospiEntry.date !== signalDate)
    return "기한 지난 확인 · 진입 제외";
  return unheldStatus(row);
}
