import { describe, expect, it } from "vitest";
import { calculateActual, type ActualExecution } from "../portfolioLedgers";
import {
  ACTUAL_PERFORMANCE_SERIES,
  ACTUAL_PERFORMANCE_START,
  actualPerformanceView,
  appendActualPerformanceObservation,
  confirmActualPerformanceBaseline,
  pendingActualPerformance,
  type ActualPerformanceSeries,
  type PerformanceBaseline,
  type PerformanceFlow,
  type PerformanceObservation,
  type PerformanceSnapshot,
  type TradeAllocation,
  type CashAdjustment,
} from "./actualPerformance";
import { decimal, format, multiply } from "./decimal";
import type { FxMark, SourceRef } from "./types";
import type { AccountValuation } from "./valuation";

// Every account, amount, source identity, mark, and execution below is a synthetic fixture.
const start = ACTUAL_PERFORMANCE_START;
const source: SourceRef = {
  system: "broker",
  recordId: "synthetic-performance-source",
  revision: "1",
  contentHash: `sha256:${"d".repeat(64)}`,
};
const recordedAt = "2026-10-12T23:00:00Z";

function account(cash = "1000", overrides: Partial<AccountValuation> = {}): AccountValuation {
  return {
    accountId: "synthetic-account-a",
    currency: "KRW",
    cash,
    knownCashDelta: "0",
    unsettledCash: "0",
    positions: [],
    equity: cash,
    issues: [],
    ...overrides,
  };
}

function position(
  overrides: Partial<AccountValuation["positions"][number]> = {},
): AccountValuation["positions"][number] {
  return {
    securityId: "synthetic-security-a",
    quantity: "2",
    knownQuantityDelta: "0",
    costBasis: "160",
    marketValue: "200",
    priceDate: start,
    ...overrides,
  };
}

function snapshot(
  cash = "1000",
  overrides: Partial<PerformanceSnapshot> = {},
): PerformanceSnapshot {
  return {
    date: start,
    recordedAt: `${overrides.date ?? start}T23:00:00Z`,
    source,
    accounts: [account(cash)],
    fx: [],
    complete: true,
    ...overrides,
  };
}

function baseline(
  accounts = [account()],
  overrides: Partial<PerformanceBaseline> = {},
): PerformanceBaseline {
  return {
    scope: "POST_START_ALLOCATED_CAPITAL",
    baseCurrency: "KRW",
    scopeConfirmed: true,
    accountScope: accounts.map(({ accountId, currency }) => ({ accountId, currency })),
    pricePolicy: "EXPLICIT_DATED_MARKS_BEFORE_START",
    valuation: snapshot("1000", {
      accounts,
      requiredPriceDates: { KRW: "2026-10-09", USD: "2026-10-09" },
    }),
    confirmedAt: recordedAt,
    sourceRevisions: { domestic: 1, us: 1 },
    betaArchive: {
      asOfDate: "2026-10-09",
      source,
      summaries: { syntheticAllTimePnl: "42" },
    },
    ...overrides,
  };
}

function confirmed(value = baseline()): ActualPerformanceSeries {
  return confirmActualPerformanceBaseline(pendingActualPerformance(), value);
}

function observation(
  cash = "1000",
  overrides: Partial<PerformanceObservation> = {},
): PerformanceObservation {
  return {
    valuation: snapshot(cash),
    previousDate: start,
    intervalComplete: true,
    flowsComplete: true,
    flows: [],
    allocationConfirmed: true,
    tradeAllocations: [],
    cashAdjustments: [],
    ...overrides,
  };
}

function flow(amount: string, overrides: Partial<PerformanceFlow> = {}): PerformanceFlow {
  return {
    id: "synthetic-flow-a",
    date: start,
    kind: decimal(amount) > 0n ? "DEPOSIT" : "WITHDRAWAL",
    timing: "END",
    legs: [{ accountId: "synthetic-account-a", currency: "KRW", amount }],
    fx: [],
    source,
    ...overrides,
  };
}

function fx(rate = "100", date: string = start): FxMark {
  return {
    base: "USD",
    quote: "KRW",
    date,
    rate,
    source: "synthetic-fx-source",
    verified: true,
    availableAt: `${date}T20:00:00Z`,
  };
}

function adjustment(amount: string, overrides: Partial<CashAdjustment> = {}): CashAdjustment {
  return {
    id: "synthetic-adjustment-a",
    date: start,
    accountId: "synthetic-account-a",
    currency: "KRW",
    amount,
    kind: decimal(amount) > 0n ? "INTEREST" : "FEE",
    source,
    ...overrides,
  };
}

function trade(overrides: Partial<TradeAllocation> = {}): TradeAllocation {
  return {
    sourceSystem: "portfolio_ledgers",
    executionId: "synthetic-new-buy",
    date: start,
    order: 0,
    accountId: "synthetic-account-a",
    currency: "KRW",
    securityId: "synthetic-security-a",
    side: "BUY",
    quantity: "2",
    price: "100",
    gross: format(multiply(decimal(overrides.quantity ?? "2"), decimal(overrides.price ?? "100"))),
    fee: "0",
    source,
    ...overrides,
  };
}

function view(point: PerformanceObservation, series = confirmed()) {
  return actualPerformanceView(appendActualPerformanceObservation(series, point));
}

describe("ACTUAL restart baseline evidence", () => {
  it("keeps all performance amounts unavailable until an explicit baseline exists", () => {
    const pending = pendingActualPerformance();
    expect(pending).toEqual({
      id: ACTUAL_PERFORMANCE_SERIES,
      startDate: start,
      baseline: null,
      observations: [],
    });
    for (const input of [undefined, null, pending]) {
      expect(actualPerformanceView(input)).toMatchObject({
        status: "PENDING_BASELINE",
        baseCurrency: null,
        baselineNav: null,
        latestNav: null,
        totalPnl: null,
        returnPercent: null,
        points: [],
      });
    }
    expect(() => appendActualPerformanceObservation(pending, observation())).toThrow(/baseline/i);
  });

  it("does not fabricate a performance observation when only the opening is confirmed", () => {
    expect(actualPerformanceView(confirmed())).toMatchObject({
      status: "WAITING_OBSERVATION",
      baselineNav: "1000",
      latestNav: null,
      totalPnl: null,
      returnPercent: null,
      points: [],
    });
  });

  it("requires complete positive actual opening evidence", () => {
    for (const valuation of [
      snapshot("1000", { complete: false }),
      snapshot("0"),
      snapshot("-1"),
      snapshot("1000", { accounts: [] }),
      snapshot("1000", { accounts: [account("1000", { cash: null })] }),
      snapshot("1000", { accounts: [account("1000", { unsettledCash: null })] }),
      snapshot("1000", { accounts: [account("1000", { equity: null })] }),
    ]) {
      expect(() => confirmed(baseline(valuation.accounts, { valuation }))).toThrow();
    }
  });

  it("rejects configured-capital and MODEL sources as opening evidence", () => {
    for (const system of ["model", "portfolio_ledgers", "us_actual_portfolio_ledgers"] as const) {
      expect(() =>
        confirmed(
          baseline(undefined, { valuation: snapshot("1000", { source: { ...source, system } }) }),
        ),
      ).toThrow(/evidence/i);
    }
  });

  it("requires explicitly confirmed scope and rejects unassigned accounts", () => {
    expect(() => confirmed(baseline(undefined, { scopeConfirmed: false }))).toThrow(/scope/i);
    expect(() => confirmed(baseline(undefined, { accountScope: [] }))).toThrow(/scope/i);
    expect(() =>
      confirmed(baseline([account("1000", { accountId: "UNASSIGNED:synthetic" })])),
    ).toThrow(/mapping|account|scope/i);
  });

  it("requires baseline valuations to cover every explicitly reviewed cash pool", () => {
    const accounts = [account(), account("500", { accountId: "synthetic-account-b" })];
    expect(() => confirmed(baseline(accounts, { valuation: snapshot() }))).toThrow(/scope/i);
  });

  it("requires both named source revisions rather than accepting an empty audit binding", () => {
    for (const sourceRevisions of [{}, { domestic: 1 }, { us: 1 }]) {
      expect(() =>
        confirmed(
          baseline(undefined, {
            sourceRevisions: sourceRevisions as PerformanceBaseline["sourceRevisions"],
          }),
        ),
      ).toThrow(/revision/i);
    }
  });

  it("rejects shared cash counted twice, including identical copies", () => {
    const shared = account();
    const accountScope = [{ accountId: shared.accountId, currency: shared.currency }];
    expect(() => confirmed(baseline([shared, structuredClone(shared)], { accountScope }))).toThrow(
      /duplicate.*cash pool/i,
    );
    expect(() => confirmed(baseline([shared, account("1200")], { accountScope }))).toThrow(
      /duplicate.*cash pool/i,
    );
  });

  it("recomputes equity and refuses a contradictory supplied total", () => {
    expect(() => confirmed(baseline([account("1000", { equity: "1100" })]))).toThrow(/equity/i);
  });

  it("excludes every opening holding even when its quantity, basis, and marks are verified", () => {
    for (const costBasis of ["160", null]) {
      const carried = account("800", {
        equity: "1000",
        positions: [position({ costBasis, priceDate: "2026-10-09" })],
      });
      expect(() => confirmed(baseline([carried]))).toThrow(/cash only|legacy positions/i);
    }
  });

  it("requires the explicit new-allocation scope and never upgrades an old whole-account baseline", () => {
    const value = baseline();
    delete (value as Partial<PerformanceBaseline>).scope;
    expect(() => confirmed(value)).toThrow(/scope/i);
    expect(() =>
      confirmed({ ...baseline(), scope: "WHOLE_ACCOUNT" } as unknown as PerformanceBaseline),
    ).toThrow(/scope/i);
  });

  it("rejects inherited unsettled balances, including offsetting balances in different pools", () => {
    for (const pending of ["-100", "100", null]) {
      expect(() => confirmed(baseline([account("1000", { unsettledCash: pending })]))).toThrow(
        /unsettled|cash only/i,
      );
    }
    expect(() =>
      confirmed(
        baseline([
          account("1000", { unsettledCash: "-100", equity: "900" }),
          account("500", { accountId: "synthetic-account-b", unsettledCash: "100", equity: "600" }),
        ]),
      ),
    ).toThrow(/unsettled/i);
  });

  it("accepts an explicitly allocated zero-cash pool only when total allocated capital is positive", () => {
    expect(
      actualPerformanceView(
        confirmed(baseline([account("1000"), account("0", { accountId: "synthetic-account-b" })])),
      ).baselineNav,
    ).toBe("1000");
    expect(() => confirmed(baseline([account("0")]))).toThrow(/positive/i);
  });

  it("requires explicit allocation coverage and both observation evidence arrays", () => {
    const unconfirmed = view(observation("1000", { allocationConfirmed: false }));
    expect(unconfirmed).toMatchObject({
      status: "INCOMPLETE",
      latestNav: null,
      totalPnl: null,
      returnPercent: null,
    });
    for (const field of ["tradeAllocations", "cashAdjustments"] as const) {
      const missing = observation();
      delete (missing as Partial<PerformanceObservation>)[field];
      expect(view(missing)).toMatchObject({
        status: "INCOMPLETE",
        latestNav: null,
        totalPnl: null,
      });
    }
  });

  it("rejects a nonzero market value attached to zero newly held quantity", () => {
    expect(() =>
      view(
        observation("800", {
          valuation: snapshot("800", {
            accounts: [
              account("800", { equity: "1000", positions: [position({ quantity: "0" })] }),
            ],
          }),
        }),
      ),
    ).toThrow(/position|quantity|valuation/i);
  });

  it("keeps missing quantity, market value, or price evidence unavailable for a new allocation", () => {
    for (const p of [
      position({ quantity: null }),
      position({ marketValue: null }),
      position({ priceDate: null }),
    ]) {
      const result = view(
        observation("800", {
          valuation: snapshot("800", {
            accounts: [account("800", { equity: "1000", positions: [p] })],
          }),
          tradeAllocations: [trade()],
        }),
      );
      expect(result).toMatchObject({ status: "INCOMPLETE", totalPnl: null, returnPercent: null });
    }
  });

  it("requires observed prices to match the reviewed market session and retains other warnings", () => {
    const point = observation("800", {
      valuation: snapshot("800", {
        requiredPriceDates: { KRW: "2026-10-09" },
        accounts: [
          account("800", {
            equity: "1000",
            positions: [position({ priceDate: "2026-10-09" })],
            issues: ["stale_price"],
          }),
        ],
      }),
      tradeAllocations: [trade()],
    });
    expect(view(point)).toMatchObject({ status: "RECORDED", totalPnl: "0" });
    point.valuation.accounts[0]!.positions[0]!.priceDate = "2025-01-01";
    point.valuation.requiredPriceDates = { KRW: "2026-10-08" };
    expect(view(point)).toMatchObject({ status: "INCOMPLETE", totalPnl: null });
    point.valuation.accounts[0]!.positions[0]!.priceDate = "2026-10-08";
    point.valuation.accounts[0]!.issues.push("unverified_quantity");
    expect(view(point).issues).toContain("unverified_quantity");
  });

  it("does not mutate the pending input and freezes conflicting baseline retries", () => {
    const pending = pendingActualPerformance();
    const input = baseline();
    const saved = confirmActualPerformanceBaseline(pending, input);
    expect(pending.baseline).toBeNull();
    expect(confirmActualPerformanceBaseline(saved, structuredClone(input))).toEqual(saved);
    expect(() => confirmActualPerformanceBaseline(saved, baseline([account("1001")]))).toThrow(
      /immutable/i,
    );
    input.valuation.accounts[0]!.cash = "999999";
    expect(saved.baseline!.valuation.accounts[0]!.cash).toBe("1000");
  });

  it("does not relabel pre-start history or accept a MODEL performance identity", () => {
    expect(() =>
      confirmed(baseline(undefined, { valuation: snapshot("1000", { date: "2026-10-09" }) })),
    ).toThrow();
    expect(() =>
      actualPerformanceView({
        ...pendingActualPerformance(),
        id: "synthetic-model",
      } as unknown as ActualPerformanceSeries),
    ).toThrow(/identity/i);
    expect(() =>
      view(observation("1000", { valuation: snapshot("1000", { date: "2026-10-09" }) })),
    ).toThrow();
  });
});

describe("ACTUAL observed knowledge cutoffs", () => {
  it("rejects a future cash-only valuation even without price or FX evidence to inspect", () => {
    expect(() =>
      view(
        observation("1000", {
          valuation: snapshot("1000", { recordedAt: "2020-01-01T00:00:00Z" }),
        }),
      ),
    ).toThrow(/date|future|cutoff|record|knowledge/i);
  });

  it("uses the UTC date rather than the literal date in an observation timestamp", () => {
    expect(() =>
      view(
        observation("1000", {
          valuation: snapshot("1000", { recordedAt: "2026-10-12T00:30:00+09:00" }),
        }),
      ),
    ).toThrow(/date|future|cutoff|record|knowledge/i);
    expect(
      view(
        observation("1000", {
          valuation: snapshot("1000", { recordedAt: "2026-10-11T23:30:00-02:00" }),
        }),
      ),
    ).toMatchObject({ status: "RECORDED", totalPnl: "0", returnPercent: "0" });
  });

  it("rejects new holding marks beyond the recorded UTC knowledge date", () => {
    expect(() =>
      view(
        observation("800", {
          valuation: snapshot("800", {
            recordedAt: "2026-10-12T00:30:00+09:00",
            accounts: [
              account("800", {
                equity: "1000",
                positions: [position()],
              }),
            ],
          }),
          tradeAllocations: [trade()],
        }),
      ),
    ).toThrow(/date|price|cutoff/i);
  });

  it("accepts a dated new holding when the recording timestamp normalizes forward to that UTC date", () => {
    expect(
      view(
        observation("800", {
          valuation: snapshot("800", {
            recordedAt: "2026-10-11T23:30:00-02:00",
            accounts: [
              account("800", {
                equity: "1000",
                positions: [position()],
              }),
            ],
          }),
          tradeAllocations: [trade()],
        }),
      ),
    ).toMatchObject({ status: "RECORDED", totalPnl: "0" });
  });

  it("allows evidenced weekend allocated cash before the logical start without inheriting holdings", () => {
    const value = baseline();
    value.valuation.recordedAt = "2026-10-11T12:00:00Z";
    value.confirmedAt = "2026-10-11T13:00:00Z";
    expect(actualPerformanceView(confirmed(value))).toMatchObject({
      status: "WAITING_OBSERVATION",
      baselineNav: "1000",
      latestNav: null,
      totalPnl: null,
    });
    value.valuation.accounts[0]!.positions = [position({ priceDate: "2026-10-09" })];
    expect(() => confirmed(value)).toThrow(/cash only|legacy/i);
  });

  it("requires confirmation at or after recording using actual instants, not timestamp text", () => {
    const value = baseline();
    value.valuation.recordedAt = "2026-10-11T12:00:00Z";
    value.confirmedAt = "2026-10-11T20:59:59+09:00";
    expect(() => confirmed(value)).toThrow(/confirm|record|boundary|time/i);
    value.confirmedAt = "2026-10-11T21:00:00+09:00";
    expect(actualPerformanceView(confirmed(value)).baselineNav).toBe("1000");
  });

  it("rejects a future-dated opening FX mark even when its availability timestamp is earlier", () => {
    const accounts = [account(), account("1", { currency: "USD" })];
    const value = baseline(accounts, {
      valuation: snapshot("1000", {
        accounts,
        recordedAt: "2026-10-08T23:00:00Z",
        requiredFxDate: "2026-10-09",
        fx: [{ ...fx("100", "2026-10-09"), availableAt: "2026-10-08T22:00:00Z" }],
      }),
      confirmedAt: "2026-10-10T12:00:00Z",
    });
    expect(() => confirmed(value)).toThrow(/fx|future|cutoff|knowledge/i);
  });
});

describe("ACTUAL cash-flow-adjusted daily performance", () => {
  it.each([
    ["100", "BEGINNING", "1210", "110"],
    ["100", "END", "1200", "100"],
    ["-100", "BEGINNING", "990", "90"],
    ["-100", "END", "1000", "100"],
  ] as const)(
    "handles %s flow at %s without counting capital as gain",
    (amount, timing, nav, pnl) => {
      const result = view(
        observation(nav, { flows: [flow(amount, { timing })], cashAdjustments: [adjustment(pnl)] }),
      );
      expect(result).toMatchObject({
        status: "RECORDED",
        latestNav: nav,
        totalPnl: pnl,
        returnPercent: "10",
      });
      expect(result.points[0]).toMatchObject({
        netExternalFlow: amount,
        pnl,
        dailyReturnPercent: "10",
      });
    },
  );

  it.each(["100", "-100"])(
    "reports no gain when the only change is an external flow of %s",
    (amount) => {
      const nav = format(decimal("1000") + decimal(amount));
      expect(view(observation(nav, { flows: [flow(amount)] }))).toMatchObject({
        totalPnl: "0",
        returnPercent: "0",
      });
    },
  );

  it("combines beginning deposits and ending withdrawals using their own timing", () => {
    const result = view(
      observation("1220", {
        cashAdjustments: [adjustment("120")],
        flows: [
          flow("200", { id: "synthetic-beginning", timing: "BEGINNING" }),
          flow("-100", { id: "synthetic-ending", timing: "END" }),
        ],
      }),
    );
    expect(result).toMatchObject({ totalPnl: "120", returnPercent: "10" });
    expect(result.points[0]!.netExternalFlow).toBe("100");
  });

  it("retains known P&L but withholds percentages for unverified intraday timing", () => {
    const result = view(
      observation("1200", {
        flows: [flow("100", { timing: "UNKNOWN" })],
        cashAdjustments: [adjustment("100")],
      }),
    );
    expect(result).toMatchObject({ status: "INCOMPLETE", totalPnl: "100", returnPercent: null });
    expect(result.points[0]).toMatchObject({
      nav: "1200",
      netExternalFlow: "100",
      pnl: "100",
      dailyReturnPercent: null,
    });
    expect(result.issues).toContain("intraday_flow_timing_unverified");
  });

  it("compounds daily returns rather than adding percentages or restarting the baseline", () => {
    const first = appendActualPerformanceObservation(
      confirmed(),
      observation("1100", { cashAdjustments: [adjustment("100")] }),
    );
    const result = view(
      observation("1210", {
        valuation: snapshot("1210", { date: "2026-10-13" }),
        previousDate: start,
        cashAdjustments: [adjustment("110", { id: "synthetic-adjustment-b", date: "2026-10-13" })],
      }),
      first,
    );
    expect(result).toMatchObject({ totalPnl: "210", returnPercent: "21" });
    expect(result.points.map((p) => p.dailyReturnPercent)).toEqual(["10", "10"]);
  });

  it("does not turn incomplete external flows into zero flows", () => {
    const result = view(observation("1200", { flowsComplete: false }));
    expect(result).toMatchObject({ status: "INCOMPLETE", totalPnl: null, returnPercent: null });
    expect(result.points[0]).toMatchObject({
      netExternalFlow: null,
      pnl: null,
      dailyReturnPercent: null,
    });
  });

  it("requires an explicitly complete observation interval", () => {
    const result = view(observation("1200", { intervalComplete: false }));
    expect(result).toMatchObject({ status: "INCOMPLETE", totalPnl: null, returnPercent: null });
    expect(result.issues.some((issue) => /interval/.test(issue))).toBe(true);
  });

  it("does not silently restore cumulative results after incomplete flow history", () => {
    const first = appendActualPerformanceObservation(
      confirmed(),
      observation("1100", { flowsComplete: false, cashAdjustments: [adjustment("100")] }),
    );
    const result = view(
      observation("1210", {
        valuation: snapshot("1210", { date: "2026-10-13" }),
        cashAdjustments: [adjustment("110", { id: "synthetic-adjustment-b", date: "2026-10-13" })],
      }),
      first,
    );
    expect(result).toMatchObject({ totalPnl: null, returnPercent: null, status: "INCOMPLETE" });
    expect(result.points[1]).toMatchObject({
      pnl: "110",
      dailyReturnPercent: "10",
      cumulativeReturnPercent: null,
    });
  });

  it("keeps P&L defined but avoids division by zero after a full beginning withdrawal", () => {
    const result = view(observation("0", { flows: [flow("-1000", { timing: "BEGINNING" })] }));
    expect(result).toMatchObject({ totalPnl: "0", returnPercent: null });
    expect(result.points[0]!.dailyReturnPercent).toBeNull();
  });

  it("rejects a flow whose amount contradicts its direction", () => {
    expect(() => view(observation("900", { flows: [flow("-100", { kind: "DEPOSIT" })] }))).toThrow(
      /direction/i,
    );
    expect(() =>
      view(observation("1100", { flows: [flow("100", { kind: "WITHDRAWAL" })] })),
    ).toThrow(/direction/i);
  });

  it("withholds money metrics when a known flow has an unknown amount", () => {
    const result = view(
      observation("1100", {
        flows: [
          flow("100", {
            legs: [{ accountId: "synthetic-account-a", currency: "KRW", amount: null }],
          }),
        ],
      }),
    );
    expect(result).toMatchObject({ totalPnl: null, returnPercent: null });
    expect(result.points[0]!.netExternalFlow).toBeNull();
  });
});

describe("ACTUAL account scope, shared cash, and internal transfers", () => {
  const accounts = [account(), account("500", { accountId: "synthetic-account-b" })];
  const scoped = () => confirmed(baseline(accounts));
  const transfer = () =>
    flow("-100", {
      kind: "TRANSFER",
      timing: "UNKNOWN",
      legs: [
        { accountId: "synthetic-account-a", currency: "KRW", amount: "-100" },
        { accountId: "synthetic-account-b", currency: "KRW", amount: "100" },
      ],
    });

  it("counts a paired in-scope transfer as neither gain nor an external flow", () => {
    const result = view(
      observation("1000", {
        valuation: snapshot("1000", {
          accounts: [account("900"), account("600", { accountId: "synthetic-account-b" })],
        }),
        flows: [transfer()],
      }),
      scoped(),
    );
    expect(result).toMatchObject({
      status: "RECORDED",
      latestNav: "1500",
      totalPnl: "0",
      returnPercent: "0",
    });
    expect(result.points[0]!.netExternalFlow).toBe("0");
  });

  it("rejects an unpaired or unbalanced internal transfer", () => {
    for (const legs of [
      [transfer().legs[0]!],
      [transfer().legs[0]!, { ...transfer().legs[1]!, amount: "99" }],
    ]) {
      expect(() =>
        view(
          observation("1000", {
            valuation: snapshot("1000", { accounts }),
            flows: [{ ...transfer(), legs }],
          }),
          scoped(),
        ),
      ).toThrow(/transfer|balanced/i);
    }
  });

  it("rejects an alleged transfer whose two legs address the same cash pool", () => {
    const samePool = flow("-100", {
      kind: "TRANSFER",
      legs: [
        { accountId: "synthetic-account-a", currency: "KRW", amount: "-100" },
        { accountId: "synthetic-account-a", currency: "KRW", amount: "100" },
      ],
    });
    expect(() => view(observation("1000", { flows: [samePool] }))).toThrow(
      /transfer|pool|duplicate|distinct/i,
    );
  });

  it("rejects cash flows outside the audited account scope", () => {
    expect(() =>
      view(
        observation("1100", {
          flows: [
            flow("100", {
              legs: [{ accountId: "synthetic-unreviewed-account", currency: "KRW", amount: "100" }],
            }),
          ],
        }),
      ),
    ).toThrow(/scope/i);
  });

  it("blocks scope changes instead of treating an omitted account as a loss", () => {
    const result = view(observation("1000"), scoped());
    expect(result).toMatchObject({
      status: "INCOMPLETE",
      latestNav: null,
      totalPnl: null,
      returnPercent: null,
    });
    expect(result.issues).toContain("account_scope_changed");
  });

  it("rejects duplicate shared cash in daily snapshots as well as openings", () => {
    expect(() =>
      view(
        observation("1000", { valuation: snapshot("1000", { accounts: [account(), account()] }) }),
      ),
    ).toThrow(/duplicate.*cash pool/i);
  });

  it("settles a newly allocated trade payable without creating performance", () => {
    const first = appendActualPerformanceObservation(
      confirmed(),
      observation("1000", {
        valuation: snapshot("1000", {
          accounts: [
            account("1000", { unsettledCash: "-200", equity: "1000", positions: [position()] }),
          ],
        }),
        tradeAllocations: [trade()],
      }),
    );
    const result = view(
      observation("800", {
        valuation: snapshot("800", {
          date: "2026-10-13",
          accounts: [
            account("800", { equity: "1000", positions: [position({ priceDate: "2026-10-13" })] }),
          ],
        }),
      }),
      first,
    );
    expect(result).toMatchObject({ totalPnl: "0", returnPercent: "0", latestNav: "1000" });
  });

  it("does not promote old observation marks into a complete daily NAV", () => {
    const stale = account("800", {
      equity: "1000",
      positions: [position({ priceDate: "2026-10-09" })],
    });
    const result = view(
      observation("1000", { valuation: snapshot("1000", { accounts: [stale] }) }),
    );
    expect(result).toMatchObject({
      status: "INCOMPLETE",
      latestNav: null,
      totalPnl: null,
      returnPercent: null,
    });
  });
});

describe("ACTUAL verified currency translation", () => {
  const accounts = [account(), account("1", { currency: "USD" })];
  const openingFxDate = "2026-10-09";
  const foreign = (rates: FxMark[] = [fx("100", openingFxDate)]) =>
    baseline(accounts, {
      valuation: snapshot("1000", { accounts, fx: rates, requiredFxDate: openingFxDate }),
    });

  it("requires verified date-matched FX and rejects conflicting opening rates", () => {
    for (const rates of [
      [],
      [fx("100", "2026-10-08")],
      [{ ...fx("100", openingFxDate), verified: false }],
      [fx("100", openingFxDate), fx("101", openingFxDate)],
    ]) {
      expect(() => confirmed(foreign(rates))).toThrow(/fx/i);
    }
    expect(actualPerformanceView(confirmed(foreign())).baselineNav).toBe("1100");
  });

  it("does not use opening FX evidence that became available after the snapshot cutoff", () => {
    expect(() =>
      confirmed(foreign([{ ...fx("100", openingFxDate), availableAt: "2026-10-13T00:00:00Z" }])),
    ).toThrow(/fx/i);
  });

  it("does not use a start-date closing FX rate for the prior-close opening policy", () => {
    const value = foreign([fx()]);
    value.valuation.requiredFxDate = start;
    expect(() => confirmed(value)).toThrow(/fx|opening/i);
  });

  it("withholds NAV and performance if daily valuation FX is missing or conflicting", () => {
    for (const rates of [[], [fx(), fx("101")]]) {
      const result = view(
        observation("1000", { valuation: snapshot("1000", { accounts, fx: rates }) }),
        confirmed(foreign()),
      );
      expect(result).toMatchObject({ latestNav: null, totalPnl: null, returnPercent: null });
      expect(result.issues).toContain("verified_valuation_fx_missing");
    }
  });

  it("withholds valuation FX that is only available after the recorded knowledge cutoff", () => {
    const result = view(
      observation("1000", {
        valuation: snapshot("1000", {
          accounts,
          fx: [{ ...fx(), availableAt: "2026-10-13T00:00:00Z" }],
        }),
      }),
      confirmed(foreign()),
    );
    expect(result).toMatchObject({ latestNav: null, totalPnl: null, returnPercent: null });
    expect(result.issues).toContain("verified_valuation_fx_missing");
  });

  it("requires independent flow-date FX instead of silently reusing valuation FX", () => {
    const closing = [account(), account("2", { currency: "USD" })];
    const usdDeposit = flow("1", {
      legs: [{ accountId: "synthetic-account-a", currency: "USD", amount: "1" }],
    });
    const point = observation("1000", {
      valuation: snapshot("1000", { accounts: closing, fx: [fx()] }),
      flows: [usdDeposit],
    });
    expect(view(point, confirmed(foreign()))).toMatchObject({
      latestNav: "1200",
      totalPnl: null,
      returnPercent: null,
    });
    expect(
      view({ ...point, flows: [{ ...usdDeposit, fx: [fx()] }] }, confirmed(foreign())),
    ).toMatchObject({ latestNav: "1200", totalPnl: "0", returnPercent: "0" });
  });

  it("does not use future-available FX to convert an external flow", () => {
    const closing = [account(), account("2", { currency: "USD" })];
    const result = view(
      observation("1000", {
        valuation: snapshot("1000", { accounts: closing, fx: [fx()] }),
        flows: [
          flow("1", {
            legs: [{ accountId: "synthetic-account-a", currency: "USD", amount: "1" }],
            fx: [{ ...fx(), availableAt: "2026-10-13T00:00:00Z" }],
          }),
        ],
      }),
      confirmed(foreign()),
    );
    expect(result).toMatchObject({ latestNav: "1200", totalPnl: null, returnPercent: null });
    expect(result.issues).toContain("verified_flow_fx_missing");
  });

  it("does not count an evidenced cross-currency internal conversion as gain", () => {
    const closing = [account("900"), account("2", { currency: "USD" })];
    const internalFx = flow("-100", {
      kind: "TRANSFER",
      fx: [fx()],
      legs: [
        { accountId: "synthetic-account-a", currency: "KRW", amount: "-100" },
        { accountId: "synthetic-account-a", currency: "USD", amount: "1" },
      ],
    });
    const result = view(
      observation("1000", {
        valuation: snapshot("1000", { accounts: closing, fx: [fx()] }),
        flows: [internalFx],
      }),
      confirmed(foreign()),
    );
    expect(result).toMatchObject({ latestNav: "1100", totalPnl: "0", returnPercent: "0" });
  });
});

describe("ACTUAL post-start execution allocations", () => {
  const buyPoint = () =>
    observation("800", {
      valuation: snapshot("800", {
        accounts: [account("800", { equity: "1000", positions: [position()] })],
      }),
      tradeAllocations: [trade()],
    });

  it("includes only the explicitly allocated new buy, excluding an old holding of the same security", () => {
    const point = buyPoint();
    expect(view(point)).toMatchObject({ status: "RECORDED", latestNav: "1000", totalPnl: "0" });
    // Ten older shares exist outside this slice; they must never be included in its quantity.
    point.valuation.accounts[0]!.positions[0]!.quantity = "12";
    point.valuation.accounts[0]!.positions[0]!.marketValue = "1200";
    point.valuation.accounts[0]!.equity = "2000";
    const contaminated = view(point);
    expect(contaminated).toMatchObject({ status: "INCOMPLETE", latestNav: null, totalPnl: null });
    expect(contaminated.issues).toContain("allocated_position_mismatch");
  });

  it("tracks a new buy of two then an explicitly allocated sell of one as exactly one remaining", () => {
    const first = appendActualPerformanceObservation(confirmed(), buyPoint());
    const sale = trade({
      executionId: "synthetic-new-sale",
      date: "2026-10-13",
      order: 1,
      side: "SELL",
      quantity: "1",
      price: "110",
      fee: "1",
    });
    const result = view(
      observation("909", {
        valuation: snapshot("909", {
          date: "2026-10-13",
          accounts: [
            account("909", {
              equity: "1019",
              positions: [position({ quantity: "1", marketValue: "110", priceDate: "2026-10-13" })],
            }),
          ],
        }),
        tradeAllocations: [sale],
      }),
      first,
    );
    expect(result).toMatchObject({
      status: "RECORDED",
      latestNav: "1019",
      totalPnl: "19",
      returnPercent: "1.9",
    });
  });

  it("replays supplied trade allocations in source order rather than array order", () => {
    const sale = trade({
      executionId: "synthetic-same-day-sale",
      order: 1,
      side: "SELL",
      quantity: "1",
      price: "110",
      fee: "1",
    });
    const point = observation("909", {
      valuation: snapshot("909", {
        accounts: [
          account("909", {
            equity: "1019",
            positions: [position({ quantity: "1", marketValue: "110" })],
          }),
        ],
      }),
      tradeAllocations: [sale, trade()],
    });
    expect(view(point)).toMatchObject({ status: "RECORDED", totalPnl: "19" });
    expect(() =>
      view({ ...point, tradeAllocations: [{ ...sale, order: 0 }, trade({ order: 1 })] }),
    ).toThrow(/sell exceeds/i);
  });

  it.each(["3", "10"])(
    "rejects selling %s shares when only two new shares were allocated",
    (quantity) => {
      const first = appendActualPerformanceObservation(confirmed(), buyPoint());
      expect(() =>
        view(
          observation("1000", {
            valuation: snapshot("1000", { date: "2026-10-13" }),
            tradeAllocations: [
              trade({
                executionId: "synthetic-oversell",
                date: "2026-10-13",
                side: "SELL",
                quantity,
              }),
            ],
          }),
          first,
        ),
      ).toThrow(/sell exceeds.*legacy/i);
    },
  );

  it("never uses historical shares to satisfy a sale before the slice has any allocated buy", () => {
    expect(() =>
      view(
        observation("1100", {
          tradeAllocations: [trade({ side: "SELL", quantity: "1" })],
        }),
      ),
    ).toThrow(/sell exceeds/i);
  });

  it("excludes a pre-start execution even when a later source review names it", () => {
    expect(() =>
      view({ ...buyPoint(), tradeAllocations: [trade({ date: "2026-10-09" })] }),
    ).toThrow(/post-start/i);
    expect(() =>
      view({ ...buyPoint(), tradeAllocations: [trade({ date: "2026-10-13" })] }),
    ).toThrow(/post-start/i);
  });

  it("requires reviewed evidence and an in-scope cash pool for every allocated trade", () => {
    expect(() =>
      view({
        ...buyPoint(),
        tradeAllocations: [trade({ source: { ...source, system: "model" } })],
      }),
    ).toThrow(/evidence/i);
    expect(() =>
      view({ ...buyPoint(), tradeAllocations: [trade({ accountId: "unreviewed-pool" })] }),
    ).toThrow(/scope/i);
    expect(() => view({ ...buyPoint(), tradeAllocations: [trade({ executionId: "" })] })).toThrow(
      /source execution/i,
    );
  });

  it.each([
    { quantity: "0" },
    { quantity: "-1" },
    { price: "0" },
    { price: "-1" },
    { fee: "-1" },
    { order: -1 },
    { order: 0.5 },
  ])("rejects malformed allocated trade economics or sequence: %j", (override) => {
    expect(() => view({ ...buyPoint(), tradeAllocations: [trade(override)] })).toThrow(
      /allocation|allocated trade/i,
    );
  });

  it("does not reuse a source execution within or across observations", () => {
    expect(() => view({ ...buyPoint(), tradeAllocations: [trade(), trade()] })).toThrow(/reused/i);
    const first = appendActualPerformanceObservation(confirmed(), buyPoint());
    expect(() =>
      view(
        observation("600", {
          valuation: snapshot("600", {
            date: "2026-10-13",
            accounts: [
              account("600", {
                equity: "1000",
                positions: [
                  position({ quantity: "4", marketValue: "400", priceDate: "2026-10-13" }),
                ],
              }),
            ],
          }),
          tradeAllocations: [trade({ date: "2026-10-13" })],
        }),
        first,
      ),
    ).toThrow(/reused/i);
  });

  it("refuses an omitted, extra, or wrong-account position in the observed slice", () => {
    for (const positions of [
      [],
      [position({ securityId: "legacy-only-security" })],
      [position(), position({ securityId: "extra-security" })],
    ]) {
      const total = positions.reduce((sum, p) => sum + decimal(p.marketValue!), 0n);
      const result = view(
        observation("800", {
          valuation: snapshot("800", {
            accounts: [account("800", { equity: format(decimal("800") + total), positions })],
          }),
          tradeAllocations: [trade()],
        }),
      );
      expect(result).toMatchObject({ status: "INCOMPLETE", latestNav: null, totalPnl: null });
      expect(result.issues).toContain("allocated_position_mismatch");
    }
  });

  it("requires explicit deposit attribution for proceeds of an excluded legacy holding", () => {
    const unexplained = view(observation("1500"));
    expect(unexplained).toMatchObject({ status: "INCOMPLETE", latestNav: null, totalPnl: null });
    expect(unexplained.issues).toContain("allocated_cash_mismatch");
    expect(view(observation("1500", { flows: [flow("500")] }))).toMatchObject({
      status: "RECORDED",
      latestNav: "1500",
      totalPnl: "0",
      returnPercent: "0",
    });
  });

  it("checks each shared cash pool rather than accepting an unchanged aggregate total", () => {
    const series = confirmed(
      baseline([account(), account("500", { accountId: "synthetic-account-b" })]),
    );
    const result = view(
      observation("1100", {
        valuation: snapshot("1100", {
          accounts: [account("1100"), account("400", { accountId: "synthetic-account-b" })],
        }),
      }),
      series,
    );
    expect(result).toMatchObject({ status: "INCOMPLETE", latestNav: null, totalPnl: null });
    expect(result.issues).toContain("allocated_cash_mismatch");
  });

  it.each([
    { cash: "-100", unsettledCash: "0" },
    { cash: "100", unsettledCash: "-200" },
  ])("rejects buying beyond allocated cash despite positive NAV: %j", ({ cash, unsettledCash }) => {
    const result = view(
      observation(cash, {
        valuation: snapshot(cash, {
          accounts: [
            account(cash, {
              unsettledCash,
              equity: "100",
              positions: [position({ quantity: "20", marketValue: "200" })],
            }),
          ],
        }),
        tradeAllocations: [trade({ quantity: "20", price: "10" })],
      }),
      confirmed(baseline([account("100")])),
    );
    expect(result).toMatchObject({
      status: "INCOMPLETE",
      latestNav: null,
      totalPnl: null,
      returnPercent: null,
    });
    expect(result.issues).toContain("allocated_cash_overdrawn");
    expect(result.points[0]).toMatchObject({ nav: null, pnl: null, dailyReturnPercent: null });
    expect(result.issues).not.toContain("allocated_cash_mismatch");
  });

  it("does not implicitly borrow from another reviewed cash pool to cover an overdrawn allocation", () => {
    const result = view(
      observation("-100", {
        valuation: snapshot("-100", {
          accounts: [
            account("-100", {
              equity: "100",
              positions: [position({ quantity: "20", marketValue: "200" })],
            }),
            account("1000", { accountId: "synthetic-account-b" }),
          ],
        }),
        tradeAllocations: [trade({ quantity: "20", price: "10" })],
      }),
      confirmed(baseline([account("100"), account("1000", { accountId: "synthetic-account-b" })])),
    );
    expect(result).toMatchObject({ status: "INCOMPLETE", latestNav: null, totalPnl: null });
    expect(result.issues).toContain("allocated_cash_overdrawn");
  });

  it("checks ending net cash without inventing an intraday borrowing or funding sequence", () => {
    const result = view(
      observation("0", {
        valuation: snapshot("0", {
          accounts: [
            account("0", {
              equity: "200",
              positions: [position({ quantity: "20", marketValue: "200" })],
            }),
          ],
        }),
        tradeAllocations: [trade({ quantity: "20", price: "10" })],
        flows: [flow("100", { timing: "END" })],
      }),
      confirmed(baseline([account("100")])),
    );
    expect(result).toMatchObject({
      status: "RECORDED",
      latestNav: "200",
      totalPnl: "0",
      returnPercent: "0",
    });
    expect(result.issues).not.toContain("allocated_cash_overdrawn");
  });

  it.each([
    { quantity: "3", price: "33.33333333", gross: "100" },
    { quantity: "2", price: "12345.67890123", gross: "24691.35780247" },
  ])(
    "preserves source gross independently from the rounded average price: %j",
    ({ quantity, price, gross }) => {
      expect(format(multiply(decimal(quantity), decimal(price)))).not.toBe(gross);
      const point = observation("0", {
        valuation: snapshot("0", {
          accounts: [
            account("0", {
              equity: gross,
              positions: [position({ quantity, marketValue: gross, costBasis: gross })],
            }),
          ],
        }),
        tradeAllocations: [trade({ quantity, price, gross })],
      });
      const result = view(point, confirmed(baseline([account(gross)])));
      expect(result).toMatchObject({
        status: "RECORDED",
        latestNav: gross,
        totalPnl: "0",
        returnPercent: "0",
      });
      expect(result.issues).not.toContain("allocated_cash_mismatch");
      expect(result.issues).not.toContain("allocated_cash_overdrawn");
    },
  );

  it("requires explicit positive source gross and still validates the separate quoted price", () => {
    for (const gross of ["0", "-100"]) {
      expect(() => view({ ...buyPoint(), tradeAllocations: [trade({ gross })] })).toThrow(/gross/i);
    }
    const missing = trade();
    delete (missing as Partial<TradeAllocation>).gross;
    expect(() => view({ ...buyPoint(), tradeAllocations: [missing] })).toThrow(/decimal|gross/i);
    expect(() =>
      view({ ...buyPoint(), tradeAllocations: [trade({ price: "0", gross: "200" })] }),
    ).toThrow(/price/i);
  });

  it("uses source gross for a sale as well as a purchase", () => {
    const first = appendActualPerformanceObservation(
      confirmed(baseline([account("100")])),
      observation("0", {
        valuation: snapshot("0", {
          accounts: [
            account("0", {
              equity: "100",
              positions: [position({ quantity: "3", marketValue: "100" })],
            }),
          ],
        }),
        tradeAllocations: [trade({ quantity: "3", price: "33.33333333", gross: "100" })],
      }),
    );
    const result = view(
      observation("100", {
        valuation: snapshot("100", { date: "2026-10-13" }),
        tradeAllocations: [
          trade({
            executionId: "synthetic-rounded-sale",
            date: "2026-10-13",
            side: "SELL",
            quantity: "3",
            price: "33.33333333",
            gross: "100",
          }),
        ],
      }),
      first,
    );
    expect(result).toMatchObject({
      status: "RECORDED",
      latestNav: "100",
      totalPnl: "0",
      returnPercent: "0",
    });
  });

  it("deducts allocated trade fees exactly once from slice cash and investment P&L", () => {
    const result = view(
      observation("799", {
        valuation: snapshot("799", {
          accounts: [account("799", { equity: "999", positions: [position()] })],
        }),
        tradeAllocations: [trade({ fee: "1" })],
      }),
    );
    expect(result).toMatchObject({ status: "RECORDED", totalPnl: "-1", returnPercent: "-0.1" });
    const mismatched = view({ ...buyPoint(), tradeAllocations: [trade({ fee: "1" })] });
    expect(mismatched.issues).toContain("allocated_cash_mismatch");
    expect(mismatched.totalPnl).toBeNull();
  });

  it("supports explicit income and standalone costs without treating them as external capital", () => {
    const result = view(
      observation("1014", {
        cashAdjustments: [
          adjustment("10", { id: "synthetic-dividend", kind: "DIVIDEND" }),
          adjustment("8", { id: "synthetic-interest", kind: "INTEREST" }),
          adjustment("-1", { id: "synthetic-fee", kind: "FEE" }),
          adjustment("-3", { id: "synthetic-tax", kind: "TAX" }),
        ],
      }),
    );
    expect(result).toMatchObject({ status: "RECORDED", totalPnl: "14", returnPercent: "1.4" });
    expect(result.points[0]!.netExternalFlow).toBe("0");
  });

  it.each(["DIVIDEND", "INTEREST", "FEE", "TAX"] as const)(
    "rejects a wrong-sign %s cash adjustment",
    (kind) => {
      const amount = ["DIVIDEND", "INTEREST"].includes(kind) ? "-1" : "1";
      expect(() =>
        view(observation("1000", { cashAdjustments: [adjustment(amount, { kind })] })),
      ).toThrow(/direction/i);
    },
  );

  it("requires unique, dated, in-scope reviewed evidence for cash adjustments", () => {
    expect(() =>
      view(observation("1020", { cashAdjustments: [adjustment("10"), adjustment("10")] })),
    ).toThrow(/duplicate/i);
    expect(() =>
      view(observation("1010", { cashAdjustments: [adjustment("10", { date: "2026-10-09" })] })),
    ).toThrow(/dated/i);
    expect(() =>
      view(observation("1010", { cashAdjustments: [adjustment("10", { accountId: "other" })] })),
    ).toThrow(/scope/i);
    expect(() =>
      view(
        observation("1010", {
          cashAdjustments: [adjustment("10", { source: { ...source, system: "model" } })],
        }),
      ),
    ).toThrow(/evidence/i);
    const first = appendActualPerformanceObservation(
      confirmed(),
      observation("1010", { cashAdjustments: [adjustment("10")] }),
    );
    expect(() =>
      view(
        observation("1020", {
          valuation: snapshot("1020", { date: "2026-10-13" }),
          cashAdjustments: [adjustment("10", { date: "2026-10-13" })],
        }),
        first,
      ),
    ).toThrow(/duplicate/i);
  });
});

describe("ACTUAL append-only evidence and unchanged execution accounting", () => {
  it("returns identical same-day retries without duplication and rejects changed facts", () => {
    const series = confirmed();
    const input = observation("1100", { cashAdjustments: [adjustment("100")] });
    const saved = appendActualPerformanceObservation(series, input);
    expect(series.observations).toEqual([]);
    expect(appendActualPerformanceObservation(saved, structuredClone(input))).toEqual(saved);
    expect(saved.observations).toHaveLength(1);
    expect(() => appendActualPerformanceObservation(saved, observation("1101"))).toThrow(
      /immutable|conflicting/i,
    );
    input.valuation.accounts[0]!.cash = "999999";
    expect(saved.observations[0]!.valuation.accounts[0]!.cash).toBe("1100");
  });

  it("rejects a wrong predecessor and duplicate flow identities", () => {
    expect(() => view(observation("1100", { previousDate: "2026-10-09" }))).toThrow(/predecessor/i);
    expect(() => view(observation("1200", { flows: [flow("100"), flow("100")] }))).toThrow(
      /duplicate.*flow/i,
    );
    const first = appendActualPerformanceObservation(
      confirmed(),
      observation("1100", { flows: [flow("100")] }),
    );
    expect(() =>
      view(
        observation("1200", {
          valuation: snapshot("1200", { date: "2026-10-13" }),
          flows: [flow("100", { date: "2026-10-13" })],
        }),
        first,
      ),
    ).toThrow(/duplicate.*flow/i);
  });

  it("does not reset historical shares, entry dates, fees, or cost basis", () => {
    const executions: ActualExecution[] = [
      {
        id: "synthetic-prestart-buy",
        symbol: "000001",
        name: "Synthetic held security",
        market: "KOSPI",
        signalKey: null,
        side: "BUY",
        date: "2026-10-01",
        price: 80,
        shares: 10,
        fee: 10,
        note: "Synthetic fixture only",
        order: 0,
      },
    ];
    const before = structuredClone(executions);
    const legacy = calculateActual(
      1000,
      executions,
      { "000001": { price: 100, date: start, exitSignal: null } },
      start,
    );
    const series = confirmed(baseline([account("190")]));
    const result = view(
      observation("90", {
        valuation: snapshot("90", {
          accounts: [
            account("90", {
              equity: "190",
              positions: [
                position({
                  securityId: "KOSPI:000001",
                  quantity: "1",
                  marketValue: "100",
                  costBasis: "100",
                }),
              ],
            }),
          ],
        }),
        tradeAllocations: [trade({ quantity: "1", securityId: "KOSPI:000001" })],
      }),
      series,
    );
    expect(result).toMatchObject({ totalPnl: "0", returnPercent: "0" });
    expect(executions).toEqual(before);
    expect(legacy.positions[0]).toMatchObject({
      shares: 10,
      cost: 810,
      averagePrice: 81,
      firstEntryDate: "2026-10-01",
    });
    expect(
      calculateActual(
        1000,
        executions,
        { "000001": { price: 100, date: start, exitSignal: null } },
        start,
      ),
    ).toEqual(legacy);
    const sale: ActualExecution = {
      ...executions[0]!,
      id: "synthetic-poststart-sale",
      side: "SELL",
      date: "2026-10-13",
      price: 110,
      shares: 5,
      fee: 5,
      order: 1,
    };
    const afterSale = calculateActual(1000, [...executions, sale], {}, null);
    expect(afterSale.executions[1]!.realizedPnl).toBe(140);
    expect(afterSale.positions[0]!.cost).toBe(405);
  });
});
