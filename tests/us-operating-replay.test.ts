import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  planUsOperatingReplay,
  hydrateUsOperatingState,
  usOperatingTradeProjection,
  US_OPERATING_STRATEGY_IDS,
  type UsOperatingSnapshot,
  type UsOperatingTrade,
  type UsOperatingRegistry,
  type UsOperatingStrategyId,
} from "../scripts/us-operating-replay";
import {
  US_PROSPECTIVE_RULE_VERSION,
  type UsProspectiveAnalysis,
  type UsProspectiveRow,
} from "../src/lib/engine/usProspective";
import {
  stepUsProspectiveOperatingPortfolio,
  usFixedSlotAllocationPolicy,
  US_PROSPECTIVE_STRATEGIES,
  type UsPortfolioState,
} from "../src/lib/engine/usProspectivePortfolio";
const H = `sha256:${"a".repeat(64)}`;
function row(
  date: string,
  symbol = "ABC",
  changes: Partial<UsProspectiveRow> = {},
): UsProspectiveRow {
  return {
    date,
    symbol,
    name: symbol,
    market: "NASDAQ",
    sector: "Technology",
    securityType: "COMMON",
    status: "ACTIVE",
    currency: "USD",
    open: 100,
    high: 110,
    low: 90,
    close: 100,
    volume: 10000,
    dollarVolume: 1000000,
    sharesOutstanding: 1000000,
    marketCap: 1e9,
    ret120: 1,
    ret252: 1,
    beta60Spy: 1,
    ichimokuTkGap: 1,
    relvol1_20: 1,
    adv20Usd: 1e8,
    amihud20: 0.01,
    active20: true,
    tossTradable: true,
    isCommonShare: true,
    fxUsdKrw: 1400,
    ret120Rank: 0.9,
    ret252Rank: 0.9,
    coreScore: 0.9,
    coreRank: 0.9,
    betaRank: 0.9,
    tkRank: 0.9,
    relvolRank: 0.9,
    liquidityRank: 0.9,
    amihudRank: 0.9,
    eligibleBase: true,
    onset80: false,
    aggressiveConfirm: true,
    balancedConfirm: true,
    a0Entry: false,
    a0Exit: false,
    a0BetaExit: false,
    a2Entry: false,
    a2Exit: false,
    b3Entry: false,
    b3Exit: false,
    b3BaseExit: false,
    betaWeakStreak: 0,
    b3BetaExit: false,
    primarySignal: "NONE",
    ...changes,
  };
}
function analysis(date: string, changes: Partial<UsProspectiveRow> = {}): UsProspectiveAnalysis {
  return {
    date,
    ruleVersion: US_PROSPECTIVE_RULE_VERSION,
    rows: [row(date, "ABC", changes), row(date, "SPY")],
    state: { lastDate: date, coreRanks: { ABC: 0.9 }, betaWeakStreak: { ABC: 0 } },
    summary: {
      inputRows: 2,
      rankedRows: 1,
      a0Entries: 0,
      a0Exits: 0,
      a2Entries: 0,
      a2Exits: 0,
      b3Entries: 0,
      b3Exits: 0,
      spyClose: 100,
    },
  };
}
function fixture() {
  const registries: UsOperatingRegistry[] = US_PROSPECTIVE_STRATEGIES.map((s) => ({
    strategy_id: s.id,
    label: s.label,
    role: s.role,
    rule_version: US_PROSPECTIVE_RULE_VERSION,
    config: structuredClone(s),
    active: true,
  }));
  registries.push({
    strategy_id: "SPY_BENCHMARK",
    label: "SPY Benchmark",
    role: "BENCHMARK",
    rule_version: US_PROSPECTIVE_RULE_VERSION,
    config: { symbol: "SPY", initialCapital: 100000 },
    active: true,
  });
  const priorSnapshots = {} as Record<UsOperatingStrategyId, UsOperatingSnapshot>;
  for (const id of US_OPERATING_STRATEGY_IDS) {
    const state: UsPortfolioState = {
      initializedDate: "2026-09-28",
      lastDate: "2026-10-05",
      initialCapital: 100000,
      cash: 100000,
      positions: {},
      pendingTargets: {},
      pendingExits: {},
      lastQuarterRebalance: null,
      benchmarkBasePrice: 100,
      benchmarkBaseDate: "2026-09-28",
      totalFees: 0,
      adv20BySymbol: { ABC: 1e8, SPY: 1e8 },
    };
    priorSnapshots[id] = {
      strategy_id: id,
      date: "2026-10-05",
      rule_version: US_PROSPECTIVE_RULE_VERSION,
      nav_usd: 100000,
      cash_usd: id === "SPY_BENCHMARK" ? 0 : 100000,
      benchmark_nav: 100000,
      daily_return: 0,
      cumulative_return: 0,
      turnover: 0,
      fees_usd: 0,
      positions_count: id === "SPY_BENCHMARK" ? 1 : 0,
      state: id === "SPY_BENCHMARK" ? { basePrice: 100, currentPrice: 100, symbol: "SPY" } : state,
    };
  }
  return {
    dates: [
      {
        analysis: analysis("2026-10-06", {
          a0Entry: true,
          a2Entry: true,
          b3Entry: true,
          onset80: true,
        }),
        previousSessionDate: "2026-10-05",
        sourceHash: H,
      },
      {
        analysis: analysis("2026-10-07", { open: 101, close: 105 }),
        previousSessionDate: "2026-10-06",
        sourceHash: H,
      },
    ],
    priorSnapshots,
    registries,
    existingTrades: [] as UsOperatingTrade[],
  };
}
const operating = (
  f: ReturnType<typeof fixture>,
  id: UsOperatingStrategyId = "A0_QUARTER_PRIMARY",
) => f.priorSnapshots[id].state as UsPortfolioState;
function held(f: ReturnType<typeof fixture>) {
  const s = operating(f);
  s.positions.ABC = {
    symbol: "ABC",
    name: "ABC",
    sector: "Technology",
    shares: 10,
    lastPrice: 100,
    entryDate: "2026-10-05",
    entryCoreRank: 0.9,
  };
  s.cash = 99000;
  f.priorSnapshots.A0_QUARTER_PRIMARY.cash_usd = 99000;
  f.priorSnapshots.A0_QUARTER_PRIMARY.positions_count = 1;
}
function pendingTrade(): UsOperatingTrade {
  return {
    trade_key: "A0_QUARTER_PRIMARY|2026-10-05|PENDING|ABC|BUY|ENTRY_ONSET80",
    strategy_id: "A0_QUARTER_PRIMARY",
    signal_date: "2026-10-05",
    execution_date: null,
    symbol: "ABC",
    name: "ABC",
    sector: "Technology",
    side: "BUY",
    reason: "ENTRY_ONSET80",
    status: "PENDING",
    model_price: null,
    model_shares: null,
    model_notional: 5000,
    fee_usd: 0,
    core_rank: 0.9,
    detail: { original: true },
  };
}
describe("US operating chronological recovery planner", () => {
  it("replays both dates into four books, reconciling unchanged engine outputs and preserving inputs", () => {
    const f = fixture(),
      before = structuredClone(f),
      plan = planUsOperatingReplay(f);
    expect(f).toEqual(before);
    expect(plan.snapshots).toHaveLength(8);
    expect(plan.baseDate).toBe("2026-10-05");
    expect(plan.throughDate).toBe("2026-10-07");
    expect(plan.trades.filter((t) => t.status === "EXECUTED")).toHaveLength(3);
    expect(plan.trades.filter((t) => t.status === "CANCELLED")).toHaveLength(3);
    for (const strategy of US_PROSPECTIVE_STRATEGIES) {
      let state = operating(f, strategy.id),
        nav = f.priorSnapshots[strategy.id].nav_usd;
      for (const d of f.dates) {
        const direct = stepUsProspectiveOperatingPortfolio(strategy, d.analysis, state, nav);
        const snapshot = plan.snapshots.find(
          (s) => s.strategy_id === strategy.id && s.date === d.analysis.date,
        )!;
        expect(snapshot.nav_usd).toBe(direct.nav);
        expect(snapshot.cash_usd).toBe(direct.cash);
        expect(snapshot.state).toMatchObject(direct.state);
        expect((snapshot.state as UsPortfolioState).positions).toEqual(direct.state.positions);
        expect(snapshot.state).toHaveProperty("orderPreview");
        expect(snapshot.state).toHaveProperty("recoveryEvidence.sourceHash", H);
        state = direct.state;
        nav = direct.nav;
      }
    }
    expect(plan.planHash).toBe(
      `sha256:${createHash("sha256").update(plan.canonicalPayload).digest("hex")}`,
    );
    const { planHash, canonicalPayload, ...payload } = plan;
    expect(JSON.parse(canonicalPayload)).toEqual(payload);
    expect(planUsOperatingReplay(structuredClone(f))).toEqual(plan);
  });
  it("does not mutate existing pending model/actual fields; resolves only finished intent", () => {
    const f = fixture(),
      t = { ...pendingTrade(), actual_price: 98, actual_shares: 4, actual_fee_usd: 1 };
    f.existingTrades.push(t);
    operating(f).pendingTargets.ABC = {
      symbol: "ABC",
      signalDate: "2026-10-05",
      targetWeight: 0.05,
      reason: "ENTRY_ONSET80",
    };
    const before = structuredClone(t),
      plan = planUsOperatingReplay(f);
    expect(t).toEqual(before);
    expect(plan.pendingResolutions).toHaveLength(1);
    expect(plan.pendingResolutions[0]).toMatchObject({
      trade_key: t.trade_key,
      resolved_on: "2026-10-06",
    });
    expect(plan.pendingResolutions[0]!.expected).toEqual(usOperatingTradeProjection(t));
    expect(JSON.stringify(plan)).not.toContain("actual_price");
    expect(plan.trades.some((x) => x.trade_key === t.trade_key)).toBe(false);
  });
  it("leaves preexisting pending row untouched when insufficient preceding-close capacity carries it forward", () => {
    const f = fixture();
    f.existingTrades = [pendingTrade()];
    const s = operating(f);
    s.pendingTargets.ABC = {
      symbol: "ABC",
      signalDate: "2026-10-05",
      targetWeight: 0.05,
      reason: "ENTRY_ONSET80",
    };
    s.adv20BySymbol = { ABC: 0 };
    f.dates = f.dates.slice(0, 1);
    const plan = planUsOperatingReplay(f);
    expect(plan.pendingResolutions).toEqual([]);
    expect(plan.trades.some((t) => t.trade_key === f.existingTrades[0]!.trade_key)).toBe(false);
  });
  it.each(["missing", "stale", "nullOpen", "nullClose", "nullHigh", "badRange"])(
    "fails closed on held %s OHLC",
    (kind) => {
      const f = fixture();
      held(f);
      const a = f.dates[0]!.analysis;
      if (kind === "missing") a.rows = a.rows.filter((r) => r.symbol !== "ABC");
      else if (kind === "stale") a.rows[0]!.date = "2026-10-05";
      else if (kind === "nullOpen") a.rows[0]!.open = null;
      else if (kind === "nullClose") a.rows[0]!.close = null;
      else if (kind === "nullHigh") a.rows[0]!.high = null;
      else a.rows[0]!.low = 101;
      expect(() => planUsOperatingReplay(f)).toThrow(/OHLC|wrong-date/);
    },
  );
  it("requires fresh rows even for pending exits that would otherwise be silently carried", () => {
    const f = fixture();
    held(f);
    operating(f).pendingExits.ABC = {
      symbol: "ABC",
      signalDate: "2026-10-05",
      reason: "CORE_BELOW_0.70",
    };
    f.dates[0]!.analysis.rows[0]!.open = null;
    expect(() => planUsOperatingReplay(f)).toThrow(/OHLC/);
  });
  it("requires fresh pending buys even with no held position", () => {
    const f = fixture();
    operating(f).pendingTargets.ABC = {
      symbol: "ABC",
      signalDate: "2026-10-05",
      targetWeight: 0.05,
      reason: "ENTRY_ONSET80",
    };
    f.dates[0]!.analysis.rows[0]!.close = null;
    expect(() => planUsOperatingReplay(f)).toThrow(/OHLC/);
  });
  it("rejects a missing middle session even if metadata falsely claims continuity", () => {
    const f = fixture();
    f.dates = f.dates.slice(1);
    f.dates[0]!.previousSessionDate = "2026-10-05";
    expect(() => planUsOperatingReplay(f)).toThrow(/continuity/);
  });
  it("rejects shuffled dates, wrong predecessor metadata, duplicate symbols, or a wrong analysis state date", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => f.dates.reverse(),
      (f: ReturnType<typeof fixture>) => {
        f.dates[1]!.previousSessionDate = "2026-10-05";
      },
      (f: ReturnType<typeof fixture>) => {
        f.dates[0]!.analysis.rows.push(f.dates[0]!.analysis.rows[0]!);
      },
      (f: ReturnType<typeof fixture>) => {
        f.dates[0]!.analysis.state.lastDate = "2026-10-05";
      },
    ]) {
      const f = fixture();
      mutate(f);
      expect(() => planUsOperatingReplay(f)).toThrow();
    }
  });
  it("rejects rule/config drift, missing/duplicate/inactive registry and misaligned snapshots", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.registries[0]!.config = {};
      },
      (f: ReturnType<typeof fixture>) => {
        f.registries[0]!.rule_version = "other";
      },
      (f: ReturnType<typeof fixture>) => {
        f.registries.pop();
      },
      (f: ReturnType<typeof fixture>) => {
        f.registries.push(f.registries[0]!);
      },
      (f: ReturnType<typeof fixture>) => {
        f.registries[0]!.active = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.priorSnapshots.SPY_BENCHMARK.date = "2026-10-02";
      },
    ]) {
      const f = fixture();
      mutate(f);
      expect(() => planUsOperatingReplay(f)).toThrow();
    }
  });
  it("rejects nonfinite prices, corrupt cash, negative/fractional shares, or isolated Shadow state", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.dates[0]!.analysis.rows[0]!.close = NaN;
      },
      (f: ReturnType<typeof fixture>) => {
        operating(f).cash = 90000;
      },
      (f: ReturnType<typeof fixture>) => {
        held(f);
        operating(f).positions.ABC!.shares = 0.5;
      },
      (f: ReturnType<typeof fixture>) => {
        (operating(f) as unknown as Record<string, unknown>).executionPolicy = {
          version: "isolated-us-model-v1",
        };
      },
    ]) {
      const f = fixture();
      mutate(f);
      expect(() => planUsOperatingReplay(f)).toThrow();
    }
  });
  it("reconciles a sell followed by a fresh close, preserving original initialization", () => {
    const f = fixture();
    held(f);
    operating(f).pendingExits.ABC = {
      symbol: "ABC",
      signalDate: "2026-10-05",
      reason: "CORE_BELOW_0.70",
    };
    const plan = planUsOperatingReplay(f),
      sell = plan.trades.find((t) => t.side === "SELL" && t.status === "EXECUTED")!;
    expect(sell.model_shares).toBe(10);
    expect(sell.model_price).toBe(100);
    expect(sell.fee_usd).toBe(2.5);
    const first = plan.snapshots[0]!;
    expect(first.cash_usd).toBe(99997.5);
    expect((first.state as UsPortfolioState).initializedDate).toBe("2026-09-28");
  });
  it("rejects a stale second-session mark after a first-session fill, with no partial output or input mutation", () => {
    const f = fixture();
    operating(f).pendingTargets.ABC = {
      symbol: "ABC",
      signalDate: "2026-10-05",
      targetWeight: 0.05,
      reason: "ENTRY_ONSET80",
    };
    f.dates[1]!.analysis.rows[0]!.close = null;
    const before = structuredClone(f);
    expect(() => planUsOperatingReplay(f)).toThrow(/OHLC/);
    expect(f).toEqual(before);
  });
  it("retains original pending identity across partial fills and obeys preceding-close capacity", () => {
    const f = fixture();
    const original = pendingTrade();
    f.existingTrades = [original];
    const state = operating(f);
    state.pendingTargets.ABC = {
      symbol: "ABC",
      signalDate: "2026-10-05",
      targetWeight: 0.05,
      reason: "ENTRY_ONSET80",
    };
    state.adv20BySymbol = { ABC: 50000 };
    const plan = planUsOperatingReplay(f);
    const fills = plan.trades.filter(
      (t) => t.strategy_id === "A0_QUARTER_PRIMARY" && t.execution_date !== null,
    );
    expect(fills[0]).toMatchObject({
      execution_date: "2026-10-06",
      model_shares: 5,
      status: "PARTIAL",
    });
    expect(fills[1]).toMatchObject({
      execution_date: "2026-10-07",
      model_shares: 44,
      status: "PARTIAL",
    });
    expect(plan.pendingResolutions).toEqual([]);
    expect(plan.trades.some((t) => t.trade_key === original.trade_key)).toBe(false);
    expect(
      (
        plan.snapshots.find(
          (s) => s.strategy_id === "A0_QUARTER_PRIMARY" && s.date === "2026-10-07",
        )!.state as UsPortfolioState
      ).positions.ABC!.shares,
    ).toBe(49);
  });
  it("keeps persistence service-only, append-only snapshots and explicit model-only trade columns", () => {
    const sql = readFileSync(
      new URL(
        "../supabase/migrations/20261008030458_atomic_us_operating_replay.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain("security invoker");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).not.toMatch(/on\s+conflict\s+.*\s+do\s+update/i);
    expect(sql).not.toMatch(/update\s+public\.us_portfolio_snapshots/i);
    expect(sql).not.toMatch(/set\s+actual_/i);
    expect(sql).toContain(
      "grant execute on function public.apply_us_operating_replay(uuid,jsonb,boolean) to service_role",
    );
  });
});

describe("stored US allocation policy order", () => {
  const jsonbPolicy = () => ({
    version: "us-initial-capital-slots-v1" as const,
    effectiveDate: "2026-10-05" as const,
    targetPositions: 20 as const,
    fundingOnlySales: false as const,
    initialCapitalUsd: "100000",
    quarterlyRebalance: false as const,
  });
  it("reproduces the JSONB order failure and preserves every policy value after hydration", () => {
    const f = fixture(),
      state = operating(f);
    state.allocationPolicy = jsonbPolicy();
    const before = JSON.stringify(state);
    expect(() =>
      stepUsProspectiveOperatingPortfolio(
        US_PROSPECTIVE_STRATEGIES[0]!,
        f.dates[0]!.analysis,
        state,
        100000,
      ),
    ).toThrow("capital and identity");
    const hydrated = hydrateUsOperatingState(state);
    expect(hydrated).toEqual(state);
    expect(JSON.stringify(state)).toBe(before);
    expect(JSON.stringify(hydrated.allocationPolicy)).toBe(
      JSON.stringify(usFixedSlotAllocationPolicy(100000)),
    );
    expect(() =>
      stepUsProspectiveOperatingPortfolio(
        US_PROSPECTIVE_STRATEGIES[0]!,
        f.dates[0]!.analysis,
        hydrated,
        100000,
      ),
    ).not.toThrow();
  });
  it("produces the same exact two-day plan for canonical and JSONB-ordered predecessors", () => {
    const a = fixture(),
      b = fixture();
    for (const strategy of US_PROSPECTIVE_STRATEGIES) {
      operating(a, strategy.id).allocationPolicy = usFixedSlotAllocationPolicy(100000);
      operating(b, strategy.id).allocationPolicy = jsonbPolicy();
    }
    const original = JSON.stringify(b);
    expect(planUsOperatingReplay(b)).toEqual(planUsOperatingReplay(a));
    expect(JSON.stringify(b)).toBe(original);
  });
  it.each([
    { initialCapitalUsd: "90000" },
    { targetPositions: 10 },
    { effectiveDate: "2026-10-06" },
    { version: "different" },
    { fundingOnlySales: true },
    { quarterlyRebalance: true },
    { extra: true },
  ])("still rejects a changed policy value %j", (change) => {
    const f = fixture();
    operating(f).allocationPolicy = {
      ...jsonbPolicy(),
      ...change,
    } as UsPortfolioState["allocationPolicy"];
    expect(() => planUsOperatingReplay(f)).toThrow("capital or identity");
  });
});
