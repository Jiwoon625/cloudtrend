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

/** A threshold in generic screening is not a sell instruction for an unheld stock. */
function exitConditionStatus(
  row: ScreeningRow,
  holdingLabel: "미보유" | "보유 미확인",
): string | null {
  const exit = getStoredOperationalExit(row, row.instrument.market);
  const condition =
    exit === "UP95"
      ? "KOSPI 9.5점 상향돌파"
      : exit === "UP90"
        ? "KOSDAQ 9.0점 상향 재돌파"
        : exit === "DOWN30"
          ? "KOSDAQ 3.0점 하향 이탈"
          : null;
  return condition ? `${holdingLabel} · ${condition} 조건 충족` : null;
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
    const exit = exitConditionStatus(row, context ? "미보유" : "보유 미확인");
    return exit ? `${pending} · ${exit}` : pending;
  }
  if (
    row.kospiEntry?.state === "confirmed" &&
    row.kospiEntry.date !== signalDate &&
    !context?.heldSymbols.includes(row.instrument.symbol)
  )
    return "기한 지난 확인 · 진입 제외";
  if (!context) return exitConditionStatus(row, "보유 미확인") ?? getDisplayStatus(row);
  const symbol = row.instrument.symbol;
  if (
    isOnsetSuppressed(context, symbol, row.kospiEntry?.originDate ?? signalDate) &&
    (isOperationalEntry(row, signalDate) || row.kospiEntry?.state === "pending")
  )
    return "당일 매도 · 재진입 제외";
  if (row.kospiEntry?.state === "confirmed" && row.kospiEntry.date !== signalDate)
    return "기한 지난 확인 · 진입 제외";
  return exitConditionStatus(row, "미보유") ?? getDisplayStatus(row);
}
