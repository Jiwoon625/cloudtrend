import { describe, expect, it } from "vitest";
import { runUsProspectiveAnalysis, type UsProspectiveInputRow } from "./usProspective";
import {
  stepUsProspectivePortfolio,
  stepUsProspectiveOperatingPortfolio,
  usFixedSlotAllocationPolicy,
  usFixedSlotBudget,
  US_PROSPECTIVE_STRATEGIES,
  type UsModelExecutionPolicy,
  type UsFixedSlotAllocationPolicy,
} from "./usProspectivePortfolio";
import {
  freezeAdoptedSeries,
  hashSeriesValue,
  stepAdoptedUsSeries,
  VERIFIED_INITIAL_FX,
  type ModelCalendar,
  type AdoptedUsSeriesKind,
} from "../ledger/modelSeries";

const codeHash = `sha256:${"a".repeat(64)}` as const;
const sourceHash = `sha256:${"b".repeat(64)}` as const;
const a0 = US_PROSPECTIVE_STRATEGIES[0]!;
const policy: UsModelExecutionPolicy = {
  version: "isolated-us-model-v1",
  bookId: "adopted-shadow-2026-10-12-v2:US_A0",
  contractHash: codeHash,
  accountingStartDate: "2026-10-12",
  initialCapital: "73551.04",
  oneWayCost: "0.0015",
};
function analysis(date: string, count = 1) {
  const rows: UsProspectiveInputRow[] = Array.from({ length: count }, (_, index) => ({
    date,
    symbol: `T${index}`,
    name: `Test ${index}`,
    market: "NASDAQ",
    sector: "TECH",
    securityType: "STOCK",
    status: "ACTIVE",
    currency: "USD",
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1e6,
    dollarVolume: 1e8,
    sharesOutstanding: 1e8,
    marketCap: 1e10,
    ret120: index,
    ret252: index,
    beta60Spy: index,
    ichimokuTkGap: index,
    relvol1_20: index,
    adv20Usd: 1e9,
    amihud20: 0.001,
    active20: true,
    tossTradable: true,
    isCommonShare: true,
    fxUsdKrw: 1359.6,
  }));
  const result = runUsProspectiveAnalysis(rows);
  result.rows.forEach((row) => {
    row.a0Entry = true;
    row.a0Exit = false;
    row.a2Exit = false;
    row.b3Entry = true;
    row.b3Exit = false;
    row.a0BetaExit = false;
    row.betaWeakStreak = 0;
    row.coreRank = 0.9;
  });
  return result;
}
const createSeries = (kind: AdoptedUsSeriesKind = "US_A0") =>
  freezeAdoptedSeries({
    kind,
    codeHash,
    sourceHash,
    frozenAt: "2026-10-02T15:37:00Z",
    initialFx: VERIFIED_INITIAL_FX,
  });
const calendar: ModelCalendar = {
  market: "US",
  sourceHash,
  coverageStart: "2026-10-01",
  coverageEnd: "2026-10-20",
  regularSessions: [
    "2026-10-01",
    "2026-10-02",
    "2026-10-12",
    "2026-10-13",
    "2026-10-14",
    "2026-10-15",
    "2026-10-16",
    "2026-10-12",
  ],
};
const input = (date: string, configHash: string) => ({
  analysis: analysis(date),
  sourceHash,
  codeHash,
  configHash,
  calendar,
  availableAt: `${date}T21:00:00Z`,
  decisionAt: `${date}T22:00:00Z`,
});

describe("opt-in US model execution policy", () => {
  it("preserves unconfigured legacy defaults and cash-only configured start", () => {
    const legacy = stepUsProspectivePortfolio(a0, analysis("2026-10-12"), null, null);
    const model = stepUsProspectivePortfolio(a0, analysis("2026-10-12"), null, null, policy);
    expect(legacy.state.initialCapital).toBe(100000);
    expect(legacy.state.executionPolicy).toBeUndefined();
    expect(model.state).toMatchObject({
      initializedDate: "2026-10-12",
      initialCapital: 73551.04,
      cash: 73551.04,
      modelCashExact: "73551.04",
      totalFees: 0,
      modelFeesExact: "0",
      positions: {},
      executionPolicy: policy,
    });
    expect(model.trades.every((trade) => trade.status === "PENDING")).toBe(true);
    expect(model.positionsCount).toBe(0);
  });

  it("uses fee-aware integer shares and exact cash/fees at 0.15% on both sides", () => {
    const first = stepUsProspectivePortfolio(a0, analysis("2026-10-12"), null, null, policy);
    const buy = stepUsProspectivePortfolio(
      a0,
      analysis("2026-10-13"),
      first.state,
      first.nav,
      policy,
    );
    expect(buy.state.positions["T0"]!.shares).toBe(734);
    expect(buy.state.modelCashExact).toBe("40.94");
    expect(buy.feesUsd).toBe(110.1);
    expect(buy.state.modelFeesExact).toBe("110.1");
    expect(buy.trades.find((trade) => trade.executionDate)).toMatchObject({
      modelShares: 734,
      modelNotional: 73400,
      feeUsd: 110.1,
    });
    expect(first.state.positions).toEqual({});
    const exitSignal = analysis("2026-10-14");
    exitSignal.rows[0]!.a0Entry = false;
    exitSignal.rows[0]!.a0Exit = true;
    const exit = stepUsProspectivePortfolio(a0, exitSignal, buy.state, buy.nav, policy);
    const exitFill = analysis("2026-10-15");
    exitFill.rows[0]!.a0Entry = false;
    const sell = stepUsProspectivePortfolio(a0, exitFill, exit.state, exit.nav, policy);
    expect(sell.state.positions).toEqual({});
    expect(sell.state.modelCashExact).toBe("73330.84");
    expect(sell.state.modelFeesExact).toBe("220.2");
    expect(sell.feesUsd).toBe(110.1);
    const legacyFirst = stepUsProspectivePortfolio(a0, analysis("2026-10-12"), null, null);
    const legacyBuy = stepUsProspectivePortfolio(
      a0,
      analysis("2026-10-13"),
      legacyFirst.state,
      legacyFirst.nav,
    );
    expect(legacyBuy.feesUsd).toBe(
      legacyBuy.trades.find((trade) => trade.executionDate)!.modelNotional! * 0.0025,
    );
  });

  it("uses preceding ADV rather than today's volume for configured fills", () => {
    const firstInput = analysis("2026-10-12");
    firstInput.rows[0]!.adv20Usd = 500000;
    const first = stepUsProspectivePortfolio(a0, firstInput, null, null, policy);
    const secondInput = analysis("2026-10-13");
    secondInput.rows[0]!.open = 125;
    secondInput.rows[0]!.close = 200;
    const second = stepUsProspectivePortfolio(a0, secondInput, first.state, first.nav, policy);
    expect(second.state.positions["T0"]!.shares).toBe(40);
    expect(second.feesUsd).toBe(7.5);
    expect(second.state.modelCashExact).toBe("68543.54");
    expect(second.trades.find((trade) => trade.executionDate)!.modelPrice).toBe(125);
  });

  it("preserves quarterly equal-weight rebalancing and adopted A0 exits", () => {
    const seed = stepUsProspectivePortfolio(a0, analysis("2026-10-12", 2), null, null, policy);
    const held = stepUsProspectivePortfolio(
      a0,
      analysis("2026-10-13", 2),
      seed.state,
      seed.nav,
      policy,
    );
    const previous = structuredClone(held.state);
    previous.lastDate = "2026-12-31";
    previous.pendingTargets = {};
    previous.positions["T0"]!.shares = 300;
    previous.positions["T1"]!.shares = 100;
    previous.cash = 33551.04;
    previous.modelCashExact = "33551.04";
    const next = analysis("2027-01-04", 2);
    next.rows.forEach((row) => {
      row.a0Entry = false;
    });
    const rebalanced = stepUsProspectivePortfolio(a0, next, previous, 73551.04, policy);
    expect(rebalanced.state.lastQuarterRebalance).toBe("2027Q1");
    expect(
      rebalanced.trades.some(
        (trade) =>
          trade.executionDate === "2027-01-04" &&
          trade.signalDate === "2026-12-31" &&
          trade.reason === "QUARTER_EQUAL_WEIGHT",
      ),
    ).toBe(true);
    for (const trade of rebalanced.trades.filter((item) => item.executionDate))
      expect(trade.feeUsd).toBeCloseTo(trade.modelNotional! * 0.0015, 8);
  });

  it("rejects legacy/alternative mixing, altered policy, pre-start pending trades and missing policy", () => {
    const first = stepUsProspectivePortfolio(a0, analysis("2026-10-12"), null, null, policy);
    const next = analysis("2026-10-13");
    const legacy = stepUsProspectivePortfolio(a0, analysis("2026-10-12"), null, null);
    expect(() => stepUsProspectivePortfolio(a0, next, first.state, first.nav)).toThrow(
      "legacy engine",
    );
    expect(() => stepUsProspectivePortfolio(a0, next, legacy.state, legacy.nav, policy)).toThrow(
      "frozen execution policy",
    );
    expect(() =>
      stepUsProspectivePortfolio(a0, next, first.state, first.nav, {
        ...policy,
        oneWayCost: "0.0025",
      }),
    ).toThrow("frozen execution policy");
    expect(() =>
      stepUsProspectivePortfolio(US_PROSPECTIVE_STRATEGIES[1]!, next, null, null, policy),
    ).toThrow("unchanged adopted strategy");
    expect(() =>
      stepUsProspectivePortfolio(a0, analysis("2026-10-02"), null, null, policy),
    ).toThrow("start boundary");
    const dirty = structuredClone(first.state);
    dirty.pendingTargets["T0"]!.signalDate = "2026-10-02";
    expect(() => stepUsProspectivePortfolio(a0, next, dirty, first.nav, policy)).toThrow(
      "Pre-start",
    );
  });
});

describe("adopted A0 session and state-provenance adapter", () => {
  it("executes sequential frozen sessions and deterministically reuses identical same-date payloads", async () => {
    const series = await createSeries();
    const firstInput = input("2026-10-12", series.configHash);
    const first = await stepAdoptedUsSeries(series, firstInput);
    expect(first.status).toBe("NEW");
    expect(first.run.result.state.initialCapital).toBe(73551.04);
    const reused = await stepAdoptedUsSeries(series, firstInput, first.run);
    expect(reused.status).toBe("REUSE");
    expect(reused.run).toBe(first.run);
    const second = await stepAdoptedUsSeries(
      series,
      input("2026-10-13", series.configHash),
      first.run,
    );
    expect(second.run.result.state.positions["T0"]!.shares).toBe(36);
    expect(second.run.previousStateHash).toBe(first.run.stateHash);
    expect(second.run.result.state.modelCashExact).toBe("69945.64");
    expect(first.run.result.state.positions).toEqual({});
  });

  it("rejects changed same-date actual payload, changed provenance, tampered state and skipped sessions", async () => {
    const series = await createSeries();
    const firstInput = input("2026-10-12", series.configHash);
    const first = await stepAdoptedUsSeries(series, firstInput);
    const changed = structuredClone(firstInput);
    changed.analysis.rows[0]!.close = 101;
    await expect(stepAdoptedUsSeries(series, changed, first.run)).rejects.toThrow("Same-date");
    await expect(
      stepAdoptedUsSeries(series, { ...firstInput, sourceHash: codeHash }, first.run),
    ).rejects.toThrow("Same-date");
    await expect(
      stepAdoptedUsSeries(series, { ...firstInput, configHash: codeHash }, first.run),
    ).rejects.toThrow("Frozen code/config");
    await expect(
      stepAdoptedUsSeries(series, input("2026-10-14", series.configHash), first.run),
    ).rejects.toThrow("missing sessions");
    const dirty = structuredClone(first.run);
    dirty.result.state.cash += 10;
    await expect(
      stepAdoptedUsSeries(series, input("2026-10-13", series.configHash), dirty),
    ).rejects.toThrow("provenance mismatch");
    await expect(
      stepAdoptedUsSeries(series, input("2026-10-13", series.configHash), {
        ...first.run,
        book: "ACTUAL" as "MODEL",
      }),
    ).rejects.toThrow("Actual");
  });

  it("does not retroactively trade on late available analysis or a later decision day", async () => {
    const series = await createSeries();
    const current = input("2026-10-12", series.configHash);
    await expect(
      stepAdoptedUsSeries(series, {
        ...current,
        availableAt: "2026-10-15T21:00:00Z",
        decisionAt: "2026-10-15T22:00:00Z",
      }),
    ).rejects.toThrow("retrospective");
    await expect(
      stepAdoptedUsSeries(series, { ...current, decisionAt: "2026-10-13T22:00:00Z" }),
    ).rejects.toThrow("retrospective");
    await expect(
      stepAdoptedUsSeries(series, { ...current, decisionAt: "2026-10-12T20:00:00Z" }),
    ).rejects.toThrow("not yet available");
    await expect(
      stepAdoptedUsSeries(series, { ...current, calendar: { ...calendar, market: "KR" } }),
    ).rejects.toThrow("calendar");
  });

  it("keeps accounting start on Oct 5 when the supplied calendar's first session is later", async () => {
    const series = await createSeries();
    const holiday = {
      ...calendar,
      regularSessions: calendar.regularSessions.filter((date) => date !== "2026-10-12"),
    };
    const first = await stepAdoptedUsSeries(series, {
      ...input("2026-10-13", series.configHash),
      calendar: holiday,
    });
    expect(first.run.result.state.initializedDate).toBe("2026-10-12");
    expect(first.run.result.state.lastDate).toBe("2026-10-13");
    expect(first.run.result.positionsCount).toBe(0);
    expect(first.run.result.state.modelCashExact).toBe("73551.04");
  });
});

describe("isolated A2 and B3 variants", () => {
  it.each(["US_A2", "US_B3"] as const)(
    "runs %s with its frozen allocation, exact cash and independent state",
    async (kind) => {
      const series = await createSeries(kind);
      const first = await stepAdoptedUsSeries(series, input("2026-10-12", series.configHash));
      const original = structuredClone(first.run);
      const second = await stepAdoptedUsSeries(
        series,
        input("2026-10-13", series.configHash),
        first.run,
      );
      expect(second.run.result.state.modelCashExact).toBe("69945.64");
      expect(second.run.result.state.modelFeesExact).toBe("5.4");
      expect(second.run.result.state.positions["T0"]?.shares).toBe(36);
      expect(first.run).toEqual(original);
      expect(
        (await stepAdoptedUsSeries(series, input("2026-10-13", series.configHash), second.run))
          .status,
      ).toBe("REUSE");
      const other = await createSeries(kind === "US_A2" ? "US_B3" : "US_A2");
      await expect(
        stepAdoptedUsSeries(other, input("2026-10-14", other.configHash), second.run),
      ).rejects.toThrow("other model");
      const config = US_PROSPECTIVE_STRATEGIES.find(
        (strategy) => strategy.id === second.run.result.state.executionPolicy!.strategyId,
      )!;
      expect(() =>
        stepUsProspectivePortfolio(
          a0,
          analysis("2026-10-14"),
          second.run.result.state,
          second.run.result.nav,
          second.run.result.state.executionPolicy,
        ),
      ).toThrow("unchanged adopted strategy");
      const legacy = stepUsProspectivePortfolio(config, analysis("2026-10-12"), null, null);
      const legacyFill = stepUsProspectivePortfolio(
        config,
        analysis("2026-10-13"),
        legacy.state,
        legacy.nav,
      );
      expect(legacy.state.initialCapital).toBe(100000);
      expect(legacyFill.feesUsd).toBe(
        legacyFill.trades.find((trade) => trade.executionDate)!.modelNotional! * 0.0025,
      );
      expect(() =>
        stepUsProspectivePortfolio(
          config,
          analysis("2026-10-14"),
          legacyFill.state,
          legacyFill.nav,
          second.run.result.state.executionPolicy,
        ),
      ).toThrow("frozen execution policy");
    },
  );

  it("retains A2 quarterly rebalancing and never gives B3 a quarterly rule", () => {
    for (const config of US_PROSPECTIVE_STRATEGIES.slice(1)) {
      const executionPolicy: UsModelExecutionPolicy = {
        ...policy,
        strategyId: config.id,
        bookId: `adopted-shadow-2026-10-12-v2:${config.id === "A2_QUARTER_SHADOW" ? "US_A2" : "US_B3"}`,
      };
      const first = stepUsProspectivePortfolio(
        config,
        analysis("2026-10-12", 2),
        null,
        null,
        executionPolicy,
      );
      const held = stepUsProspectivePortfolio(
        config,
        analysis("2026-10-13", 2),
        first.state,
        first.nav,
        executionPolicy,
      );
      const previous = structuredClone(held.state);
      previous.lastDate = "2026-12-31";
      previous.pendingTargets = {};
      previous.positions["T0"]!.shares = 300;
      previous.positions["T1"]!.shares = 100;
      previous.cash = 33551.04;
      previous.modelCashExact = "33551.04";
      const next = analysis("2027-01-04", 2);
      next.rows.forEach((row) => {
        row.a0Entry = false;
        row.b3Entry = false;
      });
      const result = stepUsProspectivePortfolio(config, next, previous, 73551.04, executionPolicy);
      expect(result.trades.some((trade) => trade.reason === "QUARTER_EQUAL_WEIGHT")).toBe(
        config.quarterlyRebalance,
      );
      expect(result.state.lastQuarterRebalance).toBe(config.quarterlyRebalance ? "2027Q1" : null);
    }
  });
});

describe("approved initial-capital/20 prospective US allocation", () => {
  it.each([
    ["quarterlyRebalance", true],
    ["quarterlyRebalance", undefined],
    ["quarterlyRebalance", "false"],
    ["quarterlyRebalance", 0],
    ["fundingOnlySales", true],
    ["fundingOnlySales", undefined],
    ["fundingOnlySales", "false"],
    ["fundingOnlySales", 0],
  ])("rejects fixed-slot prohibition %s=%s unless explicitly false", (field, value) => {
    const invalid = { ...usFixedSlotAllocationPolicy(100000), [String(field)]: value };
    expect(() => usFixedSlotBudget(invalid as UsFixedSlotAllocationPolicy)).toThrow(
      "Invalid frozen US fixed-slot allocation policy",
    );
    expect(() =>
      stepUsProspectivePortfolio(
        a0,
        analysis("2026-10-12"),
        null,
        null,
        undefined,
        invalid as UsFixedSlotAllocationPolicy,
      ),
    ).toThrow("Invalid frozen US fixed-slot allocation policy");
  });

  it.each(["US_A0", "US_A2", "US_B3"] as const)(
    "%s refuses an unidentified historical base even with a valid contract hash",
    async (kind) => {
      const series = await createSeries(kind);
      const { contractHash: _contractHash, ...body } = structuredClone(series);
      delete body.policy.enginePolicyRole;
      const changed = { ...body, contractHash: await hashSeriesValue(body) };
      await expect(
        stepAdoptedUsSeries(changed, input("2026-10-12", changed.configHash)),
      ).rejects.toThrow("historical signal-base role changed");
    },
  );

  it("sizes one or many candidates by configured20, preserves signals/sectors, and uses separate fee-aware cash caps", async () => {
    expect(usFixedSlotBudget(usFixedSlotAllocationPolicy("73551.04"))).toBe("3677.552");
    expect(usFixedSlotBudget(usFixedSlotAllocationPolicy(100000))).toBe("5000");
    for (const kind of ["US_A0", "US_A2", "US_B3"] as const) {
      const series = await createSeries(kind);
      const first = await stepAdoptedUsSeries(series, input("2026-10-12", series.configHash));
      expect(first.run.result.state.pendingTargets["T0"]).toMatchObject({
        targetWeight: 0.05,
        fixedBudgetUsd: "3677.552",
      });
      const second = await stepAdoptedUsSeries(
        series,
        input("2026-10-13", series.configHash),
        first.run,
      );
      expect(second.run.result.state.positions["T0"]!.shares).toBe(36);
      expect(second.run.result.feesUsd).toBe(5.4);
    }
    const initial = stepUsProspectiveOperatingPortfolio(a0, analysis("2026-10-12", 4), null, null);
    const filled = stepUsProspectiveOperatingPortfolio(
      a0,
      analysis("2026-10-13", 4),
      initial.state,
      initial.nav,
    );
    expect(Object.values(filled.state.positions).map((p) => p.shares)).toEqual([50, 50, 50, 50]);
    expect(filled.feesUsd).toBe(50);
    expect(initial.state.positions).toEqual({});
    const lowCash = structuredClone(initial.state);
    lowCash.cash = 100;
    expect(
      stepUsProspectiveOperatingPortfolio(a0, analysis("2026-10-13", 4), lowCash, initial.nav)
        .positionsCount,
    ).toBe(0);
    const expensive = analysis("2026-10-13", 4);
    expensive.rows.forEach((row) => {
      row.open = 5000;
      row.close = 5000;
    });
    const oneEach = stepUsProspectiveOperatingPortfolio(a0, expensive, initial.state, initial.nav);
    expect(Object.values(oneEach.state.positions).map((p) => p.shares)).toEqual([1, 1, 1, 1]);
    expect(oneEach.feesUsd).toBe(50); // USD5,000 target excludes its12.50 fee.
  });

  it("cuts over existing operating books without resetting holdings or cash and drops weight/funding orders", () => {
    const before = stepUsProspectivePortfolio(a0, analysis("2026-10-02"), null, null);
    const legacy = structuredClone(before.state);
    legacy.cash = 50000;
    legacy.positions["HELD"] = {
      symbol: "HELD",
      name: "Held",
      sector: "TECH",
      shares: 500,
      lastPrice: 100,
      entryDate: "2026-09-28",
      entryCoreRank: 0.9,
    };
    legacy.pendingTargets["HELD"] = {
      symbol: "HELD",
      targetWeight: 0.1,
      signalDate: "2026-10-02",
      reason: "ENTRY_MINIMUM_PROPORTIONAL_FUNDING",
    };
    legacy.pendingTargets["QUARTER"] = {
      symbol: "QUARTER",
      targetWeight: 0.8,
      signalDate: "2026-10-02",
      reason: "QUARTER_EQUAL_WEIGHT",
    };
    const saved = structuredClone(legacy);
    const next = analysis("2026-10-12");
    next.rows.push({ ...next.rows[0]!, symbol: "HELD", a0Entry: false });
    const result = stepUsProspectiveOperatingPortfolio(a0, next, legacy, 100000);
    expect(result.state.initialCapital).toBe(100000);
    expect(result.state.initializedDate).toBe("2026-10-02");
    expect(result.state.positions["HELD"]!.shares).toBe(500);
    expect(result.state.positions["T0"]!.shares).toBe(50);
    expect(result.state.cash).toBe(44987.5);
    expect(result.trades.filter((t) => t.executionDate).every((t) => t.side === "BUY")).toBe(true);
    expect(result.state.pendingTargets["QUARTER"]).toBeUndefined();
    expect(legacy).toEqual(saved);
    const past = stepUsProspectiveOperatingPortfolio(a0, analysis("2026-10-02"), null, null);
    expect(past.state.allocationPolicy).toBeUndefined();
    expect(past.state.pendingTargets["T0"]!.targetWeight).toBe(1);
  });

  it("completes oversized inherited partial entry targets without selling held shares", () => {
    const seeded = stepUsProspectivePortfolio(a0, analysis("2026-10-02"), null, null);
    const previous = structuredClone(seeded.state);
    previous.positions["T0"] = {
      symbol: "T0",
      name: "Legacy",
      sector: "TECH",
      shares: 100,
      lastPrice: 100,
      entryDate: "2026-10-01",
      entryCoreRank: 0.9,
    };
    previous.cash = 90000;
    const next = analysis("2026-10-12");
    const after = stepUsProspectiveOperatingPortfolio(a0, next, previous, 100000);
    expect(after.state.positions["T0"]!.shares).toBe(100);
    expect(after.state.cash).toBe(90000);
    expect(after.state.pendingTargets["T0"]).toBeUndefined();
    expect(after.trades.filter((t) => t.executionDate)).toEqual([]);
  });

  it("preserves pending beta exits and never quarterly-rebalances or sells solely to fund a new entry", () => {
    const first = stepUsProspectiveOperatingPortfolio(a0, analysis("2026-10-12"), null, null);
    const held = stepUsProspectiveOperatingPortfolio(
      a0,
      analysis("2026-10-13"),
      first.state,
      first.nav,
    );
    const previous = structuredClone(held.state);
    previous.lastDate = "2026-12-31";
    previous.pendingTargets = {};
    previous.cash = 0;
    const next = analysis("2027-01-04", 2);
    next.rows[0]!.a0Entry = false;
    const noFunding = stepUsProspectiveOperatingPortfolio(a0, next, previous, held.nav);
    expect(
      noFunding.trades.some((t) => t.reason.includes("QUARTER") || t.reason.includes("FUNDING")),
    ).toBe(false);
    expect(noFunding.state.positions["T0"]!.shares).toBe(50);
    previous.pendingExits["T0"] = {
      symbol: "T0",
      signalDate: "2026-12-31",
      reason: "A0_BETA_ANCHOR_3D",
    };
    const sold = stepUsProspectiveOperatingPortfolio(a0, next, previous, held.nav);
    expect(sold.trades.find((t) => t.executionDate)?.reason).toBe("A0_BETA_ANCHOR_3D");
    expect(sold.trades.find((t) => t.executionDate)?.feeUsd).toBe(12.5);
  });

  it("caps partial fills by original gross budget and prior ADV without reallocating after price changes", () => {
    const firstInput = analysis("2026-10-12");
    firstInput.rows[0]!.adv20Usd = 50000;
    const first = stepUsProspectiveOperatingPortfolio(a0, firstInput, null, null);
    const partial = stepUsProspectiveOperatingPortfolio(
      a0,
      analysis("2026-10-13"),
      first.state,
      first.nav,
    );
    expect(partial.state.positions["T0"]!.shares).toBe(5);
    expect(partial.state.pendingTargets["T0"]).toMatchObject({
      fixedTargetShares: 50,
      remainingBudgetUsd: "4500",
    });
    const gap = analysis("2026-10-14");
    gap.rows[0]!.open = 200;
    gap.rows[0]!.close = 200;
    const second = stepUsProspectiveOperatingPortfolio(a0, gap, partial.state, partial.nav);
    expect(second.state.positions["T0"]!.shares).toBe(27);
    expect(second.state.pendingTargets["T0"]!.remainingBudgetUsd).toBe("100");
    const exactBudget = analysis("2026-10-14");
    exactBudget.rows[0]!.open = 150;
    exactBudget.rows[0]!.close = 150;
    const exhausted = stepUsProspectiveOperatingPortfolio(
      a0,
      exactBudget,
      partial.state,
      partial.nav,
    );
    expect(exhausted.state.positions["T0"]!.shares).toBe(35);
    expect(exhausted.state.pendingTargets["T0"]).toBeUndefined();
    expect(exhausted.trades.find((trade) => trade.executionDate)?.status).toBe("EXECUTED");
    expect(second.trades.filter((t) => t.executionDate).every((t) => t.side === "BUY")).toBe(true);
    expect(() =>
      stepUsProspectivePortfolio(
        a0,
        analysis("2026-10-15"),
        second.state,
        second.nav,
        undefined,
        usFixedSlotAllocationPolicy(200000),
      ),
    ).toThrow("initial capital");
  });
});
