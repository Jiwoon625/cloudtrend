/** Pure, fail-closed replay of the existing US operating books. No I/O or new engine rules. */
import { createHash } from "node:crypto";
import {
  US_PROSPECTIVE_RULE_VERSION,
  type UsProspectiveAnalysis,
  type UsProspectiveRow,
} from "../src/lib/engine/usProspective";
import {
  stepUsProspectiveOperatingPortfolio,
  usFixedSlotAllocationPolicy,
  usOperatingOneWayCost,
  US_PROSPECTIVE_STRATEGIES,
  type UsPortfolioState,
  type UsModelTrade,
  type UsPortfolioStepResult,
} from "../src/lib/engine/usProspectivePortfolio";
import {
  buildUsOrderPreview,
  isScheduledUsSession,
  nextScheduledUsSession,
} from "../src/lib/engine/usProspectiveOrderPreview";

export const US_OPERATING_REPLAY_VERSION = "us-operating-replay-v1" as const;
export const US_OPERATING_STRATEGY_IDS = [
  "A0_QUARTER_PRIMARY",
  "A2_QUARTER_SHADOW",
  "B3_BETA_SHADOW",
  "SPY_BENCHMARK",
] as const;
export type UsOperatingStrategyId = (typeof US_OPERATING_STRATEGY_IDS)[number];
export interface UsOperatingRegistry {
  strategy_id: UsOperatingStrategyId;
  label: string;
  role: string;
  rule_version: string;
  config: unknown;
  active: boolean;
}
export interface UsOperatingSnapshot {
  strategy_id: UsOperatingStrategyId;
  date: string;
  rule_version: string;
  nav_usd: number;
  cash_usd: number;
  benchmark_nav: number | null;
  daily_return: number | null;
  cumulative_return: number | null;
  turnover: number;
  fees_usd: number;
  positions_count: number;
  state: UsPortfolioState | { basePrice: number; currentPrice: number; symbol: string };
}
/** Deliberately no actual execution columns or server timestamps. */
export interface UsOperatingTrade {
  trade_key: string;
  strategy_id: UsOperatingStrategyId;
  signal_date: string;
  execution_date: string | null;
  symbol: string;
  name: string | null;
  sector: string | null;
  side: UsModelTrade["side"];
  reason: string;
  status: UsModelTrade["status"] | "CANCELLED" | "SKIPPED";
  model_price: number | null;
  model_shares: number | null;
  model_notional: number | null;
  fee_usd: number;
  core_rank: number | null;
  detail: Record<string, unknown>;
}
export interface UsOperatingReplayDate {
  analysis: UsProspectiveAnalysis;
  previousSessionDate: string;
  /** A verified immutable, genuine point-in-time source. Source certification is the caller's job. */
  sourceHash: string;
}
export interface UsOperatingReplayPayload {
  version: typeof US_OPERATING_REPLAY_VERSION;
  baseDate: string;
  throughDate: string;
  ruleVersion: string;
  dates: Array<{ date: string; previousSessionDate: string; sourceHash: string }>;
  expectedRegistries: UsOperatingRegistry[];
  expectedSnapshots: UsOperatingSnapshot[];
  expectedPendingTrades: UsOperatingTrade[];
  snapshots: UsOperatingSnapshot[];
  trades: UsOperatingTrade[];
  pendingResolutions: Array<{ trade_key: string; expected: UsOperatingTrade; resolved_on: string }>;
}
export interface UsOperatingReplayPlan extends UsOperatingReplayPayload {
  planHash: string;
  /** SQL verifies this exact UTF-8 hash and its parsed equality to the complete payload. */
  canonicalPayload: string;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const validDate = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export function usOperatingStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(usOperatingStableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${usOperatingStableJson(v)}`)
      .join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Nonfinite replay value");
  return JSON.stringify(value);
}
const eq = (a: unknown, b: unknown) => usOperatingStableJson(a) === usOperatingStableJson(b);

/** JSONB preserves policy values, not insertion order. Validate the whole stored
 * policy semantically, then restore the frozen engine's constructor order on a
 * copy. Do not rewrite prior snapshots or change any policy/capital value. */
export function hydrateUsOperatingState(state: UsPortfolioState): UsPortfolioState {
  if (!state.allocationPolicy) return state;
  if (!positive(state.initialCapital)) throw new Error("Invalid stored US initial capital");
  const expected = usFixedSlotAllocationPolicy(state.initialCapital);
  if (!eq(state.allocationPolicy, expected))
    throw new Error("Stored US fixed-slot policy differs from its initial capital or identity");
  return { ...state, allocationPolicy: expected };
}
function near(a: number, b: number, label: string) {
  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    Math.abs(a - b) > Math.max(1e-7, Math.abs(b) * 1e-10)
  )
    throw new Error(`US replay reconciliation failed: ${label}`);
}
function finiteNonnegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`);
}
export function usOperatingSnapshotProjection(s: UsOperatingSnapshot): UsOperatingSnapshot {
  return clone({
    strategy_id: s.strategy_id,
    date: s.date,
    rule_version: s.rule_version,
    nav_usd: s.nav_usd,
    cash_usd: s.cash_usd,
    benchmark_nav: s.benchmark_nav,
    daily_return: s.daily_return,
    cumulative_return: s.cumulative_return,
    turnover: s.turnover,
    fees_usd: s.fees_usd,
    positions_count: s.positions_count,
    state: s.state,
  });
}
export function usOperatingTradeProjection(t: UsOperatingTrade): UsOperatingTrade {
  return clone({
    trade_key: t.trade_key,
    strategy_id: t.strategy_id,
    signal_date: t.signal_date,
    execution_date: t.execution_date,
    symbol: t.symbol,
    name: t.name,
    sector: t.sector,
    side: t.side,
    reason: t.reason,
    status: t.status,
    model_price: t.model_price,
    model_shares: t.model_shares,
    model_notional: t.model_notional,
    fee_usd: t.fee_usd,
    core_rank: t.core_rank,
    detail: t.detail,
  });
}
function registryProjection(r: UsOperatingRegistry): UsOperatingRegistry {
  return clone({
    strategy_id: r.strategy_id,
    label: r.label,
    role: r.role,
    rule_version: r.rule_version,
    config: r.config,
    active: r.active,
  });
}
function tradeRow(t: UsModelTrade): UsOperatingTrade {
  return {
    trade_key: t.tradeKey,
    strategy_id: t.strategyId,
    signal_date: t.signalDate,
    execution_date: t.executionDate,
    symbol: t.symbol,
    name: t.name,
    sector: t.sector,
    side: t.side,
    reason: t.reason,
    status: t.status,
    model_price: t.modelPrice,
    model_shares: t.modelShares,
    model_notional: t.modelNotional,
    fee_usd: t.feeUsd,
    core_rank: t.coreRank,
    detail: clone(t.detail),
  };
}
function validateState(snapshot: UsOperatingSnapshot) {
  if (!validDate(snapshot.date) || snapshot.rule_version !== US_PROSPECTIVE_RULE_VERSION)
    throw new Error("Invalid predecessor date or rule version");
  finiteNonnegative(snapshot.nav_usd, "predecessor NAV");
  finiteNonnegative(snapshot.cash_usd, "predecessor cash");
  if (snapshot.strategy_id === "SPY_BENCHMARK") {
    const s = snapshot.state as { basePrice: number; currentPrice: number; symbol: string };
    if (s.symbol !== "SPY" || !positive(s.basePrice) || !positive(s.currentPrice))
      throw new Error("Invalid SPY predecessor state");
    near(snapshot.nav_usd, (100000 * s.currentPrice) / s.basePrice, "SPY predecessor NAV");
    near(snapshot.cash_usd, 0, "SPY predecessor cash");
    return;
  }
  const s = snapshot.state as UsPortfolioState;
  if (
    s.executionPolicy ||
    s.lastDate !== snapshot.date ||
    !positive(s.initialCapital) ||
    !s.positions ||
    !s.pendingTargets ||
    !s.pendingExits ||
    !validDate(s.initializedDate) ||
    s.initializedDate > snapshot.date
  )
    throw new Error("Invalid operating predecessor state");
  finiteNonnegative(s.cash, "state cash");
  finiteNonnegative(s.totalFees, "state fees");
  near(s.cash, snapshot.cash_usd, "predecessor cash/state");
  let value = 0;
  for (const [symbol, p] of Object.entries(s.positions)) {
    if (
      p.symbol !== symbol ||
      !Number.isSafeInteger(p.shares) ||
      p.shares <= 0 ||
      !positive(p.lastPrice) ||
      !validDate(p.entryDate) ||
      p.entryDate > snapshot.date
    )
      throw new Error("Invalid predecessor position");
    value += p.shares * p.lastPrice;
  }
  if (snapshot.positions_count !== Object.keys(s.positions).length)
    throw new Error("Predecessor position count mismatch");
  near(s.cash + value, snapshot.nav_usd, "predecessor NAV/state");
  for (const [symbol, p] of [
    ...Object.entries(s.pendingTargets),
    ...Object.entries(s.pendingExits),
  ]) {
    if (symbol !== p.symbol || !validDate(p.signalDate) || p.signalDate > snapshot.date)
      throw new Error("Invalid predecessor pending date");
  }
}
function requireFreshOhlc(row: UsProspectiveRow | undefined, date: string, symbol: string) {
  if (
    !row ||
    row.date !== date ||
    !positive(row.open) ||
    !positive(row.high) ||
    !positive(row.low) ||
    !positive(row.close) ||
    row.low > Math.min(row.open, row.close) ||
    row.high < Math.max(row.open, row.close) ||
    row.low > row.high
  )
    throw new Error(`Fresh current-session OHLC required: ${date} ${symbol}`);
}
function reconcile(
  previous: UsPortfolioState,
  result: UsPortfolioStepResult,
  analysis: UsProspectiveAnalysis,
) {
  const rows = new Map(analysis.rows.map((r) => [r.symbol, r]));
  const quantities = new Map(Object.entries(previous.positions).map(([s, p]) => [s, p.shares]));
  let cash = previous.cash,
    fees = 0,
    turnover = 0;
  for (const t of result.trades) {
    if (t.status === "PENDING") continue;
    const row = rows.get(t.symbol);
    requireFreshOhlc(row, analysis.date, t.symbol);
    if (
      t.executionDate !== analysis.date ||
      t.signalDate >= analysis.date ||
      !Number.isSafeInteger(t.modelShares) ||
      !positive(t.modelShares) ||
      !positive(t.modelPrice)
    )
      throw new Error("Invalid replay fill");
    near(t.modelPrice, row!.open!, "fill must use current open");
    const amount = t.modelShares * t.modelPrice;
    near(t.modelNotional!, amount, "fill notional");
    near(t.feeUsd, amount * usOperatingOneWayCost(t.strategyId, analysis.date), "fill fee");
    const buy = t.side === "BUY" || t.side === "REBALANCE_BUY";
    cash += (buy ? -amount : amount) - t.feeUsd;
    quantities.set(
      t.symbol,
      (quantities.get(t.symbol) ?? 0) + (buy ? t.modelShares : -t.modelShares),
    );
    if (quantities.get(t.symbol)! < 0 || cash < -1e-7)
      throw new Error("Replay overspend or oversell");
    fees += t.feeUsd;
    turnover += amount;
  }
  for (const symbol of new Set([...quantities.keys(), ...Object.keys(result.state.positions)]))
    near(
      quantities.get(symbol) ?? 0,
      result.state.positions[symbol]?.shares ?? 0,
      "position shares",
    );
  const holdings = Object.values(result.state.positions).reduce((sum, p) => {
    requireFreshOhlc(rows.get(p.symbol), analysis.date, p.symbol);
    near(p.lastPrice, rows.get(p.symbol)!.close!, "closing mark");
    return sum + p.shares * p.lastPrice;
  }, 0);
  near(cash, result.cash, "cash");
  near(result.state.cash, result.cash, "cash/state");
  near(result.nav, cash + holdings, "NAV");
  near(result.feesUsd, fees, "fees");
  near(result.state.totalFees, previous.totalFees + fees, "cumulative fees");
  near(result.turnover, result.nav > 0 ? turnover / result.nav : 0, "turnover");
}

export function planUsOperatingReplay(input: {
  dates: UsOperatingReplayDate[];
  priorSnapshots: Record<UsOperatingStrategyId, UsOperatingSnapshot>;
  registries: UsOperatingRegistry[];
  existingTrades: UsOperatingTrade[];
}): UsOperatingReplayPlan {
  if (!input.dates.length) throw new Error("US replay requires at least one session");
  const expectedSnapshots = US_OPERATING_STRATEGY_IDS.map((id) => {
    const s = input.priorSnapshots[id];
    if (!s || s.strategy_id !== id) throw new Error(`Missing predecessor: ${id}`);
    // Validate before cloning, since JSON serialization would mask NaN/Infinity.
    usOperatingStableJson(s);
    validateState(s);
    return usOperatingSnapshotProjection(s);
  });
  const baseDate = expectedSnapshots[0]!.date;
  if (expectedSnapshots.some((s) => s.date !== baseDate))
    throw new Error("All four predecessors must have the same date");
  const expectedRegistries = US_OPERATING_STRATEGY_IDS.map((id) => {
    const matches = input.registries.filter((r) => r.strategy_id === id);
    const r = matches[0];
    const strategy = US_PROSPECTIVE_STRATEGIES.find((s) => s.id === id);
    if (
      matches.length !== 1 ||
      !r ||
      r.active !== true ||
      r.rule_version !== US_PROSPECTIVE_RULE_VERSION ||
      !eq(r.config, strategy ?? { symbol: "SPY", initialCapital: 100000 }) ||
      r.label !== (strategy?.label ?? "SPY Benchmark") ||
      r.role !== (strategy?.role ?? "BENCHMARK")
    )
      throw new Error(`Frozen registry mismatch: ${id}`);
    return registryProjection(r);
  });
  const expectedPendingTrades = input.existingTrades
    .filter(
      (t) =>
        t.status === "PENDING" &&
        US_OPERATING_STRATEGY_IDS.includes(t.strategy_id) &&
        t.strategy_id !== "SPY_BENCHMARK",
    )
    .map(usOperatingTradeProjection)
    .sort((a, b) => a.trade_key.localeCompare(b.trade_key));
  if (
    new Set(expectedPendingTrades.map((t) => t.trade_key)).size !== expectedPendingTrades.length ||
    expectedPendingTrades.some((t) => t.execution_date !== null || t.signal_date > baseDate)
  )
    throw new Error("Invalid predecessor pending trades");
  const originalPending = new Map(expectedPendingTrades.map((t) => [t.trade_key, t]));
  const activePending = new Map(originalPending);
  const newTrades = new Map<string, UsOperatingTrade>();
  const pendingResolutions: UsOperatingReplayPayload["pendingResolutions"] = [];
  const snapshots: UsOperatingSnapshot[] = [];
  const states = new Map(expectedSnapshots.map((s) => [s.strategy_id, s]));
  let previousDate = baseDate;
  for (const source of input.dates) {
    const a = source.analysis;
    if (
      !validDate(a.date) ||
      !isScheduledUsSession(a.date) ||
      source.previousSessionDate !== previousDate ||
      nextScheduledUsSession(previousDate) !== a.date ||
      a.ruleVersion !== US_PROSPECTIVE_RULE_VERSION ||
      a.state.lastDate !== a.date ||
      !/^sha256:[a-f0-9]{64}$/.test(source.sourceHash)
    )
      throw new Error("US replay session continuity/rule/source mismatch");
    usOperatingStableJson(a);
    const rows = new Map(a.rows.map((r) => [r.symbol, r]));
    if (!a.rows.length || rows.size !== a.rows.length || a.rows.some((r) => r.date !== a.date))
      throw new Error("Duplicate or wrong-date US replay rows");
    requireFreshOhlc(rows.get("SPY"), a.date, "SPY");
    for (const strategy of US_PROSPECTIVE_STRATEGIES) {
      const previous = states.get(strategy.id)!;
      const state = previous.state as UsPortfolioState;
      const required = new Set([
        ...Object.keys(state.positions),
        ...Object.keys(state.pendingTargets),
        ...Object.keys(state.pendingExits),
        ...a.rows.filter((r) => r.a0Entry || r.a2Entry || r.b3Entry).map((r) => r.symbol),
      ]);
      for (const symbol of required) requireFreshOhlc(rows.get(symbol), a.date, symbol);
      const result = stepUsProspectiveOperatingPortfolio(
        strategy,
        a,
        hydrateUsOperatingState(state),
        previous.nav_usd,
      );
      reconcile(state, result, a);
      const snapshot: UsOperatingSnapshot = {
        strategy_id: strategy.id,
        date: a.date,
        rule_version: a.ruleVersion,
        nav_usd: result.nav,
        cash_usd: result.cash,
        benchmark_nav: result.benchmarkNav,
        daily_return: result.dailyReturn,
        cumulative_return: result.cumulativeReturn,
        turnover: result.turnover,
        fees_usd: result.feesUsd,
        positions_count: result.positionsCount,
        state: {
          ...result.state,
          orderPreview: buildUsOrderPreview(strategy, result.state, a.rows),
          recoveryEvidence: {
            version: "us-dated-replay-v1",
            sourceHash: source.sourceHash,
            baseDate,
            originalScreeningPreserved: true,
          },
        } as UsPortfolioState,
      };
      validateState(snapshot);
      snapshots.push(snapshot);
      states.set(strategy.id, snapshot);
      const today = result.trades.map(tradeRow);
      const pendingKeys = new Set(
        today.filter((t) => t.status === "PENDING").map((t) => t.trade_key),
      );
      for (const [key, old] of activePending) {
        if (old.strategy_id !== strategy.id || pendingKeys.has(key)) continue;
        activePending.delete(key);
        if (originalPending.has(key))
          pendingResolutions.push({
            trade_key: key,
            expected: originalPending.get(key)!,
            resolved_on: a.date,
          });
        else
          newTrades.set(key, {
            ...newTrades.get(key)!,
            status: "CANCELLED",
            detail: {
              ...old.detail,
              resolution: "ROLLED_FORWARD_OR_RESOLVED",
              resolved_on: a.date,
            },
          });
      }
      for (const trade of today) {
        if (trade.status === "PENDING") {
          activePending.set(trade.trade_key, trade);
          // Existing pending rows keep every original field; final resolution updates only status/detail.
          if (!originalPending.has(trade.trade_key)) newTrades.set(trade.trade_key, trade);
        } else {
          if (
            newTrades.has(trade.trade_key) ||
            input.existingTrades.some((t) => t.trade_key === trade.trade_key)
          )
            throw new Error(`Conflicting replay trade: ${trade.trade_key}`);
          newTrades.set(trade.trade_key, trade);
        }
      }
    }
    const previousSpy = states.get("SPY_BENCHMARK")!;
    const spyState = previousSpy.state as {
      basePrice: number;
      currentPrice: number;
      symbol: string;
    };
    const close = rows.get("SPY")!.close!;
    const nav = (100000 * close) / spyState.basePrice;
    const spySnapshot: UsOperatingSnapshot = {
      strategy_id: "SPY_BENCHMARK",
      date: a.date,
      rule_version: a.ruleVersion,
      nav_usd: nav,
      cash_usd: 0,
      benchmark_nav: nav,
      daily_return: previousSpy.nav_usd > 0 ? nav / previousSpy.nav_usd - 1 : null,
      cumulative_return: nav / 100000 - 1,
      turnover: 0,
      fees_usd: 0,
      positions_count: 1,
      state: { basePrice: spyState.basePrice, currentPrice: close, symbol: "SPY" },
    };
    validateState(spySnapshot);
    snapshots.push(spySnapshot);
    states.set("SPY_BENCHMARK", spySnapshot);
    previousDate = a.date;
  }
  const payload: UsOperatingReplayPayload = {
    version: US_OPERATING_REPLAY_VERSION,
    baseDate,
    throughDate: previousDate,
    ruleVersion: US_PROSPECTIVE_RULE_VERSION,
    dates: input.dates.map((d) => ({
      date: d.analysis.date,
      previousSessionDate: d.previousSessionDate,
      sourceHash: d.sourceHash,
    })),
    expectedRegistries,
    expectedSnapshots,
    expectedPendingTrades,
    snapshots,
    trades: [...newTrades.values()].sort((a, b) => a.trade_key.localeCompare(b.trade_key)),
    pendingResolutions: pendingResolutions.sort((a, b) => a.trade_key.localeCompare(b.trade_key)),
  };
  const canonicalPayload = usOperatingStableJson(payload);
  return {
    ...payload,
    canonicalPayload,
    planHash: `sha256:${createHash("sha256").update(canonicalPayload).digest("hex")}`,
  };
}
