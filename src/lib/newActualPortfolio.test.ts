import { describe, expect, it } from "vitest";
import { ACTUAL_PERFORMANCE_SERIES } from "./ledger/actualPerformance";
import { decimal, representedLegacyNumber } from "./ledger/decimal";
import type { Quote } from "./portfolioLedgers";
import {
  emptyNewActualMetadata,
  newActualAsset,
  projectNewActualPool,
  validateNewActualMetadata,
  type NewActualAssignment,
  type NewActualCashEvent,
  type NewActualExecution,
  type NewActualMetadata,
} from "./newActualPortfolio";

// Every trade, reference, amount and date below is a synthetic test fixture.
const start = "2026-10-12",
  today = "2026-10-20";
function execution(id: string, changes: Partial<NewActualExecution> = {}): NewActualExecution {
  return {
    id,
    symbol: "SYNTH",
    name: "Synthetic holding",
    market: "KOSPI",
    signalKey: null,
    side: "BUY",
    date: start,
    price: 10,
    shares: 2,
    fee: 0.2,
    note: "",
    order: 0,
    ...changes,
  };
}
function assignment(
  fill: NewActualExecution,
  changes: Partial<NewActualAssignment> = {},
): NewActualAssignment {
  return {
    executionId: fill.id,
    quantity: fill.shares,
    gross: Number(representedLegacyNumber(fill.price * fill.shares)),
    fee: fill.fee,
    brokerReference: `synthetic-broker-${fill.id}`,
    ...changes,
  };
}
function cashEvent(id = "opening", changes: Partial<NewActualCashEvent> = {}): NewActualCashEvent {
  return {
    id,
    date: start,
    kind: "DEPOSIT",
    amount: 1000,
    reference: `synthetic-cash-${id}`,
    ...changes,
  };
}
function metadata(
  fills: NewActualExecution[] = [],
  events: NewActualCashEvent[] = [cashEvent()],
): NewActualMetadata {
  return {
    ...emptyNewActualMetadata(),
    assignments: Object.fromEntries(fills.map((fill) => [fill.id, assignment(fill)])),
    cashEvents: events,
  };
}
function project(
  fills: NewActualExecution[] = [],
  meta: NewActualMetadata = metadata(fills),
  options: Partial<Parameters<typeof projectNewActualPool>[0]> = {},
) {
  return projectNewActualPool({
    currency: "KRW",
    executions: fills,
    metadata: meta,
    quotes: { "KOSPI:SYNTH": { price: 15, date: today, exitSignal: null } },
    valuationDate: today,
    today,
    ...options,
  });
}

describe("explicit post-start actual allocation", () => {
  it("defaults to an empty identified slice without capital or a historical import", () => {
    const old = execution("legacy", { date: "2026-10-09", shares: 100 });
    const result = project([old], emptyNewActualMetadata(), { metadata: undefined });
    expect(emptyNewActualMetadata()).toEqual({
      version: 1,
      seriesId: ACTUAL_PERFORMANCE_SERIES,
      assignments: {},
      cashEvents: [],
      audit: [],
    });
    expect(result).toMatchObject({
      fundingStatus: "PENDING",
      cash: null,
      nav: null,
      totalPnl: null,
      returnPercent: null,
      netContributions: null,
      realizedPnl: "0",
      positions: [],
      trades: [],
    });
    expect(result.issues).toContain("funding_pending");
  });

  it("isolates new same-ticker holdings and omits an unassigned old sale after the start", () => {
    const oldBuy = execution("old-buy", { date: "2026-10-09", shares: 100 });
    const oldSale = execution("old-sell", {
      date: "2026-10-13",
      side: "SELL",
      shares: 99,
      price: 20,
    });
    const buy = execution("new-buy");
    const sell = execution("new-sell", {
      date: "2026-10-14",
      side: "SELL",
      shares: 1,
      price: 12,
      fee: 0.1,
    });
    const result = project([oldBuy, oldSale, buy, sell], metadata([buy, sell]));
    expect(result.trades.map(({ execution }) => execution.id)).toEqual(["new-buy", "new-sell"]);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toMatchObject({
      quantity: "1",
      cost: "10.1",
      averagePrice: "10.1",
      marketValue: "15",
      unrealizedPnl: "4.9",
    });
    expect(result).toMatchObject({
      cash: "991.7",
      nav: "1006.7",
      realizedPnl: "1.8",
      unrealizedPnl: "4.9",
      totalPnl: "6.7",
      returnPercent: "0.67",
    });
  });

  it("retains trades, positions and realized profit while opening funding is pending", () => {
    const buy = execution("new-buy");
    const sell = execution("new-sell", {
      date: "2026-10-13",
      side: "SELL",
      shares: 1,
      price: 12,
      fee: 0.1,
    });
    const result = project([buy, sell], metadata([buy, sell], []));
    expect(result).toMatchObject({
      fundingStatus: "PENDING",
      cash: null,
      nav: null,
      totalPnl: null,
      returnPercent: null,
      realizedPnl: "1.8",
      marketValue: "15",
      unrealizedPnl: "4.9",
    });
    expect(result.trades).toHaveLength(2);
    expect(result.positions[0]!.quantity).toBe("1");
    expect(result.issues).toEqual(["funding_pending"]);
  });

  it("rejects an allocated sell that can be covered only by old holdings", () => {
    const old = execution("old", { date: "2026-10-09", shares: 100 });
    const buy = execution("new");
    const sell = execution("oversell", { date: "2026-10-13", side: "SELL", shares: 3 });
    expect(() => project([old, buy, sell], metadata([buy, sell]))).toThrow(/new-slice holdings/);
    expect(() => project([old, sell], metadata([sell]))).toThrow(/new-slice holdings/);
  });

  it("requires explicit mixed-fill gross and fee without automatically allocating by price", () => {
    const mixed = execution("mixed", { shares: 100, fee: 1 });
    const meta = metadata([mixed]);
    meta.assignments[mixed.id] = assignment(mixed, { quantity: 2, gross: 19.99, fee: 0.02 });
    const result = project([mixed], meta);
    expect(result.positions[0]).toMatchObject({
      quantity: "2",
      cost: "20.01",
      averagePrice: "10.005",
    });
    expect(result.cash).toBe("979.99");
    expect(result.trades[0]!.allocation.gross).toBe(19.99);
    expect(result.trades[0]!.execution.shares).toBe(100);
  });

  it("does not mutate canonical fills or metadata and returns detached records", () => {
    const buy = execution("buy");
    const meta = metadata([buy]);
    const before = structuredClone({ buy, meta });
    const result = project([buy], meta);
    result.trades[0]!.execution.price = 999;
    result.trades[0]!.allocation.quantity = 999;
    result.cashEvents[0]!.amount = 999;
    expect({ buy, meta }).toEqual(before);
  });
});

describe("currency pools and exact weighted costs", () => {
  it("shares domestic and ETF cash, but not security marks with the same symbol", () => {
    const kr = execution("kr", { shares: 10, fee: 1 });
    const etf = execution("etf", { market: "ETF", shares: 2, price: 20, fee: 0.5 });
    const quotes: Record<string, Quote> = {
      "KOSPI:SYNTH": { price: 12, date: today, exitSignal: null },
      "ETF:SYNTH": { price: 25, date: today, exitSignal: null },
      SYNTH: { price: 999, date: today, exitSignal: null },
    };
    const result = project([etf, kr], metadata([kr, etf]), { quotes });
    expect(result).toMatchObject({
      currency: "KRW",
      cash: "858.5",
      marketValue: "170",
      nav: "1028.5",
      totalPnl: "28.5",
      returnPercent: "2.85",
    });
    expect(result.positions.map(({ asset, marketValue }) => [asset, marketValue])).toEqual([
      ["ETF", "50"],
      ["KR", "120"],
    ]);
    expect(newActualAsset("KOSDAQ")).toBe("KR");
  });

  it("keeps US totals in USD without using a KRW mark or conversion", () => {
    const us = execution("us", { market: "US" });
    const result = project([us], metadata([us]), {
      currency: "USD",
      quotes: { "US:SYNTH": { price: 15, date: today, exitSignal: null } },
    });
    expect(result).toMatchObject({
      currency: "USD",
      cash: "979.8",
      nav: "1009.8",
      totalPnl: "9.8",
    });
    expect(result.positions[0]!.asset).toBe("US");
    expect(() => project([us], metadata([us]))).toThrow(/currency pool/);
  });

  it("conserves the final 8dp cost residual through repeated partial sales and a full exit", () => {
    const buy = execution("buy", { shares: 3, price: 0.33333333, fee: 0.00000001 });
    const sells = [1, 2, 3].map((i) =>
      execution(`sell-${i}`, {
        date: "2026-10-13",
        order: i,
        shares: 1,
        price: 0.5,
        fee: 0,
        side: "SELL",
      }),
    );
    const partial = project([buy, sells[0]!], metadata([buy, sells[0]!]));
    expect(partial.positions[0]).toMatchObject({ quantity: "2", cost: "0.66666667" });
    expect(partial.realizedPnl).toBe("0.16666667");
    const result = project([sells[2]!, buy, sells[0]!, sells[1]!], metadata([buy, ...sells]));
    expect(result.trades.slice(1).map(({ realizedPnl }) => realizedPnl)).toEqual([
      "0.16666667",
      "0.16666667",
      "0.16666666",
    ]);
    expect(result).toMatchObject({
      positions: [],
      realizedPnl: "0.5",
      marketValue: "0",
      cash: "1000.5",
      nav: "1000.5",
      totalPnl: "0.5",
    });
  });

  it("uses weighted new-only cost over multiple buys and includes all fees", () => {
    const first = execution("first", { shares: 2, price: 10, fee: 0.2 });
    const second = execution("second", { shares: 2, price: 20, fee: 0.2, order: 1 });
    const sell = execution("sell", { shares: 1, price: 18, fee: 0.1, side: "SELL", order: 2 });
    const result = project([first, second, sell]);
    expect(result.positions[0]).toMatchObject({
      quantity: "3",
      cost: "45.3",
      averagePrice: "15.1",
    });
    expect(result.realizedPnl).toBe("2.8");
    expect(result.cash).toBe("957.5");
  });

  it("accepts the represented legacy product rather than a floating point multiplication artifact", () => {
    const buy = execution("fractional", { shares: 3, price: 0.1, fee: 0 });
    expect(buy.price * buy.shares).not.toBe(0.3);
    expect(project([buy]).positions[0]!.cost).toBe("0.3");
  });
});

describe("funding and cash events", () => {
  it("retains a real buy even when confirmed funding is too small", () => {
    const buy = execution("buy");
    const result = project([buy], metadata([buy], [cashEvent("small", { amount: 5 })]));
    expect(result).toMatchObject({
      fundingStatus: "INCOMPLETE",
      cash: null,
      nav: null,
      totalPnl: null,
      returnPercent: null,
      netContributions: "5",
    });
    expect(result.positions).toHaveLength(1);
    expect(result.trades).toHaveLength(1);
    expect(result.issues).toContain("funding_shortfall");
  });

  it("checks historical closing balances without claiming intraday buying power", () => {
    const buy = execution("buy");
    expect(
      project([buy], metadata([buy], [cashEvent("same-day", { amount: 30 })])).fundingStatus,
    ).toBe("CONFIRMED");
    const result = project(
      [buy],
      metadata([buy], [cashEvent("late", { date: "2026-10-13", amount: 30 })]),
    );
    expect(result.fundingStatus).toBe("INCOMPLETE");
    expect(result.cash).toBeNull();
    expect(result.issues).toContain("funding_shortfall");
    expect(result.issues).toContain("flow_adjusted_return_pending");
  });

  it("accounts for income, cash expenses and external flows separately", () => {
    const events = [
      cashEvent(),
      cashEvent("dividend", { kind: "DIVIDEND", amount: 5 }),
      cashEvent("interest", { kind: "INTEREST", amount: 1.5 }),
      cashEvent("fee", { kind: "FEE", amount: 0.2 }),
      cashEvent("tax", { kind: "TAX", amount: 0.8 }),
    ];
    expect(project([], metadata([], events))).toMatchObject({
      netContributions: "1000",
      cash: "1005.5",
      nav: "1005.5",
      totalPnl: "5.5",
      returnPercent: "0.55",
    });
    const result = project(
      [],
      metadata([], [...events, cashEvent("withdrawal", { kind: "WITHDRAWAL", amount: 100 })]),
    );
    expect(result).toMatchObject({
      netContributions: "900",
      cash: "905.5",
      totalPnl: "5.5",
      returnPercent: null,
    });
    expect(result.issues).toContain("flow_adjusted_return_pending");
  });

  it("does not publish a simple return after multiple deposits", () => {
    const result = project(
      [],
      metadata([], [cashEvent(), cashEvent("more", { date: "2026-10-13", amount: 50 })]),
    );
    expect(result).toMatchObject({ cash: "1050", nav: "1050", totalPnl: "0", returnPercent: null });
    expect(result.issues).toContain("flow_adjusted_return_pending");
  });

  it("retains voided evidence while removing its financial effect and allowing a replacement reference", () => {
    const original = cashEvent("original", { voided: true });
    const correction = cashEvent("corrected", { amount: 800, reference: original.reference });
    const result = project([], metadata([], [correction, original]));
    expect(result).toMatchObject({ netContributions: "800", cash: "800", returnPercent: "0" });
    expect(result.cashEvents).toHaveLength(2);
    expect(project([], metadata([], [original])).fundingStatus).toBe("PENDING");
  });

  it("sorts cash facts by date without changing their stored order", () => {
    const events = [
      cashEvent("later", { date: "2026-10-13", kind: "INTEREST", amount: 1 }),
      cashEvent(),
    ];
    const result = project([], metadata([], events));
    expect(result.cashEvents.map(({ id }) => id)).toEqual(["opening", "later"]);
    expect(events[0]!.id).toBe("later");
  });
});

describe("dated valuation marks", () => {
  const buy = execution("buy");
  it.each([
    ["missing", {}, "missing_price"],
    ["plain ticker only", { SYNTH: { price: 15, date: today, exitSignal: null } }, "missing_price"],
    [
      "stale",
      { "KOSPI:SYNTH": { price: 15, date: "2026-10-19", exitSignal: null } },
      "stale_price",
    ],
    [
      "future",
      { "KOSPI:SYNTH": { price: 15, date: "2026-10-21", exitSignal: null } },
      "future_price",
    ],
    [
      "before fill",
      { "KOSPI:SYNTH": { price: 15, date: "2026-10-09", exitSignal: null } },
      "price_before_last_fill",
    ],
    ["zero price", { "KOSPI:SYNTH": { price: 0, date: today, exitSignal: null } }, "invalid_price"],
    [
      "NaN price",
      { "KOSPI:SYNTH": { price: NaN, date: today, exitSignal: null } },
      "invalid_price",
    ],
  ] as [string, Record<string, Quote>, string][])(
    "suppresses totals for %s marks without using the fill price",
    (_label, quotes, issue) => {
      const result = project([buy], metadata([buy]), { quotes });
      expect(result).toMatchObject({
        fundingStatus: "CONFIRMED",
        cash: "979.8",
        marketValue: null,
        nav: null,
        unrealizedPnl: null,
        totalPnl: null,
        returnPercent: null,
      });
      expect(result.positions[0]).toMatchObject({
        currentPrice: null,
        priceDate: null,
        marketValue: null,
      });
      expect(result.issues).toContain(issue);
    },
  );

  it("requires an explicit nonfuture valuation date and accepts only its exact mark", () => {
    expect(project([buy], metadata([buy]), { valuationDate: null }).issues).toContain(
      "valuation_date_missing",
    );
    expect(project([buy], metadata([buy]), { valuationDate: "2026-10-21" }).issues).toContain(
      "future_valuation_date",
    );
    expect(project([buy], metadata([buy]), { valuationDate: "2026-10-19" }).issues).toContain(
      "future_price",
    );
  });

  it("requires the mark to be at least as recent as a later partial fill", () => {
    const sell = execution("sell", { side: "SELL", shares: 1, date: "2026-10-19" });
    const result = project([buy, sell], metadata([buy, sell]), {
      valuationDate: "2026-10-18",
      quotes: { "KOSPI:SYNTH": { price: 15, date: "2026-10-18", exitSignal: null } },
    });
    expect(result.issues).toContain("price_before_last_fill");
    expect(result.nav).toBeNull();
  });

  it("suppresses aggregate value if only one of several open holdings is unmarked", () => {
    const other = execution("other", { symbol: "UNMARKED" });
    const result = project([buy, other]);
    expect(result.positions.find(({ symbol }) => symbol === "SYNTH")!.marketValue).toBe("30");
    expect(result.marketValue).toBeNull();
    expect(result.unrealizedPnl).toBeNull();
  });

  it("does not combine a prior-session holding mark with a later cash event", () => {
    const result = project(
      [buy],
      metadata(
        [buy],
        [
          cashEvent(),
          cashEvent("income", {
            date: today,
            kind: "DIVIDEND",
            amount: 1,
          }),
        ],
      ),
      {
        valuationDate: "2026-10-19",
        quotes: {
          "KOSPI:SYNTH": { price: 15, date: "2026-10-19", exitSignal: null },
        },
      },
    );
    expect(result.positions[0]).toMatchObject({ currentPrice: "15", priceDate: "2026-10-19" });
    expect(result).toMatchObject({
      cash: "980.8",
      nav: null,
      marketValue: null,
      unrealizedPnl: null,
      totalPnl: null,
      returnPercent: null,
    });
    expect(result.issues).toContain("stale_price");
  });
});

describe("fail-closed identity, corrections and cancellation", () => {
  it("rejects a wrong series/version and malformed sidecar containers", () => {
    for (const change of [
      { version: 2 },
      { seriesId: "legacy" },
      { assignments: [] },
      { cashEvents: null },
      { audit: {} },
    ]) {
      const meta = { ...emptyNewActualMetadata(), ...change } as unknown as NewActualMetadata;
      expect(() => project([], meta)).toThrow(/metadata identity/);
    }
  });

  it("rejects duplicate raw IDs even if both legacy records are unassigned", () => {
    const old = execution("duplicate", { date: "2026-10-09" });
    expect(() => project([old, { ...old }], emptyNewActualMetadata())).toThrow(
      /canonical execution identity/,
    );
  });

  it("rejects orphan, key-mismatched and duplicate broker allocations", () => {
    const a = execution("a"),
      b = execution("b");
    expect(() => project([], metadata([a]))).toThrow(/Orphan/);
    const mismatch = metadata([a]);
    mismatch.assignments["a"]!.executionId = "b";
    expect(() => project([a, b], mismatch)).toThrow(/identity mismatch/);
    const duplicate = metadata([a, b]);
    duplicate.assignments["b"]!.brokerReference =
      ` ${duplicate.assignments["a"]!.brokerReference} `;
    expect(() => project([a, b], duplicate)).toThrow(/Duplicate active allocation/);
  });

  it.each(["2026-10-09", "2026-10-21", "2026-02-30"])(
    "rejects assigned invalid boundary date %s",
    (date) => {
      const fill = execution("date", { date });
      expect(() => project([fill])).toThrow(/pre-start\/future/);
    },
  );

  it("rejects over-allocation, missing references and unrepresentable amounts", () => {
    const buy = execution("buy");
    for (const change of [
      { quantity: 3 },
      { gross: 20.01 },
      { fee: 0.21 },
      { quantity: 0 },
      { gross: 0 },
      { fee: -1 },
      { brokerReference: " " },
      { gross: 0.000000001 },
      { quantity: NaN },
    ]) {
      const meta = metadata([buy]);
      meta.assignments[buy.id] = assignment(buy, change);
      expect(() => project([buy], meta)).toThrow();
    }
  });

  it("requires complete gross and fees when all shares are assigned", () => {
    const buy = execution("buy");
    for (const change of [{ gross: 19.99 }, { fee: 0.19 }]) {
      const meta = metadata([buy]);
      meta.assignments[buy.id] = assignment(buy, change);
      expect(() => project([buy], meta)).toThrow(/exact canonical gross and all fees/);
    }
  });

  it("recomputes new corrections from canonical fills and detects unreconciled full allocation changes", () => {
    const original = execution("buy");
    const corrected = { ...original, price: 12, fee: 0.3 };
    expect(() => project([corrected], metadata([original]))).toThrow(/exact canonical/);
    const result = project([corrected], metadata([corrected]));
    expect(result.positions[0]!.cost).toBe("24.3");
    expect(result.cash).toBe("975.7");
    expect(result.trades[0]!.execution.price).toBe(12);
  });

  it("removes only a cancelled assignment, preserves its raw record, and blocks an unsupported remaining sale", () => {
    const buy = execution("buy");
    const result = project([buy], metadata([]));
    expect(result).toMatchObject({ trades: [], positions: [], cash: "1000", totalPnl: "0" });
    const sell = execution("sell", { side: "SELL", shares: 1, date: "2026-10-13" });
    expect(() => project([buy, sell], metadata([sell]))).toThrow(/new-slice holdings/);
  });

  it("rejects duplicate cash identities/references and invalid dated amounts", () => {
    const duplicateId = [cashEvent(), cashEvent("opening", { voided: true })];
    expect(() => project([], metadata([], duplicateId))).toThrow(
      /Duplicate new actual cash event identity/,
    );
    const duplicateReference = [
      cashEvent(),
      cashEvent("other", { reference: cashEvent().reference }),
    ];
    expect(() => project([], metadata([], duplicateReference))).toThrow(
      /Duplicate active cash event reference/,
    );
    for (const changes of [
      { amount: 0 },
      { amount: -1 },
      { amount: Infinity },
      { date: "2026-10-09" },
      { date: "2026-10-21" },
      { date: "2026-02-30" },
      { reference: "" },
    ]) {
      expect(() => project([], metadata([], [cashEvent("invalid", changes)]))).toThrow();
    }
  });

  it("validates audit identity while retaining before/after cancellation evidence", () => {
    const old = cashEvent();
    const meta = metadata([], [{ ...old, voided: true }]);
    meta.audit.push({
      requestId: "synthetic-request",
      fingerprint: "synthetic-fingerprint",
      action: "void-cash",
      recordedAt: "2026-10-13T10:00:00Z",
      targetId: old.id,
      reason: "Synthetic correction",
      before: { cashEvent: old },
      after: { cashEvent: { ...old, voided: true } },
    });
    expect(() => validateNewActualMetadata(meta)).not.toThrow();
    expect(project([], meta).fundingStatus).toBe("PENDING");
    meta.audit.push(structuredClone(meta.audit[0]!));
    expect(() => project([], meta)).toThrow(/audit identity/);
  });

  it("maintains the accounting identity for a fully marked slice", () => {
    const buy = execution("buy");
    const sell = execution("sell", {
      side: "SELL",
      shares: 1,
      price: 12,
      fee: 0.1,
      date: "2026-10-13",
    });
    const result = project(
      [buy, sell],
      metadata(
        [buy, sell],
        [cashEvent(), cashEvent("dividend", { kind: "DIVIDEND", amount: 0.5 })],
      ),
    );
    expect(decimal(result.nav!) - decimal(result.netContributions!)).toBe(
      decimal(result.totalPnl!),
    );
    expect(decimal(result.realizedPnl) + decimal(result.unrealizedPnl!) + decimal("0.5")).toBe(
      decimal(result.totalPnl!),
    );
  });
});
