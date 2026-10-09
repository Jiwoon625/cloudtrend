import { describe, expect, it } from "vitest";
import { runAdoptedKrBacktest, type AdoptedKrBacktestInput } from "./adoptedKrBacktest";
import { simulateStrategy } from "../portfolioLedgers";
import { decimal, divide, format, integerBudgetQuantity } from "../ledger/decimal";
import { CURRENT_RULES_RESEARCH } from "../engine/operatingPolicyContext";
import {
  isKospiEntryReady,
  kospiEntryConfirmation,
  type KospiEntryObservation,
} from "../engine/kospiEntryConfirmation";
import { getOperationalSignals } from "../engine/operationalStrategy";
import type { DailyPrice } from "../engine/types";
import type { ScreeningSnapshot, SnapshotEntry } from "../screeningSnapshot";
import { kospiGate } from "../../../tests/kospi-policy-fixtures";

const bar = (tradeDate: string, open = 100, close = open): DailyPrice => ({
  tradeDate,
  open,
  close,
  high: Math.max(open, close),
  low: Math.min(open, close),
  volume: 1000,
  tradingValue: close * 1000,
  marketCap: 1e12,
  foreignNetBuyValue: 1000,
  institutionNetBuyValue: 100,
  openObserved: true,
  volumeObserved: true,
});
const entry = (symbol: string, sectorCode = symbol): SnapshotEntry => ({
  symbol,
  name: symbol,
  instrumentType: "STOCK",
  sectorCode,
  sectorName: sectorCode,
  grade: "A",
  status: "",
  totalScore: 80,
  scoreDelta1d: 5,
  technicalPoints: 8,
  priorityPoints: 5,
  hardFilterPassed: true,
  ...getOperationalSignals("KOSDAQ", 7.5, 8, true),
});
const snapshot = (date: string, entries: SnapshotEntry[] = []): ScreeningSnapshot => ({
  date,
  asOfDate: date,
  savedAt: `${date}T12:00:00Z`,
  marketGateStatus: "RISK_ON",
  entries,
  totalCount: entries.length,
  passedCount: entries.length,
  gradeACount: entries.length,
  gradeBCount: 0,
});
const inputs = (dates: string[], symbols = ["A"]): AdoptedKrBacktestInput => ({
  startDate: dates[0]!,
  throughDate: dates.at(-1)!,
  scope: "MIXED",
  marketDates: dates,
  marketGates: {},
  snapshots: dates.map((date, index) =>
    snapshot(date, index ? [] : symbols.map((symbol) => entry(symbol))),
  ),
  bars: Object.fromEntries(symbols.map((symbol) => [symbol, dates.map((date) => bar(date))])),
  markets: Object.fromEntries(symbols.map((symbol) => [symbol, "KOSDAQ" as const])),
});
const sessions = (start: string, count: number) => {
  const out: string[] = [];
  const date = new Date(`${start}T00:00:00Z`);
  while (out.length < count) {
    if (date.getUTCDay() > 0 && date.getUTCDay() < 6) out.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return out;
};

describe("explicit historical current-rules KR contract", () => {
  it("uses v4 confirmation before adoption without moving real dates or weakening the default", () => {
    const observation = (date: string, score: number): KospiEntryObservation => ({
      date,
      score,
      eligible: true,
      observed: true,
      rsAccel: null,
      marketGate: kospiGate(date, "NEUTRAL"),
    });
    const before = observation("2018-01-02", 7.5),
      origin = observation("2018-01-03", 8),
      current = observation("2018-01-04", 8.5);
    expect(isKospiEntryReady(kospiEntryConfirmation(current, origin, before))).toBe(false);
    const replay = kospiEntryConfirmation(current, origin, before, CURRENT_RULES_RESEARCH);
    expect(isKospiEntryReady(replay, current.date, CURRENT_RULES_RESEARCH)).toBe(true);
    expect(replay.date).toBe("2018-01-04");
    expect(isKospiEntryReady(replay)).toBe(false);
    expect(
      kospiEntryConfirmation({ ...current, score: 9.5 }, origin, before, CURRENT_RULES_RESEARCH)
        .state,
    ).toBe("rejected");
    expect(
      kospiEntryConfirmation(
        { ...current, score: 9.5 },
        { ...origin, score: 9.5 },
        before,
        CURRENT_RULES_RESEARCH,
      ).state,
    ).toBe("confirmed");
    const bear = { ...origin, marketGate: kospiGate(origin.date, "RISK_OFF") };
    expect(
      kospiEntryConfirmation({ ...current, rsAccel: 1 }, bear, before, CURRENT_RULES_RESEARCH)
        .eligible,
    ).toBe(false);
  });

  it("matches current production fills, exact cash and fees on the same period", () => {
    const input = inputs(["2026-10-12", "2026-10-13", "2026-10-14"], ["A", "B"]);
    input.bars["A"]![1] = bar("2026-10-13", 99_999);
    input.bars["A"]!.splice(2, 1);
    const research = runAdoptedKrBacktest(input);
    const production = simulateStrategy(
      { initialCapital: 100_000_000, maxPositions: 30, sectorCap: 0.3, roundTripCostRate: 0.003 },
      input.snapshots,
      input.bars,
      input.markets,
      "",
      input.marketDates,
      {},
      {
        version: "kr-common-execution-20261012-v1",
        startDate: "2026-10-12",
        throughDate: "2026-10-14",
        scope: "MIXED",
      },
    );
    expect(research.ledger.modelAccounting).toEqual(production.modelAccounting);
    const executions = (trades: typeof production.trades) =>
      trades.map(({ targetAmount: _targetAmount, ...trade }) => trade);
    expect(executions(research.trades)).toEqual(executions(production.trades));
    expect(research.dailyNAV.at(-1)!.nav).toBe(research.ledger.modelAccounting!.nav);
    expect(research.dailyNAV.at(-1)!.cash).toBe(research.ledger.modelAccounting!.cash);
    expect(
      research.evidence.exitTiming[research.trades.find((trade) => trade.symbol === "A")!.id],
    ).toBe("CLOSE");
  });

  it("executes a historical KOSPI confirmation with current carry and the last completed market gate", () => {
    const dates = sessions("2018-02-01", 6);
    const input = inputs(dates);
    input.markets["A"] = "KOSPI";
    const observation = (index: number, score: number): KospiEntryObservation => ({
      date: dates[index]!,
      score,
      eligible: true,
      observed: true,
      rsAccel: null,
      marketGate: kospiGate(dates[index]!, "NEUTRAL"),
    });
    const confirmed = kospiEntryConfirmation(
      observation(2, 8.5),
      observation(1, 8),
      observation(0, 7.5),
      CURRENT_RULES_RESEARCH,
    );
    input.snapshots = dates.map((date, index) =>
      snapshot(
        date,
        index === 2
          ? [
              {
                ...entry("A"),
                kosdaq80Onset: false,
                kospiEntry: confirmed,
                operationalSignalVersion: confirmed.version,
              },
            ]
          : [],
      ),
    );
    input.marketGates = Object.fromEntries(dates.map((date) => [date, kospiGate(date, "NEUTRAL")]));
    input.bars["A"]![3] = { ...bar(dates[3]!), volumeObserved: false };
    input.marketGates[dates[3]!] = kospiGate(dates[3]!, "RISK_OFF");
    const result = runAdoptedKrBacktest(input);
    expect(result.trades[0]!.entryDate).toBe(dates[5]);
    expect(result.trades[0]!.signalDate).toBe(dates[2]);
    expect(result.ledger.candidates[0]!.originDate).toBe(dates[1]);
  });

  it("fixes the new year's budget at the preceding close even with no early-January candidates", () => {
    const dates = [
      "2019-12-27",
      "2019-12-30",
      "2019-12-31",
      "2020-01-02",
      "2020-01-03",
      "2020-01-06",
    ];
    const input = inputs(dates, ["A", "B"]);
    input.snapshots[0] = snapshot(dates[0]!, [entry("A")]);
    input.snapshots[4] = snapshot(dates[4]!, [entry("B")]);
    input.bars["A"] = dates.map((date, index) =>
      bar(date, index >= 3 ? 5000 : 100, index === 2 ? 200 : index >= 3 ? 5000 : 100),
    );
    const result = runAdoptedKrBacktest(input);
    const prior = result.dailyNAV.find((row) => row.date === "2019-12-31")!;
    const year = result.yearlyBudgets[1]!;
    expect(year.effectiveDate).toBe("2020-01-02");
    expect(year.valuationDate).toBe("2019-12-31");
    expect(year.nav).toBe(prior.nav);
    expect(year.budget).toBe(format(divide(decimal(prior.nav!), decimal("30"))));
    expect(result.dailyNAV.find((row) => row.date === "2020-01-02")!.entryBudget).toBe(year.budget);
    const second = result.trades.find((trade) => trade.symbol === "B")!;
    expect(String(second.shares)).toBe(integerBudgetQuantity(year.budget, prior.cash, "100"));
    const changed = structuredClone(input);
    changed.bars["A"]![3] = bar("2020-01-02", 1_000_000, 1_000_000);
    expect(runAdoptedKrBacktest(changed).yearlyBudgets).toEqual(result.yearlyBudgets);
    expect(result.trades.find((trade) => trade.symbol === "A")!.shares).toBe(33283);
  });

  it("records cash-only year boundaries and labels standalone accounts as diagnostics", () => {
    const input = inputs(["2019-12-31", "2020-01-02", "2021-01-04"]);
    input.snapshots = input.marketDates.map((date) => snapshot(date));
    input.scope = "KOSDAQ";
    const result = runAdoptedKrBacktest(input);
    expect(result.yearlyBudgets.map((year) => year.year)).toEqual([2019, 2020, 2021]);
    expect(result.yearlyBudgets.every((year) => year.budget === "3333333.33333333")).toBe(true);
    expect(result.evidence.accountRole).toBe("INDEPENDENT_30_SLOT_DIAGNOSTIC");
  });

  it("rejects annual resets from a stale prior close instead of silently reusing an old mark", () => {
    const dates = ["2019-12-27", "2019-12-30", "2019-12-31", "2020-01-02"];
    const input = inputs(dates);
    input.bars["A"] = input.bars["A"]!.filter((bar) => bar.tradeDate !== "2019-12-31");
    expect(() => runAdoptedKrBacktest(input)).toThrow(/complete prior-close NAV/);
  });

  it("does not spend H60 close proceeds at the same morning open", () => {
    const dates = sessions("2020-02-03", 63);
    const symbols = Array.from({ length: 30 }, (_, index) => `S${String(index).padStart(2, "0")}`);
    const input = inputs(dates, [...symbols, "NEW"]);
    input.initialCapital = 3000;
    input.snapshots[0] = snapshot(
      dates[0]!,
      symbols.map((symbol) => entry(symbol)),
    );
    input.snapshots[59] = snapshot(dates[59]!, [entry("NEW")]);
    input.bars = Object.fromEntries(
      [...symbols, "NEW"].map((symbol) => [symbol, dates.map((date) => bar(date, 99.85))]),
    );
    const result = runAdoptedKrBacktest(input);
    expect(
      result.trades
        .filter((trade) => trade.symbol !== "NEW")
        .every((trade) => trade.exitDate === dates[60]),
    ).toBe(true);
    expect(result.trades.find((trade) => trade.symbol === "NEW")!.entryDate).toBe(dates[61]);
    expect(result.dailyNAV[60]!.openPositions).toBe(0);
    expect(result.dailyNAV[61]!.openPositions).toBe(1);
  });

  it("carries missing and unobserved opens on real historical dates", () => {
    const dates = sessions("2018-02-01", 5);
    const input = inputs(dates);
    input.bars["A"]![1] = { ...bar(dates[1]!), volume: 0 };
    input.bars["A"]![2] = { ...bar(dates[2]!), openObserved: false };
    input.bars["A"]!.splice(3, 1);
    const result = runAdoptedKrBacktest(input);
    expect(result.trades[0]!.entryDate).toBe(dates[4]);
    expect(result.dailyNAV.slice(0, 4).every((row) => row.cash === "100000000")).toBe(true);
  });

  it("keeps future price and snapshot rows out of an earlier NAV prefix", () => {
    const dates = sessions("2018-03-01", 5);
    const input = inputs(dates);
    input.throughDate = dates[2]!;
    const baseline = runAdoptedKrBacktest(input);
    input.bars["A"]![3] = bar(dates[3]!, 100_000, 100_000);
    input.snapshots[3] = snapshot(dates[3]!, [{ ...entry("A"), exitSignal: "UP90" }]);
    const changed = runAdoptedKrBacktest(input);
    expect(changed.dailyNAV).toEqual(baseline.dailyNAV);
    expect(changed.trades).toEqual(baseline.trades);
    expect(changed.ledger.modelAccounting).toEqual(baseline.ledger.modelAccounting);
  });
  it("keeps a prior-year pending intent's budget after the annual reset", () => {
    const dates = [
      "2019-12-26",
      "2019-12-27",
      "2019-12-30",
      "2019-12-31",
      "2020-01-02",
      "2020-01-03",
    ];
    const input = inputs(dates, ["A", "B"]);
    input.snapshots = dates.map((date) => snapshot(date));
    input.snapshots[0] = snapshot(dates[0]!, [entry("A")]);
    input.snapshots[3] = snapshot(dates[3]!, [entry("B")]);
    for (let i = 2; i < dates.length; i++) input.bars["A"]![i] = bar(dates[i]!, 200, 200);
    input.bars["B"]![4] = { ...bar(dates[4]!), openObserved: false };
    const result = runAdoptedKrBacktest(input);
    expect(result.yearlyBudgets[1]!.budget).not.toBe(result.yearlyBudgets[0]!.budget);
    const pending = result.trades.find((t) => t.symbol === "B")!;
    expect(pending.entryDate).toBe(dates[5]);
    expect(pending.targetAmount).toBe(Number(result.yearlyBudgets[0]!.budget));
    expect(pending.shares).toBe(33283);
  });
});
