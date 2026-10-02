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
import {
  KOSPI_ENTRY_POLICY,
  PREVIOUS_KOSPI_ENTRY_POLICY_VERSION,
  type KospiEntrySnapshot,
} from "./engine/kospiEntryConfirmation";
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

const policyEntry = (
  state: KospiEntrySnapshot["state"] = "confirmed",
  changes: Partial<KospiEntrySnapshot> = {},
): SnapshotEntry => ({
  ...entry("A"),
  kospi80Onset: state === "pending",
  operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
  kospiEntry: {
    version: KOSPI_ENTRY_POLICY.version,
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

describe("new confirmation UP95 never becomes a pre-entry liquidation", () => {
  const up95 = {
    ...policyEntry("confirmed", { score: 9.5 }),
    technicalPoints: 9.5,
    scoreDelta1d: 15,
    exitSignal: "UP95" as const,
  };
  it("fills once at next open, keeps the new holding open and dates exit evidence separately from the mark", () => {
    const input = [policySnapshot([up95]), policySnapshot([up95], "2026-10-02", "10:00:00Z")];
    const model = simulateStrategy(settings, input, { A: policyBars() }, { A: "KOSPI" });
    expect(model.trades).toHaveLength(1);
    expect(model.trades[0]).toMatchObject({
      entryDate: "2026-10-06",
      status: "OPEN",
      exitDate: null,
      currentStatus: "전략 보유",
    });
    expect(model.quotes["A"]).toMatchObject({
      date: "2026-10-07",
      exitSignal: "UP95",
      exitSignalDate: "2026-10-02",
    });
    expect(simulateStrategy(settings, input, { A: policyBars() }, { A: "KOSPI" }).trades).toEqual(
      model.trades,
    );
    const actualNew = calculateActual(
      30000,
      [buy("A", { date: "2026-10-06" })],
      model.quotes,
      "2026-10-07",
    );
    expect(actualNew.positions[0]?.exitSignal).toBeNull();
    const actualHeld = calculateActual(
      30000,
      [buy("A", { date: "2026-10-01" })],
      model.quotes,
      "2026-10-07",
    );
    expect(actualHeld.positions[0]?.exitSignal).toBe("UP95");
  });
  it("does not sell on a persistent upper score, but a later new upward cross still exits", () => {
    const flat = policySnapshot(
      [
        {
          ...entry("A"),
          ...getOperationalSignals("KOSPI", 9.5, 10, true),
          technicalPoints: 10,
          scoreDelta1d: 5,
        },
      ],
      "2026-10-06",
    );
    const input = [policySnapshot([up95]), flat];
    expect(
      simulateStrategy(settings, input, { A: policyBars() }, { A: "KOSPI" }).trades[0]?.status,
    ).toBe("OPEN");
    const later = policySnapshot(
      [
        {
          ...entry("A"),
          ...getOperationalSignals("KOSPI", 9, 9.5, true),
          technicalPoints: 9.5,
          scoreDelta1d: 5,
        },
      ],
      "2026-10-07",
    );
    const result = simulateStrategy(
      settings,
      [...input, later],
      { A: policyBars(["2026-10-01", "2026-10-02", "2026-10-06", "2026-10-07", "2026-10-08"]) },
      { A: "KOSPI" },
    );
    expect(result.trades[0]).toMatchObject({
      status: "CLOSED",
      exitDate: "2026-10-08",
      exitReason: "9.5점 상향돌파",
    });
  });
  it("exits an existing holding without creating a second trade from the same confirmation", () => {
    const initial = policySnapshot([entry("A")], "2026-09-28");
    const model = simulateStrategy(
      settings,
      [initial, policySnapshot([up95])],
      { A: policyBars(["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02", "2026-10-06"]) },
      { A: "KOSPI" },
    );
    expect(model.trades).toHaveLength(1);
    expect(model.trades[0]).toMatchObject({
      entryDate: "2026-09-29",
      exitDate: "2026-10-06",
      status: "CLOSED",
    });
    expect(model.candidates.find((c) => c.originDate === "2026-10-01")?.decision).toContain(
      "보유/당일 매도",
    );
  });
});

describe("v2 snapshot compatibility without historical upgrade", () => {
  it("keeps valid previous confirmations in replay and leaves old rejections unfilled", () => {
    const old = {
      ...policyEntry("confirmed", { version: PREVIOUS_KOSPI_ENTRY_POLICY_VERSION }),
      operationalSignalVersion: PREVIOUS_KOSPI_ENTRY_POLICY_VERSION,
    };
    const input = [policySnapshot([old])];
    const saved = JSON.stringify(input);
    const model = simulateStrategy(settings, input, { A: policyBars() }, { A: "KOSPI" });
    expect(model.trades[0]).toMatchObject({ entryDate: "2026-10-06", status: "OPEN" });
    const rejected = {
      ...old,
      exitSignal: "UP95" as const,
      kospiEntry: {
        ...old.kospiEntry!,
        state: "rejected" as const,
        eligible: false,
        score: 9.5,
        issues: ["확인일 U9.5 청산신호"],
      },
    };
    expect(
      simulateStrategy(settings, [policySnapshot([rejected])], { A: policyBars() }, { A: "KOSPI" })
        .trades,
    ).toHaveLength(0);
    expect(JSON.stringify(input)).toBe(saved);
  });
});
