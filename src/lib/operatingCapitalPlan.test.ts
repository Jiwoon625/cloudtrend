import { describe, expect, it } from "vitest";
import { actualPerformanceView, pendingActualPerformance } from "./ledger/actualPerformance";
import { MODEL_INITIAL_KRW } from "./ledger/modelSeries";
import {
  CAPITAL_PLAN_ERRORS,
  capitalPlanErrorMessage,
  parseOperatingCapitalPlanRequest,
  prepareOperatingCapitalPlan,
  readOperatingCapitalPlan,
} from "./operatingCapitalPlan";
const now = "2026-10-09T12:00:00Z";
const request = {
  action: "preview",
  accessToken: "synthetic-token",
  expectedRevision: 9,
  plannedCapitalKrw: "12765432",
};
describe("private operating plan without financial activation", () => {
  it("records one shared planned total without allocating any money", () => {
    const p = prepareOperatingCapitalPlan("012765432.00000000", now);
    expect(p.plannedCapitalKrw).toBe("12765432");
    expect(p.allocation).toBeNull();
    expect(p.actualFunding).toBeNull();
    expect(p.integratedModel).toBe("NOT_INITIALIZED_NO_TRADING");
    expect(p.status).toBe("ALLOCATION_PENDING");
    expect(p.initialHoldings).toBe("EMPTY_NEW_SCOPE");
    expect(p.journalBoundary).toContain("NO_AUTOMATIC_SYNC");
    expect(p.policy.rebalance).toBe(false);
    expect(p.policy.kr).toBe("ANNUAL_KR_NAV_DIV_30");
    expect(p.policy.us).toBe("ANNUAL_USD_NAV_DIV_20");
    expect(p.policy.etf).toBe("ANNUAL_ETF_NAV_TIMES_SIGNAL_VOLATILITY_WEIGHT");
    expect(p.policy.pending).toBe("KEEP_CONFIRMED_SIGNAL_BUDGET");
    expect(p.policy.costs).toBe("EXISTING_KR_ETF_FEE_INCLUSIVE_US_GROSS_PLUS_FEE");
  });
  it("neither confirms actual cash/NAV nor changes the eight model capital constant", () => {
    const series = pendingActualPerformance();
    const original = structuredClone(series);
    const plan = prepareOperatingCapitalPlan("12765432", now);
    expect(plan).not.toHaveProperty("baseline");
    expect(plan).not.toHaveProperty("observations");
    expect(series).toEqual(original);
    expect(actualPerformanceView(series)).toMatchObject({
      status: "PENDING_BASELINE",
      baselineNav: null,
      latestNav: null,
      totalPnl: null,
      returnPercent: null,
    });
    expect(MODEL_INITIAL_KRW).toBe("100000000");
  });
  it("has no amount default or plan on a missing read", () => {
    expect(readOperatingCapitalPlan(undefined)).toBeNull();
    expect(() => prepareOperatingCapitalPlan(undefined, now)).toThrow(CAPITAL_PLAN_ERRORS.input);
  });
  it.each([
    0,
    12765432,
    "0",
    "0.00000000",
    "-10",
    "1e7",
    "NaN",
    "Infinity",
    "12,765,432",
    " 100",
    "100 ",
    "0.000000001",
    "1000000000000000000",
    null,
    {},
    [],
  ])("rejects malformed or nonpositive amount %j", (value) => {
    expect(() => prepareOperatingCapitalPlan(value, now)).toThrow(CAPITAL_PLAN_ERRORS.input);
  });
  it.each(["2026-02-30T12:00:00Z", "2026-10-09", "not-a-date"])(
    "rejects invalid recording timestamp %s",
    (value) => {
      expect(() => prepareOperatingCapitalPlan("100", value)).toThrow(CAPITAL_PLAN_ERRORS.input);
    },
  );
  it.each([
    { allocation: { KR: "12765432" } },
    { actualFunding: "12765432" },
    { integratedModel: "ACTIVE" },
    { currency: "USD" },
    { baseline: {} },
    { policy: { rebalance: true } },
    { plannedCapitalKrw: "012765432" },
    { version: "different-version" },
    { startDate: "2026-10-13" },
  ])("refuses changed stored semantics %j", (override) => {
    expect(() =>
      readOperatingCapitalPlan({ ...prepareOperatingCapitalPlan("12765432", now), ...override }),
    ).toThrow(CAPITAL_PLAN_ERRORS.invalid);
  });
  it.each([null, {}, [], "plan"])("fails closed on corrupt stored plan %j", (value) =>
    expect(() => readOperatingCapitalPlan(value)).toThrow(CAPITAL_PLAN_ERRORS.invalid),
  );
  it("roundtrips exact precision without numeric conversion", () => {
    const plan = prepareOperatingCapitalPlan("999999999999999999.12345678", now);
    expect(readOperatingCapitalPlan(plan)).toEqual(plan);
  });
  it.each([
    { userId: "spoofed" },
    { allocation: {} },
    { actualFunding: "12765432" },
    { reviewConfirmed: true },
    { expectedRevision: 0 },
    { plannedCapitalKrw: 12765432 },
  ])("strict request rejects %j", (override) =>
    expect(() => parseOperatingCapitalPlanRequest({ ...request, ...override })).toThrow(
      CAPITAL_PLAN_ERRORS.input,
    ),
  );
  it("requires explicit confirmation only for save and forbids writes in load", () => {
    expect(parseOperatingCapitalPlanRequest(request).action).toBe("preview");
    expect(() => parseOperatingCapitalPlanRequest({ ...request, action: "save" })).toThrow();
    expect(() =>
      parseOperatingCapitalPlanRequest({ ...request, action: "save", reviewConfirmed: false }),
    ).toThrow();
    expect(
      parseOperatingCapitalPlanRequest({ ...request, action: "save", reviewConfirmed: true })
        .action,
    ).toBe("save");
    expect(() => parseOperatingCapitalPlanRequest({ ...request, action: "load" })).toThrow();
    expect(
      parseOperatingCapitalPlanRequest({ action: "load", accessToken: "synthetic" }).action,
    ).toBe("load");
  });
  it("does not expose arbitrary backend details", () => {
    expect(capitalPlanErrorMessage(new Error("secret SQL credential"))).toBe(
      CAPITAL_PLAN_ERRORS.generic,
    );
    expect(capitalPlanErrorMessage(new Error(CAPITAL_PLAN_ERRORS.conflict))).toBe(
      CAPITAL_PLAN_ERRORS.conflict,
    );
  });
});
