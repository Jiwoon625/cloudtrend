import { describe, expect, it } from "vitest";
import { CURRENT_RULES_RESEARCH } from "../engine/operatingPolicyContext";
import { runUsProspectiveAnalysis, type UsProspectiveInputRow } from "../engine/usProspective";
import {
  stepUsProspectivePortfolio,
  US_PROSPECTIVE_STRATEGIES,
  usFixedSlotPendingTargets,
} from "../engine/usProspectivePortfolio";
import {
  initializeAdoptedUsBacktest,
  replayAdoptedUsBacktest,
  stepAdoptedUsBacktest,
  type AdoptedUsBacktestSession,
} from "./adoptedUsBacktest";
import {
  advanceUsAnnualEntryBudget,
  US_ANNUAL_ENTRY_BUDGET_POLICY_ID,
  type UsAnnualEntryBudgetPolicy,
} from "./usAnnualEntryBudget";
import { US_LAST_VALID_CLOSE_POLICY_ID } from "./usLastValidClosePolicy";

const hash = `sha256:${"c".repeat(64)}` as const;
const dates = ["2017-12-27", "2017-12-28", "2017-12-29", "2018-01-02", "2018-01-03", "2018-01-04"];
const annual: UsAnnualEntryBudgetPolicy = { policyId: US_ANNUAL_ENTRY_BUDGET_POLICY_ID };
const clock = (date: string) => ({
  date,
  openAt: `${date}T14:30:00Z`,
  closeAvailableAt: `${date}T21:15:00Z`,
});
const contract = (sessions = dates, enabled = true, proxy = false) =>
  initializeAdoptedUsBacktest({
    sessions,
    codeHash: hash,
    sourceManifestHash: hash,
    calendarSourceHash: hash,
    ...(enabled ? { annualBudgetPolicy: annual } : {}),
    ...(proxy
      ? {
          missingClosePolicy: {
            policyId: US_LAST_VALID_CLOSE_POLICY_ID,
            sourceCoverageEndDate: sessions.at(-1)!,
            sessionClocks: sessions.map(clock),
          },
        }
      : {}),
  });
function session(date: string, stage: number): AdoptedUsBacktestSession {
  const rows: UsProspectiveInputRow[] = Array.from({ length: 21 }, (_, i) => ({
    date,
    symbol: `T${String(i).padStart(2, "0")}`,
    name: `Test ${i}`,
    market: "NASDAQ",
    sector: "TECH",
    securityType: "STOCK",
    status: "ACTIVE",
    currency: "USD",
    open: 100,
    high: 201,
    low: 99,
    close: i === 0 && stage >= 2 ? 200 : 100,
    volume: 1e6,
    dollarVolume: 1e8,
    sharesOutstanding: 1e8,
    marketCap: 1e10,
    ret120: i === 0 && stage > 0 ? 30 : i === 1 && stage >= 3 ? 40 : i,
    ret252: i === 0 && stage > 0 ? 30 : i === 1 && stage >= 3 ? 40 : i,
    beta60Spy: i === 0 ? 30 : i === 1 ? 40 : i,
    ichimokuTkGap: i === 0 ? 30 : i === 1 ? 40 : i,
    relvol1_20: i,
    adv20Usd: 500_000,
    amihud20: 0.001,
    active20: true,
    tossTradable: true,
    isCommonShare: true,
    fxUsdKrw: null,
  }));
  rows.push({ ...rows[0]!, symbol: "SPY", name: "SPY", isCommonShare: false, close: 100 });
  return { date, sourceHash: hash, rows, marketDataComplete: true };
}
const row = (input: AdoptedUsBacktestSession, symbol = "T00") =>
  input.rows.find((r) => r.symbol === symbol)!;

describe("US research annual new-entry principal", () => {
  it("starts at initial capital/20, then refreshes from preceding session NAV before the first yearly OPEN", async () => {
    const runs = await replayAdoptedUsBacktest(await contract(), dates.map(session));
    expect(runs[0]!.result.state.annualEntryBudgetResearch!.byYear["2017"]).toMatchObject({
      year: "2017",
      effectiveDate: "2017-12-27",
      sourceDate: null,
      basis: "INITIAL_CAPITAL",
      referenceNavUsd: "74671.44",
      entryPrincipalUsd: "3733.572",
      targetPositions: 20,
    });
    expect(runs[2]!.result.nav).toBe(78365.89);
    const refreshed = runs[3]!.result.state.annualEntryBudgetResearch!;
    expect(refreshed.currentYear).toBe("2018");
    expect(refreshed.byYear["2018"]).toMatchObject({
      year: "2018",
      effectiveDate: "2018-01-02",
      sourceDate: "2017-12-29",
      basis: "PREVIOUS_SESSION_CLOSE_NAV",
      referenceNav: runs[2]!.result.nav,
      referenceNavUsd: "78365.89",
      entryPrincipalUsd: "3918.2945",
    });
    expect(runs[3]!.result.state.pendingTargets["T01"]).toMatchObject({
      fixedBudgetUsd: "3918.2945",
      remainingBudgetUsd: "3918.2945",
      annualEntryBudgetYear: "2018",
    });
    expect(runs[4]!.result.state.positions["T01"]?.shares).toBe(39);
  });

  it("does not use current-year opening/closing prices and does not refresh during the year", async () => {
    const inputs = dates.map(session);
    const original = await replayAdoptedUsBacktest(await contract(), inputs);
    const changed = structuredClone(inputs);
    row(changed[3]!).open = 500;
    row(changed[3]!).close = 1000;
    row(changed[4]!).close = 3000;
    const other = await replayAdoptedUsBacktest(await contract(), changed);
    expect(other[3]!.result.nav).not.toBe(original[3]!.result.nav);
    for (const i of [3, 4, 5]) {
      expect(other[i]!.result.state.annualEntryBudgetResearch).toEqual(
        original[i]!.result.state.annualEntryBudgetResearch,
      );
      expect(
        other[i]!.result.state.annualEntryBudgetResearch!.byYear["2018"]?.entryPrincipalUsd,
      ).toBe("3918.2945");
    }
    expect(other[3]!.result.state.pendingTargets["T01"]?.fixedBudgetUsd).toBe("3918.2945");
  });

  it("keeps existing holdings, initial capital identity and no-rebalance/no-funding-sales behavior", async () => {
    const runs = await replayAdoptedUsBacktest(await contract(), dates.map(session));
    for (const run of runs.slice(2)) {
      expect(run.result.state.positions["T00"]?.shares).toBe(37);
      expect(run.result.state.initialCapital).toBe(74671.44);
      expect(run.result.state.executionPolicy?.initialCapital).toBe("74671.44");
      expect(run.result.state.allocationPolicy?.initialCapitalUsd).toBe("74671.44");
      expect(run.result.state.lastQuarterRebalance).toBeNull();
    }
    expect(
      runs
        .flatMap((r) => r.result.trades)
        .some(
          (t) =>
            t.side.startsWith("REBALANCE") || t.reason === "ENTRY_MINIMUM_PROPORTIONAL_FUNDING",
        ),
    ).toBe(false);
    expect(runs[4]!.result.trades.find((t) => t.symbol === "T01" && t.executionDate)?.feeUsd).toBe(
      5.85,
    );
  });

  it("preserves a prior-year unfilled intent budget through the new year and validates its original year", async () => {
    const inputs = dates.map(session);
    row(inputs[2]!, "T01").ret120 = 40;
    row(inputs[2]!, "T01").ret252 = 40;
    row(inputs[3]!, "T01").open = null;
    const runs = await replayAdoptedUsBacktest(await contract(), inputs);
    const before = runs[2]!.result.state.pendingTargets["T01"]!;
    expect(before).toMatchObject({
      annualEntryBudgetYear: "2017",
      fixedBudgetUsd: "3733.572",
      remainingBudgetUsd: "3733.572",
    });
    expect(runs[3]!.result.state.pendingTargets["T01"]).toEqual(before);
    expect(runs[3]!.result.state.annualEntryBudgetResearch!.byYear["2018"]?.entryPrincipalUsd).toBe(
      "3918.2945",
    );
    expect(runs[4]!.result.state.positions["T01"]?.shares).toBe(37);
    const bad = structuredClone(runs[3]!.result.state);
    bad.pendingTargets["T01"]!.fixedBudgetUsd = "3918.2945";
    expect(() =>
      usFixedSlotPendingTargets(bad, bad.allocationPolicy!, bad.annualEntryBudgetResearch),
    ).toThrow("budget changed");
    bad.pendingTargets["T01"]!.annualEntryBudgetYear = "2018";
    expect(() =>
      usFixedSlotPendingTargets(bad, bad.allocationPolicy!, bad.annualEntryBudgetResearch),
    ).toThrow("original creation-year");
  });

  it("preserves partially filled prior-year fixed quantity and remaining budget", async () => {
    const partialDates = [
      "2017-12-26",
      "2017-12-27",
      "2017-12-28",
      "2017-12-29",
      "2018-01-02",
      "2018-01-03",
    ];
    const inputs = partialDates.map(session);
    row(inputs[2]!).open = null;
    row(inputs[2]!).adv20Usd = 10_000;
    row(inputs[4]!).open = null;
    const runs = await replayAdoptedUsBacktest(await contract(partialDates), inputs);
    const oldOrder = runs[3]!.result.state.pendingTargets["T00"]!;
    expect(oldOrder).toMatchObject({
      fixedTargetShares: 37,
      fixedBudgetUsd: "3733.572",
      remainingBudgetUsd: "3633.572",
      annualEntryBudgetYear: "2017",
    });
    expect(runs[3]!.result.state.positions["T00"]?.shares).toBe(1);
    expect(runs[4]!.result.state.pendingTargets["T00"]).toEqual(oldOrder);
    expect(runs[5]!.result.state.positions["T00"]?.shares).toBe(37);
    expect(
      runs[5]!.result.trades.find((t) => t.symbol === "T00" && t.executionDate)?.modelShares,
    ).toBe(36);
  });

  it("starts a mid-year research period from the original initial capital", async () => {
    const sessions = ["2018-07-02", "2018-07-03"];
    const runs = await replayAdoptedUsBacktest(await contract(sessions), sessions.map(session));
    expect(runs[0]!.result.state.annualEntryBudgetResearch!.byYear["2018"]).toMatchObject({
      effectiveDate: "2018-07-02",
      sourceDate: null,
      basis: "INITIAL_CAPITAL",
      entryPrincipalUsd: "3733.572",
    });
  });

  it("keeps the omitted-option default fixed at initial/20 and creates a distinct annual contract", async () => {
    const inputs = dates.map(session),
      fixedContract = await contract(dates, false),
      yearlyContract = await contract();
    expect(fixedContract.contractHash).not.toBe(yearlyContract.contractHash);
    const fixed = await replayAdoptedUsBacktest(fixedContract, inputs);
    const annualRuns = await replayAdoptedUsBacktest(yearlyContract, inputs);
    expect(fixed[3]!.result.state.pendingTargets["T01"]?.fixedBudgetUsd).toBe("3733.572");
    expect(fixed[4]!.result.state.positions["T01"]?.shares).toBe(37);
    expect(fixed.every((r) => r.result.state.annualEntryBudgetResearch === undefined)).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(annualRuns[i]!.result.trades).toEqual(fixed[i]!.result.trades);
      expect(annualRuns[i]!.result.nav).toEqual(fixed[i]!.result.nav);
      expect(annualRuns[i]!.result.state.cash).toEqual(fixed[i]!.result.state.cash);
      expect(annualRuns[i]!.result.state.positions).toEqual(fixed[i]!.result.state.positions);
    }
  });

  it("composes with the existing close proxy without changing its fee or timing", async () => {
    const inputs = dates.map(session);
    inputs[3]!.rows = inputs[3]!.rows.filter((r) => r.symbol !== "T00");
    const runs = await replayAdoptedUsBacktest(await contract(dates, true, true), inputs);
    const proxy = runs[3]!.result.trades.find((t) => t.reason === US_LAST_VALID_CLOSE_POLICY_ID)!;
    expect(proxy).toMatchObject({ modelShares: 37, modelPrice: 200, feeUsd: 11.1 });
    expect(proxy.detail["cash_available_at"]).toBe("2018-01-02T21:15:00Z");
    expect(runs[3]!.result.state.annualEntryBudgetResearch!.byYear["2018"]?.entryPrincipalUsd).toBe(
      "3918.2945",
    );
    expect(runs[3]!.result.state.pendingTargets["T01"]?.fixedBudgetUsd).toBe("3918.2945");
  });

  it("uses documented 8-decimal NAV representation, retaining the original numeric source", () => {
    const first = advanceUsAnnualEntryBudget({
      policy: annual,
      date: "2017-12-29",
      initialCapitalUsd: "74671.44",
      previousDate: null,
      previousNav: null,
      previousState: null,
    });
    const next = advanceUsAnnualEntryBudget({
      policy: annual,
      date: "2018-01-02",
      initialCapitalUsd: "74671.44",
      previousDate: "2017-12-29",
      previousNav: 0.30000000000000004,
      previousState: first,
    });
    expect(next.byYear["2018"]).toMatchObject({
      referenceNav: 0.30000000000000004,
      referenceNavUsd: "0.3",
      entryPrincipalUsd: "0.015",
    });
    expect(first.byYear["2018"]).toBeUndefined();
  });

  it("rejects missing prior NAV, changed initial capital, and removal/mid-series activation", async () => {
    const first = advanceUsAnnualEntryBudget({
      policy: annual,
      date: "2017-12-29",
      initialCapitalUsd: "74671.44",
      previousDate: null,
      previousNav: null,
      previousState: null,
    });
    const base = {
      policy: annual,
      date: "2018-01-02",
      initialCapitalUsd: "74671.44",
      previousDate: "2017-12-29",
      previousNav: null,
      previousState: first,
    };
    expect(() => advanceUsAnnualEntryBudget(base)).toThrow("completed previous session NAV");
    expect(() =>
      advanceUsAnnualEntryBudget({ ...base, initialCapitalUsd: "100000", previousNav: 90000 }),
    ).toThrow("change initial capital");
    expect(() =>
      advanceUsAnnualEntryBudget({ ...base, previousState: null, previousNav: 90000 }),
    ).toThrow("activate mid-series");
    const c = await contract(),
      run = await stepAdoptedUsBacktest(c, session(dates[0]!, 0));
    expect(() =>
      stepUsProspectivePortfolio(
        US_PROSPECTIVE_STRATEGIES[0]!,
        runUsProspectiveAnalysis(session(dates[1]!, 1).rows, run.rankState),
        run.result.state,
        run.result.nav,
        run.result.state.executionPolicy,
        run.result.state.allocationPolicy,
        0.0015,
        CURRENT_RULES_RESEARCH,
      ),
    ).toThrow("requires its frozen");
  });

  it("replays year-boundary JSON checkpoints with identical budgets, fills and hashes", async () => {
    const c = await contract(),
      inputs = dates.map(session),
      uninterrupted = await replayAdoptedUsBacktest(c, inputs);
    let previous: Awaited<ReturnType<typeof stepAdoptedUsBacktest>> | null = null;
    const resumed = [];
    for (const input of inputs) {
      const next = await stepAdoptedUsBacktest(c, input, previous);
      resumed.push(next);
      previous = JSON.parse(JSON.stringify(next));
    }
    expect(resumed).toEqual(uninterrupted);
  });
});
