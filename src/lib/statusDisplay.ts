import type { ScreeningRow } from "@/lib/engine/pipeline";
import { getOperationalStatus } from "@/lib/engine/operationalStrategy";
import { isKospiRelativeMomentumConfirmed } from "@/lib/kospiRelativeQuality";

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
