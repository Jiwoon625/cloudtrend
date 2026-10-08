import { describe, expect, it } from "vitest";
import {
  migrateUsActual,
  changeUsActual,
  calculateUsActual,
  type UsExecution,
  type UsCandidate,
} from "./usActualLedger";
import { calculateActual } from "./portfolioLedgers";
import type { UsPortfolioTradeRecord } from "./usProspectiveCloud";
const candidate: UsCandidate = {
  key: "A|2026-09-21",
  symbol: "A",
  name: "Company A",
  date: "2026-09-21",
};
const fill = (overrides: Partial<UsExecution> = {}): UsExecution => ({
  id: "",
  symbol: "A",
  name: "A",
  market: "US",
  signalKey: candidate.key,
  side: "BUY",
  date: "2026-09-22",
  price: 100,
  shares: 10,
  fee: 1,
  order: 0,
  note: "",
  ...overrides,
});
const legacy = (overrides: Partial<UsPortfolioTradeRecord> = {}): UsPortfolioTradeRecord =>
  ({
    trade_key: "model-a",
    strategy_id: "A0_QUARTER_PRIMARY",
    signal_date: "2026-09-21",
    execution_date: "2026-09-22",
    symbol: "A",
    name: "A",
    side: "BUY",
    model_price: 100,
    model_shares: 100,
    actual_price: null,
    actual_shares: null,
    actual_fee_usd: null,
    ...overrides,
  }) as UsPortfolioTradeRecord;
describe("US actual ledger isolation", () => {
  it("does not treat positive model shares or shadow executions as actual trades", () => {
    expect(
      migrateUsActual([
        legacy(),
        legacy({ strategy_id: "A2_QUARTER_SHADOW", actual_shares: 10, actual_price: 100 }),
      ]).executions,
    ).toHaveLength(0);
  });
  it("retains explicit actual fills, actual fees and zero-share exclusions", () => {
    const model = [
      legacy({ actual_price: 101, actual_shares: 8, actual_fee_usd: 2 }),
      legacy({ trade_key: "zero", symbol: "B", actual_shares: 0 }),
    ];
    const before = JSON.stringify(model),
      doc = migrateUsActual(model);
    expect(doc.executions[0]).toMatchObject({ price: 101, shares: 8, fee: 2, market: "US" });
    expect(doc.excluded["B|2026-09-21"]).toBe("기존 미매수 · 0주");
    expect(JSON.stringify(model)).toBe(before);
  });
  it("accepts an A0 entry signal even without any model fill and preserves partial-sale cost", () => {
    const doc = migrateUsActual([]);
    changeUsActual(doc, { action: "execution", execution: fill() }, [candidate], "2026-09-28");
    changeUsActual(
      doc,
      {
        action: "execution",
        execution: fill({
          side: "SELL",
          signalKey: null,
          shares: 4,
          price: 120,
          date: "2026-09-23",
        }),
      },
      [candidate],
      "2026-09-28",
    );
    const actual = calculateActual(
      doc.capital,
      doc.executions,
      { A: { price: 110, date: "2026-09-25", exitSignal: "Beta 0.60 미만 3거래일" } },
      "2026-09-25",
    );
    expect(actual.positions[0]).toMatchObject({ market: "US", shares: 6, cost: 600.6 });
    expect(actual.summary.realizedPnl).toBe(78.6);
    expect(actual.summary.totalPnl).toBe(138);
    expect(actual.positions).toHaveLength(1);
  });
  it("preserves a zero-share correction without altering any model input", () => {
    const doc = migrateUsActual([]);
    changeUsActual(doc, { action: "execution", execution: fill() }, [candidate], "2026-09-28");
    changeUsActual(
      doc,
      {
        action: "exclude",
        executionId: doc.executions[0]!.id,
        signalKey: candidate.key,
        note: "독립성 정책",
      },
      [candidate],
      "2026-09-28",
    );
    expect(doc.executions).toHaveLength(0);
    expect(doc.excluded[candidate.key]).toBe("독립성 정책");
  });
  it("rejects overselling, unknown symbols, stale edit ids and invalid local dates", () => {
    const doc = migrateUsActual([]);
    for (const event of [
      fill({ side: "SELL" }),
      fill({ symbol: "B" }),
      fill({ id: "missing" }),
      fill({ date: "2026-02-30" }),
      fill({ date: "2026-09-29" }),
    ]) {
      expect(() =>
        changeUsActual(
          structuredClone(doc),
          { action: "execution", execution: event },
          [candidate],
          "2026-09-28",
        ),
      ).toThrow();
    }
  });
  it("separates historic Notion URLs on a clean save and rejects new pasted links without losing state", () => {
    const doc = migrateUsActual([]);
    const url = "https://notion.so/synthetic-us-source";
    const original = fill({ id: "existing", note: `원본\n${url}` });
    doc.executions = [original];
    changeUsActual(
      doc,
      { action: "execution", execution: { ...original, note: "정정" } },
      [candidate],
      "2026-09-28",
    );
    expect(original.note).toContain(url);
    expect(doc.executions[0]).toMatchObject({
      note: "정정",
      sourceLinks: [{ system: "notion", url }],
    });
    const before = structuredClone(doc);
    expect(() =>
      changeUsActual(
        doc,
        { action: "execution", execution: { ...original, note: url } },
        [candidate],
        "2026-09-28",
      ),
    ).toThrow("Notion URL");
    expect(doc).toEqual(before);
    expect(() =>
      changeUsActual(
        doc,
        { action: "exclude", executionId: original.id, signalKey: candidate.key, note: url },
        [candidate],
        "2026-09-28",
      ),
    ).toThrow("Notion URL");
    expect(doc).toEqual(before);
    changeUsActual(
      doc,
      { action: "exclude", executionId: original.id, signalKey: candidate.key, note: "미매수" },
      [candidate],
      "2026-09-28",
    );
    expect(doc.excludedSourceLinks?.[candidate.key]).toEqual([{ system: "notion", url }]);
  });
  it("uses a separate actual 30-symbol capacity without changing the US model 20-symbol rule", () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      fill({ id: String(i), symbol: String(i), order: i }),
    );
    expect(calculateActual(100000, events, {}, null).positions).toHaveLength(30);
    const reference = calculateUsActual(100000, events, {}, null);
    expect(reference.positions).toHaveLength(30);
    expect(reference.summary.slotTargetAmount).toBe(5000);
    expect({ ...reference.summary, slotTargetAmount: undefined }).toEqual({
      ...calculateActual(100000, events, {}, null).summary,
      slotTargetAmount: undefined,
    });
    expect(() =>
      calculateActual(100000, [...events, fill({ id: "31", symbol: "31", order: 31 })], {}, null),
    ).toThrow("30개");
  });
  it("uses each account's set capital over fixed 20 slots, regardless of marks and holding count", () => {
    const events = [fill({ id: "entry" })];
    const before = structuredClone(events);
    const actual = calculateUsActual(
      73551.04,
      events,
      { A: { price: 200, date: "2026-10-07", exitSignal: null } },
      "2026-10-07",
    );
    expect(actual.summary.slotTargetAmount).toBe(3677.552);
    expect(actual.summary.equity).not.toBe(73551.04);
    expect(events).toEqual(before);
    expect(calculateUsActual(20000, [], {}, null).summary.slotTargetAmount).toBe(1000);
  });
});
