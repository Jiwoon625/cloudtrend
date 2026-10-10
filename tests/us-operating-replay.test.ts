import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  planUsOperatingReplay,
  hydrateUsOperatingState,
  usOperatingTradeProjection,
  usOperatingStableJson,
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

/** Each strategy inherits a real executable order; no zero-ADV/non-filling surrogate. */
function feeBoundaryFixture(date: "2026-10-07" | "2026-10-08" | "2026-10-09", sell = false) {
  const f = fixture();
  const base = {
    "2026-10-07": "2026-10-06",
    "2026-10-08": "2026-10-07",
    "2026-10-09": "2026-10-08",
  }[date];
  f.dates = [{ analysis: analysis(date), previousSessionDate: base, sourceHash: H }];
  for (const id of US_OPERATING_STRATEGY_IDS) {
    const snapshot = f.priorSnapshots[id];
    snapshot.date = base;
    if (id === "SPY_BENCHMARK") continue;
    const state = operating(f, id);
    state.lastDate = base;
    if (sell) {
      state.positions["ABC"] = {
        symbol: "ABC",
        name: "ABC",
        sector: "Technology",
        shares: 10,
        lastPrice: 100,
        entryDate: "2026-10-05",
        entryCoreRank: 0.9,
      };
      state.cash = snapshot.cash_usd = 99000;
      snapshot.positions_count = 1;
      state.pendingExits["ABC"] = { symbol: "ABC", signalDate: base, reason: "CORE_BELOW_0.70" };
    } else {
      state.pendingTargets["ABC"] = {
        symbol: "ABC",
        signalDate: base,
        reason: "ENTRY_ONSET80",
        targetWeight: 0.05,
      };
    }
  }
  return f;
}

const feeBoundaryCases = ["2026-10-07", "2026-10-08", "2026-10-09"] as const;
describe("US operating replay fee execution-date boundary", () => {
  it.each(feeBoundaryCases)(
    "reconciles real buys and sells on %s without changing other strategies",
    (date) => {
      for (const sell of [false, true]) {
        const f = feeBoundaryFixture(date, sell),
          before = structuredClone(f),
          plan = planUsOperatingReplay(f);
        const fills = plan.trades.filter((t) => t.execution_date !== null);
        expect(fills).toHaveLength(3);
        for (const t of fills) {
          const rate =
            t.strategy_id === "A0_QUARTER_PRIMARY" && date >= "2026-10-08" ? 0.0015 : 0.0025;
          expect(t.status).toBe("EXECUTED");
          expect(t.side).toBe(sell ? "SELL" : "BUY");
          expect(t.fee_usd).toBeCloseTo(t.model_notional! * rate, 10);
          expect(plan.snapshots.find((s) => s.strategy_id === t.strategy_id)!.fees_usd).toBe(
            t.fee_usd,
          );
        }
        expect(f).toEqual(before);
        expect(planUsOperatingReplay(f)).toEqual(plan);
      }
    },
  );
  it("prices one A0 order's partial fills at each execution day's rate across the cutover", () => {
    const f = feeBoundaryFixture("2026-10-07");
    operating(f).adv20BySymbol = { ABC: 50000, SPY: 1e8 };
    f.dates.push({
      analysis: analysis("2026-10-08"),
      previousSessionDate: "2026-10-07",
      sourceHash: H,
    });
    const plan = planUsOperatingReplay(f);
    const fills = plan.trades.filter(
      (t) => t.strategy_id === "A0_QUARTER_PRIMARY" && t.execution_date !== null,
    );
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({
      signal_date: "2026-10-06",
      execution_date: "2026-10-07",
      status: "PARTIAL",
      model_shares: 5,
      model_notional: 500,
      fee_usd: 1.25,
    });
    expect(fills[1]).toMatchObject({
      signal_date: "2026-10-06",
      execution_date: "2026-10-08",
      status: "EXECUTED",
      model_shares: 45,
      model_notional: 4500,
      fee_usd: 6.75,
    });
    expect(
      (
        plan.snapshots.find(
          (s) => s.strategy_id === "A0_QUARTER_PRIMARY" && s.date === "2026-10-08",
        )!.state as UsPortfolioState
      ).totalFees,
    ).toBe(8);
  });
  it("migrates the real PostgreSQL RPC, preserving permissions and rejecting wrong rates before writes", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    const dir = new URL("../supabase/migrations/", import.meta.url);
    const migration = (name: string) => readFileSync(new URL(name, dir), "utf8");
    const feeFiles = readdirSync(dir).filter((name) =>
      name.endsWith("_us_operating_replay_a0_fee_boundary.sql"),
    );
    expect(feeFiles).toHaveLength(1);
    try {
      await db.exec(
        "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select null::uuid$$; grant usage on schema public,auth to anon,authenticated,service_role;",
      );
      await db.exec(migration("20260928064908_us_prospective_pipeline_v1.sql"));
      await db.exec(migration("20261008030458_atomic_us_operating_replay.sql"));
      await db.exec(
        "grant select,insert,update on public.us_strategy_registry,public.us_portfolio_snapshots,public.us_portfolio_trades to service_role;",
      );
      const identitySql =
        "select prosecdef,proacl::text,proconfig from pg_proc where oid='public.apply_us_operating_replay(uuid,jsonb,boolean)'::regprocedure";
      const identity = await db.query(identitySql);
      await db.exec(migration(feeFiles[0]!));
      expect((await db.query(identitySql)).rows).toEqual(identity.rows);
      expect(identity.rows[0]).toMatchObject({ prosecdef: false });
      await db.exec("set role authenticated");
      await expect(
        db.query("select public.apply_us_operating_replay(null,'{}',false)"),
      ).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
      let ownerIndex = 1;
      for (const date of feeBoundaryCases)
        for (const sell of [false, true]) {
          const owner = `11111111-1111-4111-8111-${String(ownerIndex++).padStart(12, "0")}`;
          const f = feeBoundaryFixture(date, sell),
            plan = planUsOperatingReplay(f);
          await db.query("insert into auth.users(id) values ($1)", [owner]);
          const insert = async (table: string, row: Record<string, unknown>) => {
            const entries = Object.entries({ user_id: owner, ...row });
            await db.query(
              `insert into public.${table} (${entries.map(([k]) => k).join(",")}) values (${entries.map((_, i) => `$${i + 1}`).join(",")})`,
              entries.map(([, v]) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v)),
            );
          };
          for (const row of f.registries)
            await insert("us_strategy_registry", { ...row, frozen_at: "2026-09-28T00:00:00Z" });
          for (const row of Object.values(f.priorSnapshots))
            await insert("us_portfolio_snapshots", { ...row });
          await db.exec("set role service_role");
          const call = async (value: typeof plan, apply: boolean) =>
            (
              await db.query<{
                receipt: { validated?: boolean; alreadyApplied?: boolean; planHash: string };
              }>("select public.apply_us_operating_replay($1,$2::jsonb,$3) receipt", [
                owner,
                JSON.stringify(value),
                apply,
              ])
            ).rows[0]!.receipt;
          const sign = (value: typeof plan) => {
            const { planHash: ignoredHash, canonicalPayload: ignoredCanonical, ...payload } = value;
            const canonicalPayload = usOperatingStableJson(payload);
            return {
              ...payload,
              canonicalPayload,
              planHash: `sha256:${createHash("sha256").update(canonicalPayload).digest("hex")}`,
            };
          };
          for (const id of ["A0_QUARTER_PRIMARY", "A2_QUARTER_SHADOW", "B3_BETA_SHADOW"] as const) {
            const wrong = structuredClone(plan);
            const trade = wrong.trades.find(
              (t) => t.strategy_id === id && t.execution_date !== null,
            )!;
            const correct = id === "A0_QUARTER_PRIMARY" && date >= "2026-10-08" ? 0.0015 : 0.0025;
            trade.fee_usd = trade.model_notional! * (correct === 0.0015 ? 0.0025 : 0.0015);
            await expect(call(sign(wrong), true)).rejects.toThrow(
              "Invalid US model fill accounting",
            );
          }
          expect(
            (
              await db.query(
                "select count(*)::int count from public.us_portfolio_snapshots where user_id=$1",
                [owner],
              )
            ).rows[0],
          ).toEqual({ count: 4 });
          expect(
            (
              await db.query(
                "select count(*)::int count from public.us_portfolio_trades where user_id=$1",
                [owner],
              )
            ).rows[0],
          ).toEqual({ count: 0 });
          expect(await call(plan, false)).toMatchObject({
            validated: true,
            alreadyApplied: false,
            planHash: plan.planHash,
          });
          const receipt = await call(plan, true);
          expect(await call(plan, true)).toEqual(receipt);
          expect(await call(plan, false)).toMatchObject({
            validated: true,
            alreadyApplied: true,
            planHash: plan.planHash,
          });
          expect(
            (
              await db.query(
                "select count(*)::int count from public.us_portfolio_snapshots where user_id=$1",
                [owner],
              )
            ).rows[0],
          ).toEqual({ count: 8 });
          expect(
            (
              await db.query(
                "select count(*)::int count from public.us_portfolio_trades where user_id=$1 and execution_date is not null",
                [owner],
              )
            ).rows[0],
          ).toEqual({ count: 3 });
          expect(
            (
              await db.query(
                "select count(*)::int count from public.us_portfolio_trades where user_id=$1 and (actual_price is not null or actual_shares is not null or actual_fee_usd is not null)",
                [owner],
              )
            ).rows[0],
          ).toEqual({ count: 0 });
          await db.exec("reset role");
        }
    } finally {
      await db.close();
    }
  }, 30000);
});
