import { describe, expect, it } from "vitest";
import {
  actualPriceExitStatus,
  isActionableActualPriceExit,
  type ActualPriceExitEvidence,
} from "./newActualPriceExit";
import { etfOperationalDisplay } from "./etfOperationalDisplay";
import { getCompactStockStatus } from "./stockCompactStatus";
import type { ScreeningRow } from "./engine/pipeline";
const exit = (auditStatus?: ActualPriceExitEvidence["auditStatus"]): ActualPriceExitEvidence => ({
  reason: "E4",
  signalDate: "2026-10-15",
  threshold: "108",
  status: "청산 대기 · 다음 거래 가능 시가",
  ...(auditStatus ? { auditStatus } : {}),
});
describe("shared actual price-exit consumer trust", () => {
  it.each(["PENDING", "MISMATCH", undefined] as const)(
    "blocks %s evidence even with leftover actionable strings",
    (status) => {
      const evidence = exit(status);
      expect(isActionableActualPriceExit(evidence)).toBe(false);
      expect(actualPriceExitStatus(evidence)).toContain("확인 대기");
      const row = {
        instrument: { symbol: "ABC", instrumentType: "ETF", market: "ETF" },
        snapshot: { tradeDate: "2026-10-14" },
      } as ScreeningRow;
      expect(etfOperationalDisplay(row, "2026-10-15", true, false, evidence)).not.toContain(
        "다음 거래",
      );
      expect(
        getCompactStockStatus(
          row,
          { heldSymbols: ["ABC"], lastSellDateBySymbol: {}, priceExits: { ABC: evidence } },
          "2026-10-15",
        ).secondary,
      ).not.toContain("다음 거래");
    },
  );
  it.each(["VERIFIED", "LATCHED"] as const)("allows complete %s evidence", (status) => {
    expect(isActionableActualPriceExit(exit(status))).toBe(true);
    expect(actualPriceExitStatus(exit(status))).toContain("다음 거래");
    expect(isActionableActualPriceExit({ ...exit(status), signalDate: null })).toBe(false);
    expect(isActionableActualPriceExit({ ...exit(status), threshold: null })).toBe(false);
  });
});
