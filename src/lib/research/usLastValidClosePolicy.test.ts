import { describe, expect, it } from "vitest";
import { CURRENT_RULES_RESEARCH } from "../engine/operatingPolicyContext";
import { runUsProspectiveAnalysis, type UsProspectiveInputRow } from "../engine/usProspective";
import {
  stepUsProspectivePortfolio,
  US_PROSPECTIVE_STRATEGIES,
} from "../engine/usProspectivePortfolio";
import {
  initializeAdoptedUsBacktest,
  replayAdoptedUsBacktest,
  stepAdoptedUsBacktest,
  type AdoptedUsBacktestSession,
} from "./adoptedUsBacktest";
import {
  US_LAST_VALID_CLOSE_POLICY_ID,
  finitePositive,
  validateUsLastValidCloseReference,
  type UsLastValidClosePolicy,
  type UsResearchCloseContext,
} from "./usLastValidClosePolicy";

const hash = `sha256:${"b".repeat(64)}` as const;
const dates = ["2017-12-27", "2017-12-28", "2017-12-29", "2018-01-02", "2018-01-03"];
const clock = (date: string) => ({
  date,
  openAt: `${date}T14:30:00Z`,
  closeAvailableAt: `${date}T21:15:00Z`,
});
const context = (date: string): UsResearchCloseContext => ({
  ...clock(date),
  policyId: US_LAST_VALID_CLOSE_POLICY_ID,
  marketDataComplete: true,
});
const policy = (sessions = dates): UsLastValidClosePolicy => ({
  policyId: US_LAST_VALID_CLOSE_POLICY_ID,
  sourceCoverageEndDate: sessions.at(-1)!,
  sessionClocks: sessions.map(clock),
});
const contract = (enabled = true, sessions = dates) =>
  initializeAdoptedUsBacktest({
    sessions,
    codeHash: hash,
    sourceManifestHash: hash,
    calendarSourceHash: hash,
    ...(enabled ? { missingClosePolicy: policy(sessions) } : {}),
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
    high: 101,
    low: 99,
    close: 100,
    volume: 1e6,
    dollarVolume: 1e8,
    sharesOutstanding: 1e8,
    marketCap: 1e10,
    ret120: i === 0 && stage > 0 ? 30 : i,
    ret252: i === 0 && stage > 0 ? 30 : i,
    beta60Spy: i === 0 ? 30 : i,
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
  return { date, sourceHash: hash, rows, marketDataComplete: true };
}
const row = (input: AdoptedUsBacktestSession, symbol = "T00") =>
  input.rows.find((r) => r.symbol === symbol)!;
const proxyTrades = (run: Awaited<ReturnType<typeof stepAdoptedUsBacktest>>) =>
  run.result.trades.filter((t) => t.reason === US_LAST_VALID_CLOSE_POLICY_ID);

describe("all-held last-valid-close US research policy", () => {
  it("recognizes the first missing close at that close, preserves earlier snapshots and cancels intents", async () => {
    const c = await contract();
    const inputs = dates.map(session);
    inputs[3]!.rows = inputs[3]!.rows.filter((r) => r.symbol !== "T00");
    inputs[4]!.rows = inputs[4]!.rows.filter((r) => r.symbol !== "T00");
    const first = await replayAdoptedUsBacktest(
      await contract(true, dates.slice(0, 3)),
      inputs.slice(0, 3),
    );
    const runs = await replayAdoptedUsBacktest(c, inputs);
    expect(runs[2]!.result.nav).toBe(first[2]!.result.nav);
    expect(runs[2]!.result.state.modelCashExact).toBe("70965.89");
    expect(runs[2]!.result.state.positions["T00"]?.shares).toBe(37);
    const proxy = proxyTrades(runs[3]!);
    expect(proxy).toHaveLength(1);
    expect(proxy[0]).toMatchObject({
      modelPrice: 100,
      modelShares: 37,
      feeUsd: 5.55,
      side: "SELL",
      status: "EXECUTED",
    });
    expect(proxy[0]!.detail).toMatchObject({
      actual_historical_fill: false,
      retrospective_exit_proxy: true,
      retroactive_nav_rewrite: false,
      trigger_session_date: "2018-01-02",
      recognition_at: "2018-01-02T21:15:00Z",
      reference_price_date: "2017-12-29",
      reference_price_available_at: "2017-12-29T21:15:00Z",
      cash_available_at: "2018-01-02T21:15:00Z",
      one_way_fee: "0.0015",
      corporate_actions_modeled: false,
    });
    expect(runs[3]!.result.state.modelCashExact).toBe("74660.34");
    expect(runs[3]!.result.state.positions["T00"]).toBeUndefined();
    expect(runs[3]!.result.state.pendingExits["T00"]).toBeUndefined();
    expect(runs[3]!.result.state.pendingTargets["T00"]).toBeUndefined();
    expect(runs[3]!.staleMarkSymbols).toEqual([]);
    expect(proxyTrades(runs[4]!)).toHaveLength(0);
  });

  it.each([null, 0, -1])(
    "treats invalid close %s as missing, even with a valid current OPEN",
    async (close) => {
      const inputs = dates.map(session);
      row(inputs[3]!).close = close;
      row(inputs[3]!).open = 200;
      const runs = await replayAdoptedUsBacktest(await contract(), inputs);
      expect(proxyTrades(runs[3]!)[0]?.modelPrice).toBe(100);
    },
  );

  it("rejects nonfinite raw JSON while its close-validity predicate treats it as invalid", async () => {
    for (const close of [NaN, Infinity, -Infinity]) {
      expect(finitePositive(close)).toBe(false);
      const inputs = dates.map(session);
      row(inputs[3]!).close = close;
      await expect(replayAdoptedUsBacktest(await contract(), inputs)).rejects.toThrow(
        "plain finite JSON",
      );
    }
    // The CSV parser/source adapter represents these non-JSON values as null.
  });

  it("caches unheld closes so a new OPEN purchase can exit at the same missing CLOSE", async () => {
    const inputs = dates.slice(0, 3).map(session);
    row(inputs[2]!).close = null;
    row(inputs[2]!).open = 200;
    const runs = await replayAdoptedUsBacktest(await contract(true, dates.slice(0, 3)), inputs);
    const proxy = proxyTrades(runs[2]!)[0]!;
    expect(proxy.modelShares).toBe(18);
    expect(proxy.modelPrice).toBe(100);
    expect(proxy.detail["reference_price_date"]).toBe("2017-12-28");
    expect(
      runs[2]!.result.trades.filter((t) => t.status === "EXECUTED").map((t) => t.side),
    ).toEqual(["BUY", "SELL"]);
  });

  it("keeps a valid zero-volume CLOSE as a mark while blocking ordinary zero-volume BUY", async () => {
    const inputs = dates.map(session);
    row(inputs[2]!).volume = 0;
    const runs = await replayAdoptedUsBacktest(await contract(), inputs);
    expect(runs[2]!.result.state.positions["T00"]).toBeUndefined();
    expect(runs[2]!.result.state.pendingTargets["T00"]?.fixedTargetShares).toBeUndefined();
    expect(runs[3]!.result.state.positions["T00"]?.shares).toBe(37);
    const valuedInputs = dates.map(session);
    row(valuedInputs[3]!).volume = 0;
    row(valuedInputs[3]!).close = 110;
    valuedInputs[4]!.rows = valuedInputs[4]!.rows.filter((r) => r.symbol !== "T00");
    const valued = await replayAdoptedUsBacktest(await contract(), valuedInputs);
    expect(proxyTrades(valued[3]!)).toHaveLength(0);
    expect(valued[3]!.result.state.positions["T00"]?.lastPrice).toBe(110);
    expect(proxyTrades(valued[4]!)[0]?.modelPrice).toBe(110);
    expect(proxyTrades(valued[4]!)[0]?.detail["reference_price_date"]).toBe(dates[3]);
  });

  it("blocks an ordinary zero-volume SELL without misclassifying its valid close", async () => {
    const inputs = dates.map(session);
    row(inputs[3]!).ret120 = -10;
    row(inputs[3]!).ret252 = -10;
    row(inputs[4]!).volume = 0;
    const runs = await replayAdoptedUsBacktest(await contract(), inputs);
    expect(runs[3]!.result.state.pendingExits["T00"]).toBeDefined();
    expect(runs[4]!.result.state.positions["T00"]?.shares).toBe(37);
    expect(runs[4]!.result.trades.filter((t) => t.status === "EXECUTED")).toEqual([]);
    expect(proxyTrades(runs[4]!)).toEqual([]);
  });

  it("does not use close-recognized proxy cash at the already completed OPEN", async () => {
    const c = await contract();
    const first = dates.slice(0, 3).map(session);
    let prior = await stepAdoptedUsBacktest(c, first[0]!);
    prior = await stepAdoptedUsBacktest(c, first[1]!, prior);
    prior = await stepAdoptedUsBacktest(c, first[2]!, prior);
    const seeded = structuredClone(prior.result.state);
    seeded.cash = 0;
    seeded.modelCashExact = "0";
    seeded.pendingTargets["T01"] = {
      symbol: "T01",
      targetWeight: 0.05,
      fixedBudgetUsd: "3733.572",
      remainingBudgetUsd: "3733.572",
      signalDate: dates[2]!,
      reason: "ENTRY_ONSET80",
      signalPriority: { core: 1, beta: 1, confirmation: 1 },
    };
    const missing = session(dates[3]!, 3);
    missing.rows = missing.rows.filter((r) => r.symbol !== "T00");
    Object.assign(row(missing, "T01"), {
      ret120: 50,
      ret252: 50,
      beta60Spy: 50,
      ichimokuTkGap: 50,
    });
    const result = stepUsProspectivePortfolio(
      US_PROSPECTIVE_STRATEGIES[0]!,
      runUsProspectiveAnalysis(missing.rows, prior.rankState),
      seeded,
      prior.result.nav,
      seeded.executionPolicy,
      seeded.allocationPolicy,
      0.0015,
      CURRENT_RULES_RESEARCH,
      context(missing.date),
    );
    expect(result.state.positions["T01"]).toBeUndefined();
    expect(result.state.modelCashExact).toBe("3694.45");
    expect(result.state.pendingTargets["T01"]).toBeDefined();
    const next = session(dates[4]!, 4);
    next.rows = next.rows.filter((r) => r.symbol !== "T00");
    Object.assign(row(next, "T01"), { ret120: 50, ret252: 50, beta60Spy: 50, ichimokuTkGap: 50 });
    const nextResult = stepUsProspectivePortfolio(
      US_PROSPECTIVE_STRATEGIES[0]!,
      runUsProspectiveAnalysis(next.rows),
      result.state,
      result.nav,
      seeded.executionPolicy,
      seeded.allocationPolicy,
      0.0015,
      CURRENT_RULES_RESEARCH,
      context(next.date),
    );
    expect(nextResult.state.positions["T01"]?.shares).toBe(36);
  });

  it("rejects incomplete/empty/market-wide uncollected sources before changing prior state", async () => {
    const c = await contract();
    const first = await stepAdoptedUsBacktest(c, session(dates[0]!, 0));
    const before = JSON.stringify(first);
    const input = session(dates[1]!, 1);
    for (const bad of [
      { ...input, marketDataComplete: false },
      { ...input, marketDataComplete: undefined },
      { ...input, rows: [] },
      { ...input, rows: input.rows.filter((r) => r.symbol === "SPY") },
      { ...input, rows: input.rows.map((r) => ({ ...r, close: r.symbol === "SPY" ? 100 : null })) },
    ]) {
      await expect(
        stepAdoptedUsBacktest(c, bad as AdoptedUsBacktestSession, first),
      ).rejects.toThrow("Incomplete market source");
    }
    expect(JSON.stringify(first)).toBe(before);
  });

  it("does not synthesize disappearance on holidays/weekends or beyond the verified source end", async () => {
    const inputs = dates.map(session);
    const runs = await replayAdoptedUsBacktest(await contract(), inputs);
    expect(runs.map((r) => r.date)).toEqual(dates);
    expect(runs.flatMap(proxyTrades)).toHaveLength(0);
    expect(runs.at(-1)!.result.state.positions["T00"]?.shares).toBe(37);
    await expect(
      initializeAdoptedUsBacktest({
        sessions: dates,
        codeHash: hash,
        sourceManifestHash: hash,
        calendarSourceHash: hash,
        missingClosePolicy: { ...policy(), sourceCoverageEndDate: "2018-01-02" },
      }),
    ).rejects.toThrow("within source coverage");
    await expect(contract(true, ["2017-12-30"])).rejects.toThrow("session boundary");
    await expect(
      stepAdoptedUsBacktest(await contract(), session("2018-01-04", 5), runs.at(-1)!),
    ).rejects.toThrow("next declared session");
  });

  it("rejects absent/future reference and a non-research caller", async () => {
    expect(() => validateUsLastValidCloseReference(undefined, context(dates[3]!))).toThrow(
      "NO_PRIOR_VALID",
    );
    expect(() =>
      validateUsLastValidCloseReference(
        { date: dates[2]!, availableAt: "2018-01-03T21:15:00Z", price: 100 },
        context(dates[3]!),
      ),
    ).toThrow("future reference");
    expect(() =>
      stepUsProspectivePortfolio(
        US_PROSPECTIVE_STRATEGIES[0]!,
        runUsProspectiveAnalysis(session(dates[0]!, 0).rows),
        null,
        null,
        undefined,
        undefined,
        0.0015,
        undefined,
        context(dates[0]!),
      ),
    ).toThrow("restricted");
  });

  it("leaves ordinary no-missing A0 economics identical and binds the option to a different contract", async () => {
    const inputs = dates.map(session);
    const legacyContract = await contract(false),
      enabledContract = await contract();
    expect(legacyContract.contractHash).not.toBe(enabledContract.contractHash);
    const legacy = await replayAdoptedUsBacktest(legacyContract, inputs);
    const enabled = await replayAdoptedUsBacktest(enabledContract, inputs);
    for (let i = 0; i < legacy.length; i++) {
      expect(enabled[i]!.result.trades).toEqual(legacy[i]!.result.trades);
      expect(enabled[i]!.result.nav).toBe(legacy[i]!.result.nav);
      expect(enabled[i]!.result.state.cash).toBe(legacy[i]!.result.state.cash);
      expect(enabled[i]!.result.state.totalFees).toBe(legacy[i]!.result.state.totalFees);
      expect(enabled[i]!.result.state.positions).toEqual(legacy[i]!.result.state.positions);
      expect(enabled[i]!.result.state.pendingTargets).toEqual(
        legacy[i]!.result.state.pendingTargets,
      );
      expect(enabled[i]!.rankState).toEqual(legacy[i]!.rankState);
    }
    expect(enabled[1]!.result.state.pendingTargets["T00"]?.fixedBudgetUsd).toBe("3733.572");
    expect(
      enabled.flatMap((r) => r.result.trades).some((t) => t.side.startsWith("REBALANCE")),
    ).toBe(false);
  });

  it("JSON checkpoint/restart produces exactly the same proxy audit, state and hashes", async () => {
    const c = await contract(),
      inputs = dates.map(session);
    inputs[3]!.rows = inputs[3]!.rows.filter((r) => r.symbol !== "T00");
    const uninterrupted = await replayAdoptedUsBacktest(c, inputs);
    let previous: Awaited<ReturnType<typeof stepAdoptedUsBacktest>> | null = null;
    const resumed = [];
    for (const input of inputs) {
      const next = await stepAdoptedUsBacktest(c, input, previous);
      resumed.push(next);
      previous = JSON.parse(JSON.stringify(next));
    }
    expect(resumed).toEqual(uninterrupted);
  });

  it("keeps same-OPEN ordinary sale cash immediately available for another purchase", async () => {
    const runs = await replayAdoptedUsBacktest(
      await contract(true, dates.slice(0, 3)),
      dates.slice(0, 3).map(session),
    );
    const prior = runs[2]!;
    const seeded = structuredClone(prior.result.state);
    seeded.cash = 0;
    seeded.modelCashExact = "0";
    seeded.pendingExits["T00"] = { symbol: "T00", signalDate: dates[2]!, reason: "ORDINARY_EXIT" };
    seeded.pendingTargets["T01"] = {
      symbol: "T01",
      targetWeight: 0.05,
      fixedBudgetUsd: "3733.572",
      remainingBudgetUsd: "3733.572",
      signalDate: dates[2]!,
      reason: "ENTRY_ONSET80",
    };
    const input = session(dates[3]!, 3);
    Object.assign(row(input, "T01"), { ret120: 50, ret252: 50, beta60Spy: 50, ichimokuTkGap: 50 });
    const result = stepUsProspectivePortfolio(
      US_PROSPECTIVE_STRATEGIES[0]!,
      runUsProspectiveAnalysis(input.rows, prior.rankState),
      seeded,
      prior.result.nav,
      seeded.executionPolicy,
      seeded.allocationPolicy,
      0.0015,
      CURRENT_RULES_RESEARCH,
      context(input.date),
    );
    expect(result.trades.filter((t) => t.executionDate).map((t) => t.side)).toEqual([
      "SELL",
      "BUY",
    ]);
    expect(result.state.positions["T01"]?.shares).toBe(36);
    expect(result.trades.some((t) => t.reason === US_LAST_VALID_CLOSE_POLICY_ID)).toBe(false);
  });

  it("proxy-closes only the residual after a capacity-limited ordinary OPEN sale", async () => {
    const runs = await replayAdoptedUsBacktest(
      await contract(true, dates.slice(0, 3)),
      dates.slice(0, 3).map(session),
    );
    const prior = runs[2]!;
    const seeded = structuredClone(prior.result.state);
    seeded.adv20BySymbol!["T00"] = 20_000;
    seeded.pendingExits["T00"] = { symbol: "T00", signalDate: dates[2]!, reason: "ORDINARY_EXIT" };
    const input = session(dates[3]!, 3);
    row(input).open = 200;
    row(input).close = null;
    const result = stepUsProspectivePortfolio(
      US_PROSPECTIVE_STRATEGIES[0]!,
      runUsProspectiveAnalysis(input.rows, prior.rankState),
      seeded,
      prior.result.nav,
      seeded.executionPolicy,
      seeded.allocationPolicy,
      0.0015,
      CURRENT_RULES_RESEARCH,
      context(input.date),
    );
    const sales = result.trades.filter((t) => t.executionDate);
    expect(sales.map((t) => [t.modelShares, t.modelPrice, t.feeUsd])).toEqual([
      [1, 200, 0.3],
      [36, 100, 5.4],
    ]);
    expect(result.state.positions["T00"]).toBeUndefined();
    expect(result.state.pendingExits["T00"]).toBeUndefined();
    expect(result.state.totalFees).toBe(11.25);
  });

  it("a failed missing-reference close leaves prior state unchanged and cannot lose its policy on resume", async () => {
    const runs = await replayAdoptedUsBacktest(
      await contract(true, dates.slice(0, 3)),
      dates.slice(0, 3).map(session),
    );
    const prior = runs[2]!;
    const seeded = structuredClone(prior.result.state);
    delete seeded.lastValidCloseResearch!.lastValidCloseBySymbol["T00"];
    const before = JSON.stringify(seeded);
    const input = session(dates[3]!, 3);
    input.rows = input.rows.filter((r) => r.symbol !== "T00");
    const analysis = runUsProspectiveAnalysis(input.rows, prior.rankState);
    expect(() =>
      stepUsProspectivePortfolio(
        US_PROSPECTIVE_STRATEGIES[0]!,
        analysis,
        seeded,
        prior.result.nav,
        seeded.executionPolicy,
        seeded.allocationPolicy,
        0.0015,
        CURRENT_RULES_RESEARCH,
        context(input.date),
      ),
    ).toThrow("NO_PRIOR_VALID");
    expect(JSON.stringify(seeded)).toBe(before);
    expect(() =>
      stepUsProspectivePortfolio(
        US_PROSPECTIVE_STRATEGIES[0]!,
        analysis,
        seeded,
        prior.result.nav,
        seeded.executionPolicy,
        seeded.allocationPolicy,
        0.0015,
        CURRENT_RULES_RESEARCH,
      ),
    ).toThrow("requires its frozen");
  });
});
