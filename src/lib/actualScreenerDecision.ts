import { entryDecisionLabel, findEntryDecision } from "./actualEntryDecisions";
import { getCompactStockStatus as rawCompact, type CompactStockStatus } from "./stockCompactStatus";
import {
  getPortfolioAwareDisplayStatus as rawDisplay,
  isPortfolioAwareOperationalEntry as rawEntry,
} from "./statusDisplay";
import type { DomesticPositionContext } from "./positionSignalContext";
import type { ScreeningRow } from "./engine/pipeline";
import { isOperationalSignalDate } from "./operationalSignalStart";
export function actualStockDecisionLabel(
  row: ScreeningRow,
  context: DomesticPositionContext | null | undefined,
  date: string,
): string | null {
  if (!isOperationalSignalDate(date) || context?.heldSymbols.includes(row.instrument.symbol))
    return null;
  if (context?.actualEntryDecisions === null) return "미매수 제한 조회 대기";
  const d = findEntryDecision(
    context?.actualEntryDecisions,
    row.instrument.market,
    row.instrument.symbol,
    row.instrument.market === "KOSPI" ? (row.kospiEntry?.originDate ?? date) : date,
  );
  return d
    ? rawEntry(row, context, date) || row.kospiEntry?.state === "pending"
      ? entryDecisionLabel(d)
      : `진입 제한 · ${d.reason}`
    : null;
}
export function isActualOperationalEntry(
  row: ScreeningRow,
  context: DomesticPositionContext | null | undefined,
  date: string,
) {
  return !actualStockDecisionLabel(row, context, date) && rawEntry(row, context, date);
}
export function actualStockDisplay(
  row: ScreeningRow,
  context: DomesticPositionContext | null | undefined,
  date: string,
  tradeDates?: readonly string[],
) {
  return actualStockDecisionLabel(row, context, date) ?? rawDisplay(row, context, date, tradeDates);
}
export function actualCompactStockStatus(
  row: ScreeningRow,
  context: DomesticPositionContext | null | undefined,
  date: string,
  tradeDates?: readonly string[],
): CompactStockStatus {
  const label = actualStockDecisionLabel(row, context, date);
  return label
    ? { primary: label, secondary: "실제 원장 전용 · 포트폴리오에서 관리", tone: "warn" }
    : rawCompact(row, context, date, tradeDates);
}
