import { describe, expect, it } from "vitest";
import {
  freezeAnnualSizingSnapshot,
  operatingBudgetQuantity,
  parseOperatingAllocationRequest,
  prepareOperatingAllocation,
  prepareOperatingSignalBudget,
  prepareEtfSignalBudget,
  projectOperatingAvailability,
  readOperatingAllocation,
  reserveOperatingCash,
  validateAnnualSizingSnapshot,
  validateOperatingCashAuthority,
  readOperatingSizing,
  pinOperatingSignalBudget,
  type AnnualSizingSnapshot,
  type OperatingCashAuthority,
  type OperatingReservation,
} from "./operatingAllocation";

const hash = `sha256:${"a".repeat(64)}`;
const now = "2026-10-12T00:00:00Z";
function authority(): OperatingCashAuthority {
  return {
    version: 1,
    currency: "KRW",
    sourceRevision: 2,
    sourceFingerprint: hash,
    cashAtReview: "1000",
    claims: { KR: "600", ETF: "300", US: "0", UNASSIGNED: "100" },
    spendableCash: null,
    reservations: [],
    reviewedAt: now,
  };
}
function reservation(overrides: Partial<OperatingReservation> = {}): OperatingReservation {
  return {
    id: "reservation-1",
    signalId: "signal-1",
    market: "KR",
    currency: "KRW",
    amount: "500",
    signalBudgetId: "budget-1",
    ...overrides,
  };
}
function snapshot(overrides: Partial<AnnualSizingSnapshot> = {}): AnnualSizingSnapshot {
  return {
    id: "kr-2026",
    market: "KR",
    currency: "KRW",
    year: 2026,
    nav: "12000000",
    basis: "APPROVED_INITIAL_NATIVE_ALLOCATION",
    valuationDate: "2026-10-09",
    availableAt: "2026-10-11T12:00:00Z",
    firstSessionAt: "2026-10-12T00:00:00Z",
    sourceFingerprint: hash,
    valuationComplete: true,
    calendarEvidence: "verified-kr-2026",
    nativeAllocationEvidence: null,
    ...overrides,
  };
}
describe("approved actual allocation remains separate from money", () => {
  it("stores only S06 policy and leaves actual funding/USD basis unknown", () => {
    const plan = prepareOperatingAllocation(now);
    expect(plan.totalKrw).toBe("30000000");
    expect(plan.plannedKrw).toEqual({ KR: "12000000", ETF: "6000000", US: "12000000" });
    expect(plan.actualFunding).toBeNull();
    expect(plan.usdSizingBasis).toBeNull();
    expect(plan.monthlyOptimization).toBe(false);
    expect(readOperatingAllocation(plan)).toEqual(plan);
    expect(readOperatingAllocation(undefined)).toBeNull();
  });
  it.each([
    { totalKrw: "100000000" },
    { actualFunding: "30000000" },
    { usdSizingBasis: "8960.57" },
    { monthlyOptimization: true },
    { ownerId: "somebody" },
  ])("rejects an expanded stored contract %j", (override) => {
    expect(() =>
      readOperatingAllocation({ ...prepareOperatingAllocation(now), ...override }),
    ).toThrow();
  });
  it("rejects unreviewed/spoofed writes and malformed decimals before auth", () => {
    const request = {
      accessToken: "synthetic",
      currency: "KRW",
      action: "save",
      expectedRevision: 2,
      requestId: "00000000-0000-4000-8000-000000000001",
      change: { kind: "CONFIRM_PLAN" },
      reviewConfirmed: true,
    };
    expect(parseOperatingAllocationRequest(request).action).toBe("save");
    for (const bad of [
      { owner: "spoofed" },
      { reviewConfirmed: false },
      { expectedRevision: 2.5 },
      { change: { kind: "CONFIRM_PLAN", actualCash: "30000000" } },
    ])
      expect(() => parseOperatingAllocationRequest({ ...request, ...bad })).toThrow();
  });
});
describe("one physical currency pool with owned cash and encumbrances", () => {
  it("does not infer claims from the plan or funding from claims", () => {
    expect(
      projectOperatingAvailability({
        currency: "KRW",
        cash: null,
        sourceFingerprint: hash,
        authority: null,
      }).status,
    ).toBe("FUNDING_PENDING");
    expect(
      projectOperatingAvailability({
        currency: "KRW",
        cash: "1000",
        sourceFingerprint: hash,
        authority: null,
      }).status,
    ).toBe("CLAIMS_PENDING");
  });
  it("reserves KR and ETF once without subtracting cash twice", () => {
    let state = reserveOperatingCash(authority(), reservation());
    state = reserveOperatingCash(
      state,
      reservation({ id: "r2", signalId: "s2", market: "ETF", amount: "200" }),
    );
    expect(state.cashAtReview).toBe("1000");
    expect(
      projectOperatingAvailability({
        currency: "KRW",
        cash: "1000",
        sourceFingerprint: hash,
        authority: state,
      }),
    ).toEqual({
      status: "ESTIMATED_CASH",
      available: { KR: "100", ETF: "100", US: null },
      spendableAvailable: null,
    });
    expect(() =>
      reserveOperatingCash(state, reservation({ id: "r3", signalId: "s3", amount: "101" })),
    ).toThrow(/exceeds market/);
    expect(authority().reservations).toEqual([]);
  });
  it("is idempotent for exact reservations and rejects identity reuse", () => {
    const state = reserveOperatingCash(authority(), reservation());
    expect(reserveOperatingCash(state, reservation())).toEqual(state);
    expect(() => reserveOperatingCash(state, reservation({ amount: "499" }))).toThrow(/immutable/);
    expect(() => reserveOperatingCash(state, reservation({ id: "other" }))).toThrow(/Duplicate/);
  });
  it.each([
    { cashAtReview: "999" },
    { claims: { KR: "600", ETF: "300", US: "1", UNASSIGNED: "99" } },
    { claims: { KR: "600.000000001", ETF: "300", US: "0", UNASSIGNED: "100" } },
    { claims: { KR: "-1", ETF: "901", US: "0", UNASSIGNED: "100" } },
    { spendableCash: { amount: "1001", availableAt: now, reference: "broker-1" } },
    {
      spendableCash: { amount: "1000", availableAt: "2026-10-13T00:00:00Z", reference: "broker-1" },
    },
  ])("rejects invalid claims/spendability %j", (override) => {
    expect(() =>
      validateOperatingCashAuthority({ ...authority(), ...override } as OperatingCashAuthority),
    ).toThrow();
  });
  it("caps aggregate reservations by confirmed spendability", () => {
    const state = {
      ...authority(),
      spendableCash: { amount: "700", availableAt: now, reference: "broker-1" },
    };
    const reserved = reserveOperatingCash(state, reservation());
    expect(
      projectOperatingAvailability({
        currency: "KRW",
        cash: "1000",
        sourceFingerprint: hash,
        authority: reserved,
      }).spendableAvailable,
    ).toBe("200");
    expect(() =>
      reserveOperatingCash(
        reserved,
        reservation({ id: "r2", signalId: "s2", market: "ETF", amount: "201" }),
      ),
    ).toThrow(/spendable/);
  });
  it("fails closed after a corrected cash source, even with the same total", () => {
    for (const source of [
      { cash: "999", sourceFingerprint: hash },
      { cash: "1000", sourceFingerprint: `sha256:${"b".repeat(64)}` },
    ]) {
      const result = projectOperatingAvailability({
        currency: "KRW",
        authority: authority(),
        ...source,
      });
      expect(result.status).toBe("RECONCILIATION_REQUIRED");
      expect(result.available).toEqual({ KR: null, ETF: null, US: null });
    }
  });
  it("never moves a KRW claim or reservation into USD", () => {
    expect(() =>
      reserveOperatingCash(authority(), reservation({ market: "US", currency: "USD" })),
    ).toThrow(/currencies/);
  });
});
describe("causal annual sizing independent of monthly cash targets", () => {
  it("freezes annual snapshots and reuses exact retry only", () => {
    const state = freezeAnnualSizingSnapshot([], snapshot());
    expect(freezeAnnualSizingSnapshot(state, snapshot())).toEqual(state);
    expect(() => freezeAnnualSizingSnapshot(state, snapshot({ nav: "18000000" }))).toThrow(
      /immutable/,
    );
  });
  it.each([
    { availableAt: "2026-10-12T00:00:00Z" },
    { basis: "PRIOR_YEAR_MARKET_NAV", year: 2026 },
    { year: 2027, firstSessionAt: "2027-01-04T00:00:00Z" },
    { valuationDate: "2026-10-12" },
    { valuationComplete: false },
  ])("rejects incomplete/future/wrong-year annual basis %j", (override) => {
    expect(() =>
      validateAnnualSizingSnapshot({ ...snapshot(), ...override } as AnnualSizingSnapshot),
    ).toThrow();
  });
  it("does not silently convert the KRW US budget using Shadow FX", () => {
    expect(() => validateAnnualSizingSnapshot(snapshot({ market: "US", currency: "KRW" }))).toThrow(
      /native currency/,
    );
    expect(() => validateAnnualSizingSnapshot(snapshot({ market: "US", currency: "USD" }))).toThrow(
      /USD allocation evidence/,
    );
  });
  it("uses KR/30, native USD/20 and ETF signal volatility weight", () => {
    expect(
      prepareOperatingSignalBudget({ id: "kr", snapshot: snapshot(), signalDate: "2026-10-12" })
        .amount,
    ).toBe("400000");
    expect(
      prepareEtfSignalBudget({
        id: "etf",
        snapshot: {
          id: "etf-d-close",
          market: "ETF",
          currency: "KRW",
          valuationDate: "2026-10-12",
          nav: "6000000",
          cashClaim: "4000000",
          holdingsValue: "2000000",
          availableAt: "2026-10-12T07:00:00Z",
          nextOpenAt: "2026-10-13T00:00:00Z",
          sourceFingerprint: hash,
          cashReviewFingerprint: hash,
          calendarEvidence: "kr-calendar",
        },
        signalDate: "2026-10-12",
        decisionDate: "2026-10-12",
        etfWeight: "0.075",
        sourceFingerprint: hash,
      }).amount,
    ).toBe("450000");
    const us = prepareOperatingSignalBudget({
      id: "us",
      snapshot: snapshot({
        market: "US",
        currency: "USD",
        nav: "9000",
        nativeAllocationEvidence: "reviewed-USD-budget",
      }),
      signalDate: "2026-10-12",
    });
    expect(us.amount).toBe("450");
    expect(us.feeTreatment).toBe("GROSS_PLUS_FEE");
    expect(() =>
      prepareOperatingSignalBudget({
        id: "etf",
        snapshot: snapshot({ market: "ETF" }),
        signalDate: "2026-10-12",
      }),
    ).toThrow(/prior-close/);
  });
  it("preserves last-year pending budget rather than revaluing it", () => {
    const old = prepareOperatingSignalBudget({
      id: "signal-2026",
      snapshot: snapshot(),
      signalDate: "2026-12-30",
    });
    freezeAnnualSizingSnapshot(
      [snapshot()],
      snapshot({
        id: "kr-2027",
        year: 2027,
        nav: "18000000",
        basis: "PRIOR_YEAR_MARKET_NAV",
        valuationDate: "2026-12-30",
        availableAt: "2026-12-30T08:00:00Z",
        firstSessionAt: "2027-01-04T00:00:00Z",
      }),
    );
    expect(old.amount).toBe("400000");
    expect(() =>
      prepareOperatingSignalBudget({ id: "bad", snapshot: snapshot(), signalDate: "2027-01-04" }),
    ).toThrow(/annual/);
  });
  it("uses January confirmation's new annual basis for a December raw onset", () => {
    const next = snapshot({
      id: "kr-2027",
      year: 2027,
      nav: "18000000",
      basis: "PRIOR_YEAR_MARKET_NAV",
      valuationDate: "2026-12-30",
      availableAt: "2026-12-30T08:00:00Z",
      firstSessionAt: "2027-01-04T00:00:00Z",
    });
    const budget = prepareOperatingSignalBudget({
      id: "year-crossing",
      snapshot: next,
      signalDate: "2026-12-30",
      decisionDate: "2027-01-04",
    });
    expect(budget.signalDate).toBe("2026-12-30");
    expect(budget.decisionDate).toBe("2027-01-04");
    expect(budget.amount).toBe("600000");
    expect(() =>
      prepareOperatingSignalBudget({
        id: "wrong-year",
        snapshot: snapshot(),
        signalDate: "2026-12-30",
        decisionDate: "2027-01-04",
      }),
    ).toThrow(/annual/);
  });
  it("validates stored budget derivation and immutable retry identity", () => {
    const basis = snapshot(),
      budget = prepareOperatingSignalBudget({
        id: "pinned",
        snapshot: basis,
        signalDate: "2026-10-12",
      });
    const sizing = pinOperatingSignalBudget(
      { version: 1, annualSnapshots: [basis], signalBudgets: [], etfSnapshots: [] },
      budget,
    );
    expect(pinOperatingSignalBudget(sizing, budget)).toEqual(sizing);
    expect(() => pinOperatingSignalBudget(sizing, { ...budget, amount: "600000" })).toThrow(
      /immutable/,
    );
    expect(() =>
      readOperatingSizing({ ...sizing, signalBudgets: [{ ...budget, amount: "600000" }] }),
    ).toThrow(/diverges/);
    expect(() => readOperatingSizing({ ...sizing, annualSnapshots: [] })).toThrow(
      /snapshot missing/,
    );
  });
  it("floors integer quantities with market claims, shared cash and fees", () => {
    const budget = prepareOperatingSignalBudget({
      id: "kr",
      snapshot: snapshot(),
      signalDate: "2026-10-12",
    });
    const result = operatingBudgetQuantity({
      budget,
      price: "100000",
      marketCash: "400000",
      currencyCash: "300000",
    });
    expect(result).toEqual({
      status: "ESTIMATED",
      quantity: "2",
      gross: "200000",
      fee: "300",
      cashRequired: "200300",
    });
    expect(
      operatingBudgetQuantity({
        budget,
        price: "400000",
        marketCash: "400000",
        currencyCash: "400000",
      }).quantity,
    ).toBe("0");
    expect(
      operatingBudgetQuantity({ budget, price: "1", marketCash: null, currencyCash: "300000" })
        .status,
    ).toBe("BLOCKED");
  });
  it("US gross budget excludes fee while affordability includes it", () => {
    const budget = prepareOperatingSignalBudget({
      id: "us",
      snapshot: snapshot({
        market: "US",
        currency: "USD",
        nav: "2000",
        nativeAllocationEvidence: "USD-confirmed",
      }),
      signalDate: "2026-10-12",
    });
    expect(
      operatingBudgetQuantity({
        budget,
        price: "100",
        marketCash: "100.15",
        currencyCash: "100.15",
      }).quantity,
    ).toBe("1");
    expect(
      operatingBudgetQuantity({ budget, price: "100", marketCash: "100", currencyCash: "100" })
        .quantity,
    ).toBe("0");
  });
});
