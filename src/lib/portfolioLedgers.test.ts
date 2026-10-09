import { kospiEntryGates, kospiGate } from "../../tests/kospi-policy-fixtures";
import { describe, expect, it } from "vitest";
import {
  calculateActual,
  LEDGER_VERSION,
  simulateStrategy,
  type ActualExecution,
} from "./portfolioLedgers";
import {
  getOperationalSignals,
  LEGACY_OPERATIONAL_SIGNAL_VERSION,
  OPERATIONAL_SIGNAL_VERSION,
} from "./engine/operationalStrategy";
import { KOSPI_ENTRY_POLICY, type KospiEntrySnapshot } from "./engine/kospiEntryConfirmation";
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
  operationalSignalVersion: LEGACY_OPERATIONAL_SIGNAL_VERSION,
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
    expect(LEDGER_VERSION).toBe(3);
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
    const make = (previous: number, current: number, day: number): ScreeningSnapshot =>
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
    expect(model.quotes["SIM"]?.exitSignal).toBe("UP90");
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
    expect(model.candidates.find((c) => c.symbol === "B")?.decision).toBe("1종목 한도");
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

const policyEntry = (
  state: KospiEntrySnapshot["state"] = "confirmed",
  changes: Partial<KospiEntrySnapshot> = {},
): SnapshotEntry => ({
  ...entry("A"),
  kospi80Onset: state === "pending",
  operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
  kospiEntry: {
    version: KOSPI_ENTRY_POLICY.version,
    marketGate: kospiEntryGates(),
    date: "2026-10-02",
    originDate: "2026-10-01",
    confirmationDate: "2026-10-02",
    state,
    issues: [],
    rsAccel: 1,
    score: 8.5,
    originScore: 8,
    eligible: state === "confirmed",
    ...changes,
  },
});
const policySnapshot = (entries: SnapshotEntry[], asOfDate = "2026-10-02", time = "09:00:00Z") => ({
  ...snapshot(entries),
  date: asOfDate,
  asOfDate,
  savedAt: `${asOfDate}T${time}`,
});
const policyBars = (dates = ["2026-10-01", "2026-10-02", "2026-10-06", "2026-10-07"]) =>
  dates.map((tradeDate) => ({ tradeDate, open: 100, close: 110, volume: 1000 }) as DailyPrice);

describe("prospective KOSPI confirmation replay", () => {
  it("deduplicates the origin and confirmation and fills only after the confirmed close", () => {
    const pending = policySnapshot(
      [
        policyEntry("pending", {
          date: "2026-10-01",
          confirmationDate: null,
        }),
      ],
      "2026-10-01",
    );
    const confirmed = policySnapshot([policyEntry()]);
    const current = simulateStrategy(
      settings,
      [pending, confirmed],
      { A: policyBars(["2026-10-01", "2026-10-02"]) },
      { A: "KOSPI" },
    );
    expect(current.trades).toHaveLength(0);
    expect(current.candidates).toHaveLength(1);
    expect(current.candidates[0]).toMatchObject({
      key: "A|2026-10-01",
      entryState: "confirmed",
      confirmationDate: "2026-10-02",
      signalDate: "2026-10-02",
      entryDate: null,
    });
    const inputs = [pending, confirmed, policySnapshot([policyEntry()], "2026-10-02", "10:00:00Z")];
    const first = simulateStrategy(settings, inputs, { A: policyBars() }, { A: "KOSPI" });
    const rerun = simulateStrategy(settings, inputs, { A: policyBars() }, { A: "KOSPI" });
    expect(first.candidates).toHaveLength(1);
    expect(first.trades).toHaveLength(1);
    expect(first.trades[0]).toMatchObject({
      id: "A|2026-10-01",
      signalDate: "2026-10-02",
      entryDate: "2026-10-06",
      entryPrice: 100,
    });
    expect(rerun.trades).toEqual(first.trades);
  });

  it.each(["pending", "rejected", "unobservable"] as const)(
    "keeps %s visible without buying",
    (state) => {
      const model = simulateStrategy(
        settings,
        [policySnapshot([policyEntry(state)])],
        { A: policyBars() },
        { A: "KOSPI" },
      );
      expect(model.candidates).toHaveLength(1);
      expect(model.candidates[0]?.entryState).toBe(state);
      expect(model.candidates[0]?.entryDate).toBeNull();
      expect(model.trades).toHaveLength(0);
    },
  );

  it("keeps a completely missing symbol's confirmation visible and unfilled", () => {
    const model = simulateStrategy(
      settings,
      [policySnapshot([policyEntry()])],
      { B: policyBars() },
      { B: "KOSPI" },
    );
    expect(model.candidates).toHaveLength(1);
    expect(model.candidates[0]?.decision).toContain("자료 누락");
    expect(model.trades).toHaveLength(0);
  });

  it("waits through observed zero-volume suspension but never silently fills past a missing session", () => {
    const prices = policyBars();
    prices[2] = { ...prices[2]!, open: 0, volume: 0 };
    const suspended = simulateStrategy(
      settings,
      [policySnapshot([policyEntry()])],
      { A: prices },
      { A: "KOSPI" },
      "",
      prices.map((bar) => bar.tradeDate),
      { "2026-10-06": kospiGate("2026-10-06") },
    );
    expect(suspended.trades[0]?.entryDate).toBe("2026-10-07");
    const missing = simulateStrategy(
      settings,
      [policySnapshot([policyEntry()])],
      { A: prices.filter((bar) => bar.tradeDate !== "2026-10-06") },
      { A: "KOSPI" },
      "",
      policyBars().map((bar) => bar.tradeDate),
    );
    expect(missing.trades).toHaveLength(0);
    expect(missing.candidates[0]?.decision).toContain("자료 누락");
    expect(missing.candidates[0]?.entryDate).toBeNull();
  });

  it.each([
    { open: Number.NaN, volume: 100 },
    { open: Number.POSITIVE_INFINITY, volume: 100 },
    { open: 100, volume: Number.NaN },
    { open: 100, volume: 0 },
    { open: 0, volume: 10 },
  ])("does not execute an invalid or zero-volume open %j", (invalid) => {
    const prices = policyBars(["2026-10-01", "2026-10-02", "2026-10-06"]);
    prices[2] = { ...prices[2]!, ...invalid };
    const model = simulateStrategy(
      settings,
      [policySnapshot([policyEntry()])],
      { A: prices },
      { A: "KOSPI" },
    );
    expect(model.trades).toHaveLength(0);
  });

  it("preserves genuine old replay while refusing fabricated and post-cutover legacy entries", () => {
    const old = snapshot([entry("A")]);
    const recomputed = {
      ...old,
      savedAt: "2026-10-02T09:00:00Z",
      entries: [
        policyEntry("confirmed", {
          date: date(1),
          originDate: "2025-12-31",
          confirmationDate: date(1),
          eligible: true,
        }),
      ],
    };
    const preserved = simulateStrategy(settings, [old, recomputed], { A: bars() }, { A: "KOSPI" });
    expect(preserved.trades[0]?.entryDate).toBe(date(2));
    expect(
      simulateStrategy(settings, [recomputed], { A: bars() }, { A: "KOSPI" }).trades,
    ).toHaveLength(0);
    expect(
      simulateStrategy(
        settings,
        [policySnapshot([entry("A")])],
        { A: policyBars() },
        { A: "KOSPI" },
      ).trades,
    ).toHaveLength(0);
  });

  it.each(["2026-09-30", "2026-10-01", "2026-10-02"])(
    "excludes a confirmed origin held until the sale after %s",
    (exitSignalDate) => {
      const initial = policySnapshot([entry("A")], "2026-09-28");
      const exit = policySnapshot(
        [{ ...entry("A"), kospi80Onset: false, exitSignal: "UP95" }],
        exitSignalDate,
      );
      const dates = [
        "2026-09-28",
        "2026-09-29",
        "2026-09-30",
        "2026-10-01",
        "2026-10-02",
        "2026-10-06",
      ];
      const model = simulateStrategy(
        settings,
        [initial, exit, policySnapshot([policyEntry()], "2026-10-02", "10:00:00Z")],
        { A: policyBars(dates) },
        { A: "KOSPI" },
      );
      expect(model.trades).toHaveLength(1);
      expect(model.candidates.find((c) => c.originDate === "2026-10-01")?.decision).toContain(
        "보유/당일 매도",
      );
    },
  );
});

describe("cutover isolation", () => {
  it("does not replace or retime an October 1 legacy fill with an October 2 confirmation", () => {
    const old = policySnapshot([entry("A")], "2026-10-01");
    const newConfirmation = policySnapshot([policyEntry()]);
    const oldOnly = simulateStrategy(settings, [old], { A: policyBars() }, { A: "KOSPI" });
    const model = simulateStrategy(
      settings,
      [old, newConfirmation],
      { A: policyBars() },
      { A: "KOSPI" },
    );
    expect(model.trades).toHaveLength(1);
    expect(model.trades[0]).toMatchObject({
      id: "A|2026-10-01",
      signalDate: "2026-10-01",
      entryDate: "2026-10-02",
    });
    expect(model.trades[0]?.entryDate).toBe(oldOnly.trades[0]?.entryDate);
  });
  it("preserves KOSDAQ next-open handling and filters invalid price rows from quotes", () => {
    const onset = policySnapshot([
      { ...entry("D"), ...getOperationalSignals("KOSDAQ", 7, 8, true) },
    ]);
    const prices = policyBars(["2026-10-02", "2026-10-06", "2026-10-07", "2026-10-08"]);
    prices[1] = { ...prices[1]!, open: 0, close: 0 };
    prices[2] = { ...prices[2]!, open: 105, close: 112, volume: 0 };
    prices[3] = { ...prices[3]!, open: 0, close: 0 };
    const model = simulateStrategy(settings, [onset], { D: prices }, { D: "KOSDAQ" });
    expect(model.trades[0]).toMatchObject({ entryDate: "2026-10-07", entryPrice: 105 });
    expect(model.quotes["D"]).toEqual({ price: 112, date: "2026-10-07", exitSignal: null });
  });
  it("does not rewrite actual executions when confirmation or available prices change", () => {
    const actualEvents = [
      buy("A", { date: "2026-10-01", signalKey: "A|2026-10-01", note: "My fill" }),
    ];
    const saved = structuredClone(actualEvents);
    const before = simulateStrategy(
      settings,
      [policySnapshot([policyEntry("pending")])],
      { A: policyBars() },
      { A: "KOSPI" },
    );
    const after = simulateStrategy(
      settings,
      [policySnapshot([policyEntry()])],
      { A: policyBars() },
      { A: "KOSPI" },
    );
    calculateActual(30000, actualEvents, before.quotes, "2026-10-07");
    calculateActual(30000, actualEvents, after.quotes, "2026-10-07");
    expect(actualEvents).toEqual(saved);
  });
});

describe("unchanged historical candidate ordering", () => {
  it.each(["KOSPI", "KOSDAQ"] as const)(
    "preserves held-signal suppression before advancing exits for %s",
    (market) => {
      const make = (previous: number, current: number, day: number) =>
        snapshot(
          [
            {
              ...entry("A"),
              ...getOperationalSignals(market, previous, current, true),
              operationalSignalVersion: LEGACY_OPERATIONAL_SIGNAL_VERSION,
              technicalPoints: current,
              scoreDelta1d: (current - previous) * 10,
            },
          ],
          day,
        );
      const model = simulateStrategy(
        settings,
        [make(7, 8, 1), make(market === "KOSPI" ? 9 : 8.5, 9.5, 3), make(7, 8, 5)],
        { A: bars(7) },
        { A: market },
      );
      expect(model.trades).toHaveLength(1);
      expect(model.candidates).toHaveLength(1);
      expect(model.trades[0]?.exitDate).toBe(date(4));
    },
  );
});

describe("confirmation candidate provenance", () => {
  it("does not invent onset candidates from general insufficient-history observations", () => {
    const unknown = policyEntry("unobservable", { originDate: null, confirmationDate: null });
    const model = simulateStrategy(
      settings,
      [policySnapshot([unknown])],
      { A: policyBars() },
      { A: "KOSPI" },
    );
    expect(model.candidates).toHaveLength(0);
    expect(model.trades).toHaveLength(0);
  });
  it("shows the October 1 pending origin as awaiting confirmation even before adoption", () => {
    const pending = policyEntry("pending", { date: "2026-10-01", confirmationDate: null });
    const model = simulateStrategy(
      settings,
      [policySnapshot([pending], "2026-10-01")],
      { A: policyBars() },
      { A: "KOSPI" },
    );
    expect(model.candidates[0]?.decision).toBe("익일 확인 대기");
    expect(model.trades).toHaveLength(0);
  });
});

describe("dated KOSPI pre-fill bear guard", () => {
  const days = ["2026-10-01", "2026-10-02", "2026-10-06", "2026-10-07", "2026-10-08"];
  const delayed = () =>
    policyBars(days).map((bar) =>
      bar.tradeDate === "2026-10-06" ? { ...bar, volume: 0, open: 0 } : bar,
    );
  it("uses the last completed session before fill and never defers rejected fills to a later bull day", () => {
    const gates = {
      "2026-10-06": kospiGate("2026-10-06", "RISK_OFF"),
      "2026-10-07": kospiGate("2026-10-07", "RISK_ON"),
    };
    const result = simulateStrategy(
      settings,
      [policySnapshot([policyEntry()])],
      { A: delayed() },
      { A: "KOSPI" },
      "",
      days,
      gates,
    );
    expect(result.trades).toHaveLength(0);
    expect(result.candidates[0]?.decision).toContain("체결 전 완료일 불황");
    expect(result.candidates[0]?.decision).toContain("2026-10-06");
    expect(result.candidates[0]?.entryDate).toBeNull();
    expect(
      simulateStrategy(
        settings,
        [policySnapshot([policyEntry()])],
        { A: delayed() },
        { A: "KOSPI" },
        "",
        days,
        gates,
      ).trades,
    ).toEqual(result.trades);
  });
  it("does not look ahead to the fill-day bear close", () => {
    const gates = {
      "2026-10-06": kospiGate("2026-10-06", "NEUTRAL"),
      "2026-10-07": kospiGate("2026-10-07", "RISK_OFF"),
    };
    const result = simulateStrategy(
      settings,
      [policySnapshot([policyEntry()])],
      { A: delayed() },
      { A: "KOSPI" },
      "",
      days,
      gates,
    );
    expect(result.trades[0]?.entryDate).toBe("2026-10-07");
  });
  it("blocks missing or stale prefill evidence instead of using a later current regime", () => {
    for (const gates of [
      {},
      { "2026-10-06": kospiGate("2026-10-02") },
      { "2026-10-06": kospiGate("2026-10-06", "UNKNOWN") },
      { "2026-10-07": kospiGate("2026-10-07") },
    ]) {
      const result = simulateStrategy(
        settings,
        [policySnapshot([policyEntry()])],
        { A: delayed() },
        { A: "KOSPI" },
        "",
        days,
        gates,
      );
      expect(result.trades).toHaveLength(0);
      expect(result.candidates[0]?.decision).toContain("시장국면 미확인");
    }
  });
  it("retains held UP95 liquidation during bear conditions", () => {
    const bought = policySnapshot([policyEntry()]);
    const exit = policySnapshot(
      [{ ...policyEntry(), kospiEntry: undefined, exitSignal: "UP95" }],
      "2026-10-06",
    );
    const result = simulateStrategy(
      settings,
      [bought, exit],
      { A: policyBars(days) },
      { A: "KOSPI" },
      "",
      days,
      { "2026-10-06": kospiGate("2026-10-06", "RISK_OFF") },
    );
    expect(result.trades[0]).toMatchObject({
      entryDate: "2026-10-06",
      exitDate: "2026-10-07",
      exitReason: "9.5점 상향돌파",
    });
  });
});

describe("KOSPI suspended candidate cancellation boundary", () => {
  it("never revives a bear-confirmation rejection after suspension and a neutral return", () => {
    const rejected = policyEntry("rejected", {
      eligible: false,
      issues: ["확인일 불황(RISK_OFF) · 신규매수 제한"],
      marketGate: {
        origin: kospiGate("2026-10-01"),
        confirmation: kospiGate("2026-10-02", "RISK_OFF"),
      },
    });
    const prices = policyBars();
    prices[2] = { ...prices[2]!, volume: 0, open: 0 };
    const result = simulateStrategy(
      settings,
      [policySnapshot([rejected])],
      { A: prices },
      { A: "KOSPI" },
      "",
      prices.map((bar) => bar.tradeDate),
      { "2026-10-06": kospiGate("2026-10-06", "NEUTRAL") },
    );
    expect(result.trades).toHaveLength(0);
    expect(result.candidates[0]?.decision).toContain("확인일 불황");
  });
  it("does not label an all-suspended waiting interval a terminal bear cancellation", () => {
    const prices = policyBars();
    prices[2] = { ...prices[2]!, volume: 0, open: 0 };
    prices[3] = { ...prices[3]!, volume: 0, open: 0 };
    const waiting = simulateStrategy(
      settings,
      [policySnapshot([policyEntry()])],
      { A: prices.slice(0, 3) },
      { A: "KOSPI" },
      "",
      prices.slice(0, 3).map((bar) => bar.tradeDate),
      { "2026-10-06": kospiGate("2026-10-06", "RISK_OFF") },
    );
    expect(waiting.trades).toHaveLength(0);
    expect(waiting.candidates[0]?.decision).toContain("대기");
    expect(waiting.candidates[0]?.decision).not.toContain("새 Onset 필요");
    prices.push({ ...prices[0]!, tradeDate: "2026-10-08" });
    const filled = simulateStrategy(
      settings,
      [policySnapshot([policyEntry()])],
      { A: prices },
      { A: "KOSPI" },
      "",
      prices.map((bar) => bar.tradeDate),
      {
        "2026-10-06": kospiGate("2026-10-06", "RISK_OFF"),
        "2026-10-07": kospiGate("2026-10-07", "NEUTRAL"),
      },
    );
    expect(filled.trades[0]?.entryDate).toBe("2026-10-08");
  });
});

it.each([true, false])(
  "cancels carried KOSDAQ entries only for observed later exits: %s",
  (observedExit) => {
    const dates = ["2026-10-12", "2026-10-13", "2026-10-14"];
    const signal = { ...entry("A"), ...getOperationalSignals("KOSDAQ", 7, 9.5, true) };
    const subsequent = {
      ...entry("A"),
      ...getOperationalSignals("KOSDAQ", 8.5, observedExit ? 9.5 : 8.4, true),
      technicalPoints: observedExit ? 9.5 : 8.4,
      scoreDelta1d: observedExit ? 10 : -1,
    };
    const snapshots = [signal, subsequent].map((e, i) => ({
      ...snapshot([e]),
      asOfDate: dates[i]!,
      date: dates[i]!,
    }));
    const prices = {
      A: dates.map(
        (d, i) =>
          ({ tradeDate: d, open: 100, close: 100, volume: i === 1 ? 0 : 100 }) as DailyPrice,
      ),
    };
    const model = simulateStrategy(
      { ...settings, roundTripCostRate: 0.003 },
      snapshots,
      prices,
      { A: "KOSDAQ" },
      "",
      dates,
      {},
      {
        version: "kr-common-execution-20261012-v1",
        startDate: "2026-10-12",
        throughDate: dates[2]!,
        scope: "KOSDAQ",
      },
    );
    expect(model.trades).toHaveLength(observedExit ? 0 : 1);
    if (observedExit)
      expect(model.candidates.some((c) => c.decision.includes("진입 취소"))).toBe(true);
  },
);

it("counts observed rows including missing closes in H60 carried-exit holding metadata", () => {
  const dates = Array.from({ length: 62 }, (_, i) =>
    new Date(Date.UTC(2026, 9, 12 + i)).toISOString().slice(0, 10),
  );
  const signal = { ...entry("A"), ...getOperationalSignals("KOSDAQ", 7, 8, true) };
  const prices = dates.map(
    (d, i) => ({ tradeDate: d, open: 100, close: i >= 60 ? 0 : 100, volume: 100 }) as DailyPrice,
  );
  const run = (throughDate: string) =>
    simulateStrategy(
      { ...settings, roundTripCostRate: 0.003 },
      [{ ...snapshot([signal]), date: dates[0]!, asOfDate: dates[0]! }],
      { A: prices },
      { A: "KOSDAQ" },
      "",
      dates,
      {},
      {
        version: "kr-common-execution-20261012-v1",
        startDate: "2026-10-12",
        throughDate,
        scope: "KOSDAQ",
      },
    );
  const result = run(dates[61]!);
  expect(run(dates[60]!).trades[0]).toMatchObject({ status: "OPEN", holdingDays: 60 });
  expect(result.trades[0]).toMatchObject({
    status: "CLOSED",
    entryDate: dates[1],
    exitDate: dates[61],
    exitReason: "60거래일 만기",
    holdingDays: 61,
  });
});
