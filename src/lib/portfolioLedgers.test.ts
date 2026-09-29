import { describe, expect, it } from "vitest";
import { calculateActual, LEDGER_VERSION, simulateStrategy, type ActualExecution } from "./portfolioLedgers";
import { getOperationalSignals } from "./engine/operationalStrategy";
import type { ScreeningSnapshot, SnapshotEntry } from "./screeningSnapshot";
import type { DailyPrice, Market } from "./engine/types";

const settings = { initialCapital: 30000, maxPositions: 30, sectorCap: 0.3, roundTripCostRate: 0 };
const date = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString().slice(0, 10);
const bars = (length = 4) =>
  Array.from(
    { length },
    (_, i) => ({ tradeDate: date(i + 1), open: 100, close: 110 }) as DailyPrice,
  );
const entry = (symbol: string, sector = symbol): SnapshotEntry => ({
  symbol,
  name: symbol,
  instrumentType: "STOCK",
  sectorCode: sector,
  sectorName: sector,
  grade: "A",
  status: "",
  totalScore: 80,
  scoreDelta1d: 0,
  technicalPoints: 8,
  priorityPoints: 5,
  hardFilterPassed: true,
  ...getOperationalSignals("KOSPI", 7.5, 8, true),
});
const snapshot = (entries: SnapshotEntry[], day = 1): ScreeningSnapshot => ({
  date: date(day),
  asOfDate: date(day),
  savedAt: date(day) + "T09:00:00Z",
  entries,
  marketGateStatus: "",
  totalCount: entries.length,
  passedCount: entries.length,
  gradeACount: entries.length,
  gradeBCount: 0,
});
const buy = (id: string, overrides: Partial<ActualExecution> = {}): ActualExecution => ({
  id,
  symbol: id,
  name: id,
  market: "KOSPI",
  signalKey: id + "|" + date(1),
  side: "BUY",
  date: date(2),
  price: 100,
  shares: 10,
  fee: 10,
  note: "",
  order: 0,
  ...overrides,
});

describe("portfolio ledger rule version", () => {
  it("invalidates cached strategy ledgers after held signal-priority rules change", () => {
    expect(LEDGER_VERSION).toBe(2);
  });
});

describe("independent strategy and actual books", () => {
  it("keeps all 31 signals, fills strategy's 30 slots, and allows the actual book to buy the other symbol", () => {
    const entries = Array.from({ length: 31 }, (_, i) => entry(String(i).padStart(6, "0")));
    const prices = Object.fromEntries(entries.map((e) => [e.symbol, bars()]));
    const markets = Object.fromEntries(entries.map((e) => [e.symbol, "KOSPI" as Market]));
    const model = simulateStrategy(settings, [snapshot(entries)], prices, markets);
    expect(model.candidates).toHaveLength(31);
    expect(model.trades).toHaveLength(30);
    expect(model.candidates[30]?.decision).toBe("30종목 한도");
    const copy = JSON.stringify(model);
    const actual = calculateActual(30000, [buy("000030")], model.quotes, date(4));
    expect(actual.summary.openPositions).toBe(1);
    expect(actual.positions[0]?.symbol).toBe("000030");
    expect(JSON.stringify(model)).toBe(copy);
    expect(calculateActual(30000, [], model.quotes, date(4)).summary.totalPnl).toBe(0);
  });
  it("enforces sector capacity and ranks higher technical score first", () => {
    const entries = [
      entry("A", "s"),
      entry("B", "s"),
      entry("C", "s"),
      { ...entry("D", "s"), technicalPoints: 9 },
    ];
    const model = simulateStrategy(
      settings,
      [snapshot(entries)],
      Object.fromEntries(entries.map((e) => [e.symbol, bars()])),
      Object.fromEntries(entries.map((e) => [e.symbol, "KOSPI"])),
    );
    expect(model.trades.map((t) => t.symbol)).toEqual(["D", "A", "B"]);
    expect(model.candidates.find((c) => c.symbol === "C")?.decision).toBe("섹터 한도");
  });
  it("waits for next open and applies UP95 without selling actual holdings", () => {
    const onset = snapshot([entry("A")]);
    const pending = simulateStrategy(settings, [onset], { A: bars(1) }, { A: "KOSPI" });
    expect(pending.trades).toHaveLength(0);
    expect(pending.candidates[0]?.decision).toBe("다음 거래일 대기");
    const exit = snapshot([{ ...entry("A"), ...getOperationalSignals("KOSPI", 9, 9.5, true) }], 3);
    const model = simulateStrategy(settings, [onset, exit], { A: bars() }, { A: "KOSPI" });
    expect(model.trades[0]).toMatchObject({
      status: "CLOSED",
      entryDate: date(2),
      exitDate: date(4),
      exitReason: "9.5점 상향돌파",
    });
    expect(calculateActual(30000, [buy("A")], model.quotes, date(4)).summary.openPositions).toBe(1);
  });
  it("treats a held KOSDAQ 5.5→9.5 recovery as Exit and suppresses the repeated Onset", () => {
    const make = (
      previous: number,
      current: number,
      day: number,
    ): ScreeningSnapshot =>
      snapshot(
        [
          {
            ...entry("SIM", "IT_HW"),
            market: undefined,
            technicalPoints: current,
            totalScore: current * 10,
            scoreDelta1d: (current - previous) * 10,
            ...getOperationalSignals("KOSDAQ", previous, current, true),
          } as SnapshotEntry,
        ],
        day,
      );

    const model = simulateStrategy(
      settings,
      [make(7.5, 9.5, 1), make(9.5, 5.5, 3), make(5.5, 9.5, 4)],
      { SIM: bars(4) },
      { SIM: "KOSDAQ" },
    );

    expect(model.trades).toHaveLength(1);
    expect(model.trades[0]).toMatchObject({
      symbol: "SIM",
      status: "OPEN",
      currentTechnicalPoints: 9.5,
      currentStatus: "전략 청산 대기",
    });
    expect(model.quotes.SIM?.exitSignal).toBe("UP90");
    expect(model.candidates).toHaveLength(1);
    expect(model.candidates[0]).toMatchObject({ symbol: "SIM", signalDate: date(1) });
  });

  it("does not use day-60 closing proceeds for the same morning's entry", () => {
    const all = bars(62);
    const model = simulateStrategy(
      { ...settings, initialCapital: 100, maxPositions: 1 },
      [snapshot([entry("A")]), snapshot([entry("B")], 60)],
      { A: all, B: all },
      { A: "KOSPI", B: "KOSPI" },
    );
    expect(model.trades).toHaveLength(1);
    expect(model.trades[0]).toMatchObject({ exitDate: date(61), exitReason: "60거래일 만기" });
    expect(model.candidates.find((c) => c.symbol === "B")?.decision).toBe("30종목 한도");
  });
});

describe("actual execution accounting", () => {
  it("uses actual fees and moving average cost for partial sales", () => {
    const events = [
      buy("b", { symbol: "A" }),
      buy("s", { symbol: "A", side: "SELL", shares: 4, price: 130, fee: 5, date: date(3) }),
    ];
    const actual = calculateActual(
      5000,
      events,
      { A: { price: 120, date: date(4), exitSignal: null } },
      date(4),
    );
    expect(actual.positions[0]).toMatchObject({
      shares: 6,
      cost: 606,
      averagePrice: 101,
      marketValue: 720,
      unrealizedPnl: 114,
    });
    expect(actual.summary).toMatchObject({
      cash: 4505,
      equity: 5225,
      totalPnl: 225,
      realizedPnl: 111,
      unrealizedPnl: 114,
    });
  });
  it("rejects overselling and removing a purchase supporting later sales", () => {
    const sale = buy("s", { side: "SELL", symbol: "A", shares: 11, date: date(3) });
    expect(() => calculateActual(5000, [buy("A"), sale], {}, null)).toThrow("초과");
    expect(() => calculateActual(5000, [sale], {}, null)).toThrow("초과");
  });
  it("caps distinct holdings rather than number of purchase records and frees a slot after a sale", () => {
    const events = Array.from({ length: 30 }, (_, i) => buy(String(i), { order: i }));
    expect(
      calculateActual(100000, [...events, buy("add", { symbol: "0", order: 30 })], {}, null)
        .positions,
    ).toHaveLength(30);
    expect(() => calculateActual(100000, [...events, buy("31", { order: 31 })], {}, null)).toThrow(
      "30개",
    );
    expect(
      calculateActual(
        100000,
        [
          ...events,
          buy("sell", { symbol: "0", side: "SELL", order: 30 }),
          buy("31", { order: 31 }),
        ],
        {},
        null,
      ).positions,
    ).toHaveLength(30);
  });
  it("ignores stale quotes from before the actual entry", () => {
    const actual = calculateActual(
      5000,
      [buy("A")],
      { A: { price: 1, date: date(1), exitSignal: "UP95" } },
      date(1),
    );
    expect(actual.positions[0]).toMatchObject({
      currentPrice: 100,
      markDate: null,
      exitSignal: null,
    });
  });
});
