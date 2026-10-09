import { describe, expect, it } from "vitest";
import { CURRENT_RULES_RESEARCH } from "../engine/operatingPolicyContext";
import { runUsProspectiveAnalysis, type UsProspectiveInputRow } from "../engine/usProspective";
import {
  stepUsProspectivePortfolio,
  usFixedSlotAllocationPolicy,
  US_PROSPECTIVE_STRATEGIES,
  type UsModelExecutionPolicy,
} from "../engine/usProspectivePortfolio";
import {
  initializeAdoptedUsBacktest,
  replayAdoptedUsBacktest,
  stepAdoptedUsBacktest,
  type AdoptedUsBacktestSession,
} from "./adoptedUsBacktest";

const hash = `sha256:${"a".repeat(64)}` as const;
const dates = ["2017-12-27", "2017-12-28", "2017-12-29", "2018-01-02", "2018-01-03"];
const strategy = US_PROSPECTIVE_STRATEGIES[0]!;
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
    high: 101,
    low: 99,
    close: 100,
    volume: 1e6,
    dollarVolume: 1e8,
    sharesOutstanding: 1e8,
    marketCap: 1e10,
    ret120: i === 0 && stage > 0 ? 30 : i,
    ret252: i === 0 && stage > 0 ? 30 : i,
    beta60Spy: i === 0 ? (stage >= 3 ? -1 : 30) : i,
    ichimokuTkGap: i === 0 ? 30 : i,
    relvol1_20: i,
    adv20Usd: 500_000,
    amihud20: 0.001,
    active20: true,
    tossTradable: true,
    isCommonShare: true,
    fxUsdKrw: null,
  }));
  rows.push({ ...rows[0]!, symbol: "SPY", name: "SPY", isCommonShare: false });
  return { date, sourceHash: hash, rows };
}
const contract = (sessions = dates) =>
  initializeAdoptedUsBacktest({
    sessions,
    codeHash: hash,
    sourceManifestHash: hash,
    calendarSourceHash: hash,
  });

describe("current A0 historical adapter", () => {
  it("uses actual historical dates, initial capital/20, 0.15% and no quarter/year rebalance", async () => {
    const c = await contract();
    const runs = await replayAdoptedUsBacktest(c, dates.map(session));
    expect(runs[0]!.result.trades).toEqual([]);
    expect(runs[1]!.result.state.pendingTargets["T00"]?.fixedBudgetUsd).toBe("3733.572");
    const buy = runs[2]!.result.trades.find((t) => t.status === "EXECUTED");
    expect(buy).toMatchObject({
      executionDate: "2017-12-29",
      modelShares: 37,
      modelPrice: 100,
      feeUsd: 5.55,
      side: "BUY",
    });
    expect(runs[2]!.result.state.modelCashExact).toBe("70965.89");
    expect(runs.at(-1)!.result.state.allocationPolicy?.initialCapitalUsd).toBe("74671.44");
    expect(runs.flatMap((r) => r.result.trades).some((t) => t.side.startsWith("REBALANCE"))).toBe(
      false,
    );
    expect(runs.at(-1)!.result.state.positions["T00"]?.shares).toBe(37);
  });

  it("matches the same production functions step by step, including rank state", async () => {
    const c = await contract();
    const inputs = dates.map(session);
    const runs = await replayAdoptedUsBacktest(c, inputs);
    let state = null as ReturnType<typeof stepUsProspectivePortfolio>["state"] | null;
    let nav = null as number | null;
    let ranks = undefined as Parameters<typeof runUsProspectiveAnalysis>[1];
    const policy: UsModelExecutionPolicy = {
      version: "isolated-us-model-v1",
      bookId: c.bookId,
      contractHash: c.contractHash,
      accountingStartDate: c.startDate,
      initialCapital: c.initialCapitalUsd,
      oneWayCost: c.oneWayCost,
    };
    for (const [i, input] of inputs.entries()) {
      const analysis = runUsProspectiveAnalysis(input.rows, ranks);
      const result = stepUsProspectivePortfolio(
        strategy,
        analysis,
        state,
        nav,
        policy,
        usFixedSlotAllocationPolicy(c.initialCapitalUsd),
        0.0015,
        CURRENT_RULES_RESEARCH,
      );
      expect(JSON.stringify(runs[i]!.result)).toBe(JSON.stringify(result));
      expect(runs[i]!.rankState).toEqual(analysis.state);
      state = result.state;
      nav = result.nav;
      ranks = analysis.state;
    }
  });

  it("preserves Beta Anchor three-session exit and the next-open fee", async () => {
    const calendar = [...dates, "2018-01-04", "2018-01-05"];
    const runs = await replayAdoptedUsBacktest(await contract(calendar), calendar.map(session));
    expect(runs[5]!.result.state.pendingExits["T00"]?.reason).toBe("A0_BETA_ANCHOR_3D");
    const sell = runs[6]!.result.trades.find(
      (trade) => trade.side === "SELL" && trade.status === "EXECUTED",
    );
    expect(sell).toMatchObject({
      signalDate: "2018-01-04",
      executionDate: "2018-01-05",
      modelShares: 37,
      feeUsd: 5.55,
    });
    expect(runs[6]!.result.state.modelCashExact).toBe("74660.34");
  });

  it("preserves production pending-buy delta order rather than inventing a new allocator", async () => {
    const inputs = dates.slice(0, 3).map(session);
    for (const [i, input] of inputs.entries()) {
      const a = input.rows.find((r) => r.symbol === "T00")!;
      const b = input.rows.find((r) => r.symbol === "T01")!;
      a.beta60Spy = 31;
      a.ichimokuTkGap = 31;
      a.adv20Usd = 1e8;
      b.beta60Spy = 30;
      b.ichimokuTkGap = 30;
      b.adv20Usd = 1e8;
      b.open = 1000;
      b.high = 1001;
      b.low = 999;
      b.close = 1000;
      if (i > 0) {
        a.ret120 = 31;
        a.ret252 = 31;
        b.ret120 = 30;
        b.ret252 = 30;
      }
    }
    const runs = await replayAdoptedUsBacktest(await contract(dates.slice(0, 3)), inputs);
    expect(Object.keys(runs[1]!.result.state.pendingTargets)).toEqual(["T00", "T01"]);
    expect(
      runs[2]!.result.trades.filter((t) => t.status === "EXECUTED").map((t) => t.symbol),
    ).toEqual(["T01", "T00"]);
  });

  it("uses previous ADV, carries partial fills and freezes first executable quantity", async () => {
    const c = await contract();
    const inputs = dates.map(session);
    // A missing first open carries intent; subsequently reduced prior ADV causes a partial fill.
    inputs[2]!.rows.find((r) => r.symbol === "T00")!.open = null;
    inputs[2]!.rows.find((r) => r.symbol === "T00")!.adv20Usd = 10_000;
    inputs[4]!.rows.find((r) => r.symbol === "T00")!.open = 50;
    inputs[4]!.rows.find((r) => r.symbol === "T00")!.low = 49;
    const runs = await replayAdoptedUsBacktest(c, inputs);
    expect(runs[2]!.result.state.positions["T00"]).toBeUndefined();
    expect(runs[3]!.result.state.positions["T00"]?.shares).toBe(1);
    expect(runs[3]!.result.state.pendingTargets["T00"]?.fixedTargetShares).toBe(37);
    expect(runs[3]!.result.trades.find((t) => t.status === "PARTIAL")?.modelShares).toBe(1);
    // The remaining order does not double its target when the next price halves.
    expect(runs[4]!.result.state.positions["T00"]?.shares).toBe(37);
    expect(runs[4]!.result.trades.find((t) => t.status === "EXECUTED")?.modelShares).toBe(36);
  });

  it("rejects missing/future/duplicate sessions and wrong contract, and labels carried marks", async () => {
    const c = await contract();
    const first = await stepAdoptedUsBacktest(c, session(dates[0]!, 0));
    await expect(stepAdoptedUsBacktest(c, session(dates[2]!, 2), first)).rejects.toThrow(
      "next declared session",
    );
    await expect(stepAdoptedUsBacktest(c, session(dates[0]!, 0), first)).rejects.toThrow(
      "next declared session",
    );
    await expect(
      stepAdoptedUsBacktest(
        { ...c, oneWayCost: "0.0025" } as unknown as typeof c,
        session(dates[0]!, 0),
      ),
    ).rejects.toThrow("contract changed");
    const inputs = dates.map(session);
    inputs[3]!.rows = inputs[3]!.rows.filter((r) => r.symbol !== "T00");
    const runs = await replayAdoptedUsBacktest(c, inputs);
    expect(runs[3]!.staleMarkSymbols).toEqual(["T00"]);
    expect(runs[3]!.result.state.pendingExits["T00"]?.reason).toBe("UNIVERSE_OR_DATA_EXIT");
  });

  it("keeps default legacy calls byte-identical and refuses research identities there", async () => {
    const a = runUsProspectiveAnalysis(session("2017-01-03", 0).rows);
    const legacy = stepUsProspectivePortfolio(strategy, a, null, null);
    expect(JSON.stringify(legacy)).toBe(
      JSON.stringify(
        stepUsProspectivePortfolio(
          strategy,
          a,
          null,
          null,
          undefined,
          undefined,
          undefined,
          undefined,
        ),
      ),
    );
    expect(legacy.state.initialCapital).toBe(100_000);
    const c = await contract(["2017-01-03"]);
    const run = await stepAdoptedUsBacktest(c, session("2017-01-03", 0));
    expect(() =>
      stepUsProspectivePortfolio(
        strategy,
        runUsProspectiveAnalysis(session("2017-01-04", 1).rows),
        run.result.state,
        run.result.nav,
        run.result.state.executionPolicy,
        run.result.state.allocationPolicy,
      ),
    ).toThrow("matching series");
  });
});
