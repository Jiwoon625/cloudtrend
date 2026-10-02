import { describe, expect, it } from "vitest";
import { runUsProspectiveAnalysis, type UsProspectiveInputRow } from "./usProspective";
import {
  stepUsProspectivePortfolio,
  US_PROSPECTIVE_STRATEGIES,
  type UsModelExecutionPolicy,
} from "./usProspectivePortfolio";
import {
  freezeAdoptedSeries,
  stepAdoptedUsSeries,
  VERIFIED_INITIAL_FX,
  type ModelCalendar,
} from "../ledger/modelSeries";

const codeHash = `sha256:${"a".repeat(64)}` as const;
const sourceHash = `sha256:${"b".repeat(64)}` as const;
const a0 = US_PROSPECTIVE_STRATEGIES[0]!;
const policy: UsModelExecutionPolicy = {
  version: "isolated-us-model-v1",
  bookId: "adopted-shadow-2026-10-05-v1:US_A0",
  contractHash: codeHash,
  accountingStartDate: "2026-10-05",
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
    row.a0BetaExit = false;
    row.betaWeakStreak = 0;
    row.coreRank = 0.9;
  });
  return result;
}
const createSeries = () =>
  freezeAdoptedSeries({
    kind: "US_A0",
    codeHash,
    sourceHash,
    frozenAt: "2026-10-02T15:37:00Z",
    initialFx: VERIFIED_INITIAL_FX,
  });
const calendar: ModelCalendar = {
  market: "US",
  sourceHash,
  coverageStart: "2026-10-01",
  coverageEnd: "2026-10-12",
  regularSessions: [
    "2026-10-01",
    "2026-10-02",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
    "2026-10-08",
    "2026-10-09",
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
    const legacy = stepUsProspectivePortfolio(a0, analysis("2026-10-05"), null, null);
    const model = stepUsProspectivePortfolio(a0, analysis("2026-10-05"), null, null, policy);
    expect(legacy.state.initialCapital).toBe(100000);
    expect(legacy.state.executionPolicy).toBeUndefined();
    expect(model.state).toMatchObject({
      initializedDate: "2026-10-05",
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
    const first = stepUsProspectivePortfolio(a0, analysis("2026-10-05"), null, null, policy);
    const buy = stepUsProspectivePortfolio(
      a0,
      analysis("2026-10-06"),
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
    const exitSignal = analysis("2026-10-07");
    exitSignal.rows[0]!.a0Entry = false;
    exitSignal.rows[0]!.a0Exit = true;
    const exit = stepUsProspectivePortfolio(a0, exitSignal, buy.state, buy.nav, policy);
    const exitFill = analysis("2026-10-08");
    exitFill.rows[0]!.a0Entry = false;
    const sell = stepUsProspectivePortfolio(a0, exitFill, exit.state, exit.nav, policy);
    expect(sell.state.positions).toEqual({});
    expect(sell.state.modelCashExact).toBe("73330.84");
    expect(sell.state.modelFeesExact).toBe("220.2");
    expect(sell.feesUsd).toBe(110.1);
    const legacyFirst = stepUsProspectivePortfolio(a0, analysis("2026-10-05"), null, null);
    const legacyBuy = stepUsProspectivePortfolio(
      a0,
      analysis("2026-10-06"),
      legacyFirst.state,
      legacyFirst.nav,
    );
    expect(legacyBuy.feesUsd).toBe(
      legacyBuy.trades.find((trade) => trade.executionDate)!.modelNotional! * 0.0025,
    );
  });

  it("uses preceding ADV rather than today's volume for configured fills", () => {
    const firstInput = analysis("2026-10-05");
    firstInput.rows[0]!.adv20Usd = 500000;
    const first = stepUsProspectivePortfolio(a0, firstInput, null, null, policy);
    const secondInput = analysis("2026-10-06");
    secondInput.rows[0]!.open = 125;
    secondInput.rows[0]!.close = 200;
    const second = stepUsProspectivePortfolio(a0, secondInput, first.state, first.nav, policy);
    expect(second.state.positions["T0"]!.shares).toBe(40);
    expect(second.feesUsd).toBe(7.5);
    expect(second.state.modelCashExact).toBe("68543.54");
    expect(second.trades.find((trade) => trade.executionDate)!.modelPrice).toBe(125);
  });

  it("preserves quarterly equal-weight rebalancing and adopted A0 exits", () => {
    const seed = stepUsProspectivePortfolio(a0, analysis("2026-10-05", 2), null, null, policy);
    const held = stepUsProspectivePortfolio(
      a0,
      analysis("2026-10-06", 2),
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
    const first = stepUsProspectivePortfolio(a0, analysis("2026-10-05"), null, null, policy);
    const next = analysis("2026-10-06");
    const legacy = stepUsProspectivePortfolio(a0, analysis("2026-10-05"), null, null);
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
    ).toThrow("unchanged adopted A0");
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
    const firstInput = input("2026-10-05", series.configHash);
    const first = await stepAdoptedUsSeries(series, firstInput);
    expect(first.status).toBe("NEW");
    expect(first.run.result.state.initialCapital).toBe(73551.04);
    const reused = await stepAdoptedUsSeries(series, firstInput, first.run);
    expect(reused.status).toBe("REUSE");
    expect(reused.run).toBe(first.run);
    const second = await stepAdoptedUsSeries(
      series,
      input("2026-10-06", series.configHash),
      first.run,
    );
    expect(second.run.result.state.positions["T0"]!.shares).toBe(734);
    expect(second.run.previousStateHash).toBe(first.run.stateHash);
    expect(second.run.result.state.modelCashExact).toBe("40.94");
    expect(first.run.result.state.positions).toEqual({});
  });

  it("rejects changed same-date actual payload, changed provenance, tampered state and skipped sessions", async () => {
    const series = await createSeries();
    const firstInput = input("2026-10-05", series.configHash);
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
      stepAdoptedUsSeries(series, input("2026-10-07", series.configHash), first.run),
    ).rejects.toThrow("missing sessions");
    const dirty = structuredClone(first.run);
    dirty.result.state.cash += 10;
    await expect(
      stepAdoptedUsSeries(series, input("2026-10-06", series.configHash), dirty),
    ).rejects.toThrow("provenance mismatch");
    await expect(
      stepAdoptedUsSeries(series, input("2026-10-06", series.configHash), {
        ...first.run,
        book: "ACTUAL" as "MODEL",
      }),
    ).rejects.toThrow("Actual");
  });

  it("does not retroactively trade on late available analysis or a later decision day", async () => {
    const series = await createSeries();
    const current = input("2026-10-05", series.configHash);
    await expect(
      stepAdoptedUsSeries(series, {
        ...current,
        availableAt: "2026-10-08T21:00:00Z",
        decisionAt: "2026-10-08T22:00:00Z",
      }),
    ).rejects.toThrow("retrospective");
    await expect(
      stepAdoptedUsSeries(series, { ...current, decisionAt: "2026-10-06T22:00:00Z" }),
    ).rejects.toThrow("retrospective");
    await expect(
      stepAdoptedUsSeries(series, { ...current, decisionAt: "2026-10-05T20:00:00Z" }),
    ).rejects.toThrow("not yet available");
    await expect(
      stepAdoptedUsSeries(series, { ...current, calendar: { ...calendar, market: "KR" } }),
    ).rejects.toThrow("calendar");
  });

  it("keeps accounting start on Oct 5 when the supplied calendar's first session is later", async () => {
    const series = await createSeries();
    const holiday = {
      ...calendar,
      regularSessions: calendar.regularSessions.filter((date) => date !== "2026-10-05"),
    };
    const first = await stepAdoptedUsSeries(series, {
      ...input("2026-10-06", series.configHash),
      calendar: holiday,
    });
    expect(first.run.result.state.initializedDate).toBe("2026-10-05");
    expect(first.run.result.state.lastDate).toBe("2026-10-06");
    expect(first.run.result.positionsCount).toBe(0);
    expect(first.run.result.state.modelCashExact).toBe("73551.04");
  });
});
