import { describe, it, expect } from "vitest";
import { parseManualMarketData } from "./engine/manualDataset";
import { nextConfirmedEntry, deriveExitPlan } from "./portfolioStrategyRules";
import { integerBudgetQuantity, decimal } from "./ledger/decimal";
import {
  freezeRestartSeries,
  initializeModelSeries,
  verifyFrozenSeries,
  ADOPTED_SERIES_KINDS,
} from "./ledger/modelSeries";
import {
  kospiEntryConfirmation,
  isKospiEntryReady,
  type KospiEntryObservation,
} from "./engine/kospiEntryConfirmation";
import { kospiGate } from "../../tests/kospi-policy-fixtures";
import type { DailyPrice } from "./engine/types";
import type { PortfolioTrade } from "./portfolioStoreCore";

const bar = (date: string, volume = 100): DailyPrice => ({
  tradeDate: date,
  open: 100,
  high: 105,
  low: 95,
  close: 102,
  volume,
  tradingValue: 102 * volume,
  marketCap: null,
  foreignNetBuyValue: null,
  institutionNetBuyValue: null,
  openObserved: true,
  volumeObserved: true,
});
const obs = (date: string, score: number, rsAccel: number | null): KospiEntryObservation => ({
  date,
  score,
  rsAccel,
  observed: true,
  eligible: true,
  marketGate: kospiGate(date),
});
describe("October 12 approved consistency contract", () => {
  it("compares selected symbol/date values across full screening and bounded ledger parsing", () => {
    const files = [
      "symbol,date,market,open,high,low,close,volume\n005930,2026-10-12,KOSPI,100,110,90,105,100\n000660,2026-10-13,KOSPI,200,210,190,205,100",
      "symbol,date,market,open,high,low,close,volume\n005930,2026-10-12,KOSPI,101,,,,200\n005930,2026-10-13,KOSPI,0,0,0,0,0",
    ];
    const full = parseManualMarketData(files, { allowIncompleteIndex: true }).dataset;
    const ledger = parseManualMarketData(files, {
      allowIncompleteIndex: true,
      symbols: new Set(["005930"]),
    }).dataset;
    expect(ledger.bars["005930"]).toEqual(full.bars["005930"]);
    expect(ledger.bars["005930"]?.[0]).toMatchObject({
      open: 101,
      close: 105,
      volume: 200,
      high: 110,
      low: 90,
    });
    expect(ledger.observedBars?.["005930"]?.[1]).toMatchObject({ close: 0, volume: 0 });
    expect(ledger.liquidSymbolCountsByDate?.["2026-10-13"]).toBe(1);
  });
  it("carries an entry across zero volume, absent rows and inferred opens", () => {
    const bars = [
      bar("2026-10-13", 0),
      { ...bar("2026-10-15"), openObserved: false },
      bar("2026-10-16"),
    ];
    expect(
      nextConfirmedEntry(bars, "2026-10-12", [
        "2026-10-13",
        "2026-10-14",
        "2026-10-15",
        "2026-10-16",
      ]).bar?.tradeDate,
    ).toBe("2026-10-16");
  });
  it("recognizes missing held data at the current close using exactly the previous session open", () => {
    const trade = { symbol: "005930", market: "KOSPI", entryDate: "2026-10-12" } as PortfolioTrade;
    expect(
      deriveExitPlan(trade, [], [bar("2026-10-12")], "2026-10-13", ["2026-10-12", "2026-10-13"]),
    ).toMatchObject({ exitDate: "2026-10-13", exitPrice: 100, timing: "CLOSE" });
    expect(
      deriveExitPlan(trade, [], [bar("2026-10-12")], "2026-10-14", [
        "2026-10-12",
        "2026-10-13",
        "2026-10-14",
      ])?.exitDate,
    ).toBe("2026-10-13");
    expect(deriveExitPlan(trade, [], [bar("2026-10-12")], "2026-10-13", [])).toBeNull();
  });
  it("rejects a new confirmation crossing while allowing 9.5 maintenance without a non-bear RS veto", () => {
    const before = obs("2026-10-08", 7.5, 0),
      origin = obs("2026-10-12", 9.5, -2),
      confirm = obs("2026-10-13", 9.5, null);
    expect(isKospiEntryReady(kospiEntryConfirmation(confirm, origin, before))).toBe(true);
    expect(kospiEntryConfirmation(confirm, { ...origin, score: 9 }, before).state).toBe("rejected");
  });
  it("never forces one share or rounds cash beyond budget", () => {
    expect(integerBudgetQuantity("100", "1000", "100")).toBe("0");
    expect(integerBudgetQuantity("100.15", "100.15", "100")).toBe("1");
    expect(integerBudgetQuantity("1000", "99", "100")).toBe("0");
  });
  it("opens eight independent cash-only contracts with the approved FX and no inherited state", async () => {
    for (const kind of ADOPTED_SERIES_KINDS) {
      const series = await freezeRestartSeries({
        kind,
        frozenAt: "2026-10-09T01:00:00Z",
        codeHash: `sha256:${"a".repeat(64)}`,
        sourceHash: `sha256:${"b".repeat(64)}`,
      });
      await verifyFrozenSeries(series);
      const initial = await initializeModelSeries(series);
      expect(series.bookId).toBe(`adopted-shadow-2026-10-12-v1:${kind}`);
      expect(initial.firstValidSessionDate).toBeNull();
      expect(initial.openingBalances.every((b) => b.positions.length === 0)).toBe(true);
      if (series.fx) {
        expect(series.fx.evidence.rate).toBe("1339.2");
        expect(decimal(series.fx.convertedKrw) + decimal(series.fx.residualKrw)).toBe(
          decimal("100000000"),
        );
      }
    }
  });
});
