import { decimal, format, fromLegacyNumber, integerBudgetQuantity } from "../ledger/decimal";
import type {
  UsProspectiveAnalysis,
  UsProspectiveRow,
  UsProspectiveStrategyId,
} from "./usProspective";

export const US_PROSPECTIVE_INITIAL_CAPITAL = 100_000;
export const US_PROSPECTIVE_ONE_WAY_COST = 0.0025;
export const US_PROSPECTIVE_PARTICIPATION = 0.01;
export const US_PROSPECTIVE_MAX_POSITIONS = 20;

export interface UsStrategyConfig {
  id: UsProspectiveStrategyId;
  label: string;
  role: "PRIMARY" | "SHADOW";
  style: "AGGRESSIVE" | "BALANCED";
  sectorCap: number | null;
  exitCore: number;
  quarterlyRebalance: boolean;
  betaExit: { rankBelow: number; consecutiveDays: number } | null;
}

export const US_PROSPECTIVE_STRATEGIES: UsStrategyConfig[] = [
  {
    id: "A0_QUARTER_PRIMARY",
    label: "A0 분기 · Beta 0.60×3 Anchor",
    role: "PRIMARY",
    style: "AGGRESSIVE",
    sectorCap: null,
    exitCore: 0.7,
    quarterlyRebalance: true,
    betaExit: { rankBelow: 0.6, consecutiveDays: 3 },
  },
  {
    id: "A2_QUARTER_SHADOW",
    label: "A2 분기 · Shadow",
    role: "SHADOW",
    style: "AGGRESSIVE",
    sectorCap: 2,
    exitCore: 0.7,
    quarterlyRebalance: true,
    betaExit: null,
  },
  {
    id: "B3_BETA_SHADOW",
    label: "B3 Beta 0.60×3 · Shadow",
    role: "SHADOW",
    style: "BALANCED",
    sectorCap: 3,
    exitCore: 0.5,
    quarterlyRebalance: false,
    betaExit: { rankBelow: 0.6, consecutiveDays: 3 },
  },
];

export interface UsPortfolioPosition {
  symbol: string;
  name: string;
  sector: string | null;
  shares: number;
  lastPrice: number;
  entryDate: string;
  entryCoreRank: number | null;
}
export interface UsPendingTarget {
  symbol: string;
  targetWeight: number;
  signalDate: string;
  reason: string;
}
export interface UsPendingExit {
  symbol: string;
  signalDate: string;
  reason: string;
}
/** Opt-in model-only execution boundary. Omitted options preserve all historical defaults. */
export interface UsModelExecutionPolicy {
  version: "isolated-us-model-v1";
  bookId: string;
  contractHash: string;
  accountingStartDate: string;
  initialCapital: string;
  oneWayCost: string;
}
export interface UsPortfolioState {
  executionPolicy?: UsModelExecutionPolicy;
  /** Exact cash/fees exist only on the opt-in path; NAV remains the existing engine's number output. */
  modelCashExact?: string;
  modelFeesExact?: string;
  lastDate?: string;
  adv20BySymbol?: Record<string, number>;
  initializedDate: string;
  initialCapital: number;
  cash: number;
  positions: Record<string, UsPortfolioPosition>;
  pendingTargets: Record<string, UsPendingTarget>;
  pendingExits: Record<string, UsPendingExit>;
  lastQuarterRebalance: string | null;
  benchmarkBasePrice: number | null;
  benchmarkBaseDate: string | null;
  totalFees: number;
}
export interface UsModelTrade {
  tradeKey: string;
  strategyId: UsProspectiveStrategyId;
  signalDate: string;
  executionDate: string | null;
  symbol: string;
  name: string;
  sector: string | null;
  side: "BUY" | "SELL" | "REBALANCE_BUY" | "REBALANCE_SELL";
  reason: string;
  status: "PENDING" | "EXECUTED" | "PARTIAL";
  modelPrice: number | null;
  modelShares: number | null;
  modelNotional: number | null;
  feeUsd: number;
  coreRank: number | null;
  detail: Record<string, unknown>;
}
export interface UsPortfolioStepResult {
  state: UsPortfolioState;
  trades: UsModelTrade[];
  nav: number;
  cash: number;
  benchmarkNav: number | null;
  dailyReturn: number | null;
  cumulativeReturn: number;
  turnover: number;
  feesUsd: number;
  positionsCount: number;
}

const qkey = (date: string) => {
  const [y, m] = date.split("-").map(Number);
  return `${y}Q${Math.floor(((m ?? 1) - 1) / 3) + 1}`;
};
const tkey = (
  strategy: string,
  signal: string,
  execution: string | null,
  symbol: string,
  side: string,
  reason: string,
) => [strategy, signal, execution ?? "PENDING", symbol, side, reason].join("|");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const maps = (analysis: UsProspectiveAnalysis) => new Map(analysis.rows.map((r) => [r.symbol, r]));

function fresh(
  date: string,
  spy: number | null,
  policy?: UsModelExecutionPolicy,
): UsPortfolioState {
  return {
    ...(policy
      ? {
          executionPolicy: clone(policy),
          modelCashExact: policy.initialCapital,
          modelFeesExact: "0",
        }
      : {}),
    initializedDate: policy?.accountingStartDate ?? date,
    initialCapital: policy ? Number(policy.initialCapital) : US_PROSPECTIVE_INITIAL_CAPITAL,
    cash: policy ? Number(policy.initialCapital) : US_PROSPECTIVE_INITIAL_CAPITAL,
    positions: {},
    pendingTargets: {},
    pendingExits: {},
    lastQuarterRebalance: null,
    benchmarkBasePrice: spy,
    benchmarkBaseDate: spy ? date : null,
    totalFees: 0,
  };
}
function navOf(state: UsPortfolioState, rows: Map<string, UsProspectiveRow>, open = false) {
  return (
    state.cash +
    Object.values(state.positions).reduce((sum, p) => {
      const r = rows.get(p.symbol);
      const px = (open ? r?.open : r?.close) ?? p.lastPrice;
      return sum + p.shares * (px > 0 ? px : p.lastPrice);
    }, 0)
  );
}
function entryRows(config: UsStrategyConfig, rows: UsProspectiveRow[]) {
  return rows
    .filter((r) => (config.style === "BALANCED" ? r.b3Entry : r.a0Entry))
    .sort(
      (a, b) =>
        (b.coreRank ?? -1) - (a.coreRank ?? -1) ||
        (b.betaRank ?? -1) - (a.betaRank ?? -1) ||
        ((config.style === "BALANCED" ? b.relvolRank : b.tkRank) ?? -1) -
          ((config.style === "BALANCED" ? a.relvolRank : a.tkRank) ?? -1) ||
        a.symbol.localeCompare(b.symbol),
    );
}
function shouldExit(config: UsStrategyConfig, row?: UsProspectiveRow) {
  if (!row) return true;
  return config.id === "B3_BETA_SHADOW"
    ? row.b3Exit
    : config.id === "A2_QUARTER_SHADOW"
      ? row.a2Exit
      : row.a0Exit;
}

/** Future-only convention: today's close signal -> next observed US regular-session open. */
export function stepUsProspectivePortfolio(
  config: UsStrategyConfig,
  analysis: UsProspectiveAnalysis,
  previous: UsPortfolioState | null,
  previousNav: number | null,
  executionPolicy?: UsModelExecutionPolicy,
): UsPortfolioStepResult {
  if (previous?.executionPolicy && !executionPolicy)
    throw new Error("Isolated model state cannot enter the legacy engine path");
  if (executionPolicy) {
    const p = executionPolicy;
    const validDate = (value: string) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (
      p.version !== "isolated-us-model-v1" ||
      !p.bookId ||
      p.bookId === "ACTUAL" ||
      !/^sha256:[a-f0-9]{64}$/.test(p.contractHash) ||
      !validDate(p.accountingStartDate) ||
      !validDate(analysis.date) ||
      analysis.date < p.accountingStartDate ||
      decimal(p.initialCapital) <= 0n ||
      decimal(p.oneWayCost) < 0n ||
      decimal(p.oneWayCost) >= decimal("1") ||
      !Number.isFinite(Number(p.initialCapital)) ||
      Number(p.initialCapital) > Number.MAX_SAFE_INTEGER
    )
      throw new Error("Invalid isolated US model execution policy or start boundary");
    const adopted = US_PROSPECTIVE_STRATEGIES.find(
      (strategy) => strategy.id === "A0_QUARTER_PRIMARY",
    );
    if (!adopted || JSON.stringify(config) !== JSON.stringify(adopted))
      throw new Error(
        "Isolated US execution is restricted to unchanged adopted A0 quarterly rules",
      );
    const identity = (value: UsModelExecutionPolicy) =>
      JSON.stringify([
        value.version,
        value.bookId,
        value.contractHash,
        value.accountingStartDate,
        value.initialCapital,
        value.oneWayCost,
      ]);
    if (previous) {
      if (
        !previous.executionPolicy ||
        identity(previous.executionPolicy) !== identity(p) ||
        previous.initialCapital !== Number(p.initialCapital) ||
        previous.initializedDate !== p.accountingStartDate ||
        previous.modelCashExact === undefined ||
        previous.modelFeesExact === undefined ||
        Number(previous.modelCashExact) !== previous.cash ||
        Number(previous.modelFeesExact) !== previous.totalFees
      )
        throw new Error("US model state does not match its frozen execution policy");
      if (
        (previous.lastDate && previous.lastDate < p.accountingStartDate) ||
        Object.values(previous.pendingTargets).some(
          (order) => order.signalDate < p.accountingStartDate,
        ) ||
        Object.values(previous.pendingExits).some(
          (order) => order.signalDate < p.accountingStartDate,
        ) ||
        Object.values(previous.positions).some(
          (position) =>
            position.entryDate < p.accountingStartDate ||
            !Number.isSafeInteger(position.shares) ||
            position.shares < 0,
        )
      )
        throw new Error(
          "Pre-start pending trades or invalid positions cannot enter the isolated US model",
        );
      if (decimal(previous.modelCashExact) < 0n || decimal(previous.modelFeesExact) < 0n)
        throw new Error("Negative isolated model cash/fees");
    }
  }
  const rows = maps(analysis);
  const spy = rows.get("SPY")?.close ?? null;
  const state = previous ? clone(previous) : fresh(analysis.date, spy, executionPolicy);
  if (state.lastDate && analysis.date <= state.lastDate)
    throw new Error(
      "Portfolio step requires a later trading date; replay from the preceding snapshot.",
    );
  const trades: UsModelTrade[] = [];
  let turnover = 0;
  let fees = 0;
  let modelCash = executionPolicy ? decimal(state.modelCashExact!) : 0n;
  let modelFees = executionPolicy ? decimal(state.modelFeesExact!) : 0n;
  let dayModelFees = 0n;
  const bookFill = (shares: number, price: number, side: "BUY" | "SELL") => {
    if (executionPolicy) {
      if (!Number.isSafeInteger(shares) || shares <= 0)
        throw new Error("Model fills require positive safe integer shares");
      const gross = decimal(fromLegacyNumber(price)) * BigInt(shares);
      const scale = decimal("1");
      const exactFee = (gross * decimal(executionPolicy.oneWayCost) + scale - 1n) / scale;
      modelCash += (side === "BUY" ? -gross : gross) - exactFee;
      if (modelCash < 0n) throw new Error("Isolated model fill exceeds exact cash");
      modelFees += exactFee;
      dayModelFees += exactFee;
      state.modelCashExact = format(modelCash);
      state.modelFeesExact = format(modelFees);
      state.cash = Number(state.modelCashExact);
      state.totalFees = Number(state.modelFeesExact);
      fees = Number(format(dayModelFees));
      return { notional: Number(format(gross)), fee: Number(format(exactFee)) };
    }
    const notional = shares * price,
      fee = notional * US_PROSPECTIVE_ONE_WAY_COST;
    if (side === "BUY") state.cash -= notional + fee;
    else state.cash += notional - fee;
    state.totalFees += fee;
    fees += fee;
    return { notional, fee };
  };

  const record = (t: UsModelTrade) => trades.push(t);
  // Capacity is known at the preceding close, never today's ADV containing future volume.
  const used = new Map<string, number>();
  const capacity = (row: UsProspectiveRow, px: number) =>
    Math.max(
      0,
      Math.floor(
        ((state.adv20BySymbol?.[row.symbol] ?? 0) * US_PROSPECTIVE_PARTICIPATION -
          (used.get(row.symbol) ?? 0)) /
          px,
      ),
    );
  const consume = (symbol: string, notional: number) =>
    used.set(symbol, (used.get(symbol) ?? 0) + notional);
  // On a quarter boundary, rebalance at this open using only the preceding close's holdings/signals.
  const quarter = qkey(analysis.date);
  if (config.quarterlyRebalance && state.lastDate && qkey(state.lastDate) !== quarter) {
    const symbols = Array.from(
      new Set([...Object.keys(state.positions), ...Object.keys(state.pendingTargets)]),
    ).filter((symbol) => !state.pendingExits[symbol]);
    for (const symbol of symbols)
      state.pendingTargets[symbol] = {
        symbol,
        targetWeight: 1 / symbols.length,
        signalDate: state.lastDate,
        reason: "QUARTER_EQUAL_WEIGHT",
      };
    state.lastQuarterRebalance = quarter;
  }

  // 1) Pending exits: next open, REAL1 participation.
  for (const [symbol, pending] of Object.entries({ ...state.pendingExits })) {
    const p = state.positions[symbol];
    const row = rows.get(symbol);
    const px = row?.open ?? null;
    if (!p) {
      delete state.pendingExits[symbol];
      continue;
    }
    if (!row || !px || px <= 0 || pending.signalDate >= analysis.date) continue;
    const shares = Math.min(p.shares, capacity(row, px));
    if (shares <= 0) continue;
    const { notional, fee } = bookFill(shares, px, "SELL");
    consume(symbol, notional);
    p.shares -= shares;
    p.lastPrice = px;
    turnover += notional;
    const partial = p.shares > 0;
    record({
      tradeKey: tkey(config.id, pending.signalDate, analysis.date, symbol, "SELL", pending.reason),
      strategyId: config.id,
      signalDate: pending.signalDate,
      executionDate: analysis.date,
      symbol,
      name: p.name,
      sector: p.sector,
      side: "SELL",
      reason: pending.reason,
      status: partial ? "PARTIAL" : "EXECUTED",
      modelPrice: px,
      modelShares: shares,
      modelNotional: notional,
      feeUsd: fee,
      coreRank: row.coreRank,
      detail: { participation: US_PROSPECTIVE_PARTICIPATION },
    });
    if (!partial) {
      delete state.positions[symbol];
      delete state.pendingExits[symbol];
      delete state.pendingTargets[symbol];
    }
  }

  // 2) Pending target weights: sells, then buys.
  const openNav = navOf(state, rows, true);
  const orders = Object.values(state.pendingTargets)
    .flatMap((pending) => {
      const row = rows.get(pending.symbol);
      const px = row?.open ?? null;
      if (
        !row ||
        !px ||
        px <= 0 ||
        pending.signalDate >= analysis.date ||
        state.pendingExits[pending.symbol]
      )
        return [];
      const current = state.positions[pending.symbol]?.shares ?? 0;
      const desired = Math.max(0, Math.floor((pending.targetWeight * openNav) / px));
      return [{ pending, row, px, current, desired, delta: desired - current }];
    })
    .sort((a, b) => a.delta - b.delta);

  for (const o of orders.filter((x) => x.delta < 0)) {
    const p = state.positions[o.row.symbol];
    if (!p) continue;
    const shares = Math.min(-o.delta, capacity(o.row, o.px));
    if (shares <= 0) continue;
    const { notional, fee } = bookFill(shares, o.px, "SELL");
    consume(o.row.symbol, notional);
    p.shares -= shares;
    p.lastPrice = o.px;
    turnover += notional;
    const partial = p.shares > o.desired;
    record({
      tradeKey: tkey(
        config.id,
        o.pending.signalDate,
        analysis.date,
        o.row.symbol,
        "REBALANCE_SELL",
        o.pending.reason,
      ),
      strategyId: config.id,
      signalDate: o.pending.signalDate,
      executionDate: analysis.date,
      symbol: o.row.symbol,
      name: o.row.name,
      sector: o.row.sector,
      side: "REBALANCE_SELL",
      reason: o.pending.reason,
      status: partial ? "PARTIAL" : "EXECUTED",
      modelPrice: o.px,
      modelShares: shares,
      modelNotional: notional,
      feeUsd: fee,
      coreRank: o.row.coreRank,
      detail: { targetWeight: o.pending.targetWeight },
    });
    if (p.shares <= 0) delete state.positions[o.row.symbol];
    if (!partial) delete state.pendingTargets[o.row.symbol];
  }
  for (const o of orders.filter((x) => x.delta > 0)) {
    if (!state.positions[o.row.symbol]) {
      const held = Object.values(state.positions);
      if (held.length >= US_PROSPECTIVE_MAX_POSITIONS) continue;
      if (
        config.sectorCap &&
        held.filter((p) => (p.sector ?? "UNKNOWN") === (o.row.sector ?? "UNKNOWN")).length >=
          config.sectorCap
      )
        continue;
    }
    const affordable = executionPolicy
      ? Number(
          integerBudgetQuantity(
            format(modelCash),
            format(modelCash),
            fromLegacyNumber(o.px),
            executionPolicy.oneWayCost,
          ),
        )
      : Math.max(0, Math.floor(state.cash / (o.px * (1 + US_PROSPECTIVE_ONE_WAY_COST))));
    const shares = Math.min(o.delta, capacity(o.row, o.px), affordable);
    if (shares <= 0) continue;
    const { notional, fee } = bookFill(shares, o.px, "BUY");
    consume(o.row.symbol, notional);
    turnover += notional;
    const p = state.positions[o.row.symbol];
    if (p) {
      p.shares += shares;
      p.lastPrice = o.px;
    } else
      state.positions[o.row.symbol] = {
        symbol: o.row.symbol,
        name: o.row.name,
        sector: o.row.sector,
        shares,
        lastPrice: o.px,
        entryDate: analysis.date,
        entryCoreRank: o.row.coreRank,
      };
    const partial = state.positions[o.row.symbol]!.shares < o.desired;
    record({
      tradeKey: tkey(
        config.id,
        o.pending.signalDate,
        analysis.date,
        o.row.symbol,
        "BUY",
        o.pending.reason,
      ),
      strategyId: config.id,
      signalDate: o.pending.signalDate,
      executionDate: analysis.date,
      symbol: o.row.symbol,
      name: o.row.name,
      sector: o.row.sector,
      side: o.pending.reason.startsWith("QUARTER") ? "REBALANCE_BUY" : "BUY",
      reason: o.pending.reason,
      status: partial ? "PARTIAL" : "EXECUTED",
      modelPrice: o.px,
      modelShares: shares,
      modelNotional: notional,
      feeUsd: fee,
      coreRank: o.row.coreRank,
      detail: { targetWeight: o.pending.targetWeight },
    });
    if (!partial) delete state.pendingTargets[o.row.symbol];
  }

  for (const o of orders.filter((x) => x.delta === 0)) delete state.pendingTargets[o.row.symbol];

  for (const p of Object.values(state.positions)) {
    const close = rows.get(p.symbol)?.close;
    if (close && close > 0) p.lastPrice = close;
  }
  const nav = navOf(state, rows);
  const dailyReturn = previousNav && previousNav > 0 ? nav / previousNav - 1 : null;

  // 3) Today's exit signals for next open.
  for (const p of Object.values(state.positions)) {
    const row = rows.get(p.symbol);
    if (!shouldExit(config, row)) continue;
    const reason =
      !row || row.coreRank === null
        ? "UNIVERSE_OR_DATA_EXIT"
        : config.betaExit && row.betaWeakStreak >= 3
          ? config.id === "A0_QUARTER_PRIMARY"
            ? "A0_BETA_ANCHOR_3D"
            : "B3_BETA_WEAK_3D"
          : `CORE_BELOW_${config.exitCore.toFixed(2)}`;
    state.pendingExits[p.symbol] ??= { symbol: p.symbol, signalDate: analysis.date, reason };
    delete state.pendingTargets[p.symbol];
  }

  // 4) Onset entries, enforcing max holdings and optional sector cap.
  for (const symbol of Object.keys(state.pendingTargets)) {
    if (!state.positions[symbol] && shouldExit(config, rows.get(symbol)))
      delete state.pendingTargets[symbol];
  }
  const exiting = new Set(Object.keys(state.pendingExits));
  const retained = Object.values(state.positions).filter((p) => !exiting.has(p.symbol));
  const sectorCounts = new Map<string, number>();
  retained.forEach((p) =>
    sectorCounts.set(p.sector ?? "UNKNOWN", (sectorCounts.get(p.sector ?? "UNKNOWN") ?? 0) + 1),
  );
  const reserved = Object.keys(state.pendingTargets).filter(
    (symbol) => !state.positions[symbol] && !exiting.has(symbol),
  );
  for (const symbol of reserved) {
    const sector = rows.get(symbol)?.sector ?? "UNKNOWN";
    sectorCounts.set(sector, (sectorCounts.get(sector) ?? 0) + 1);
  }
  const current = new Set([...retained.map((p) => p.symbol), ...reserved]);
  const entries: UsProspectiveRow[] = [];
  for (const row of entryRows(config, analysis.rows)) {
    if (row.symbol === "SPY" || current.has(row.symbol) || exiting.has(row.symbol)) continue;
    if (retained.length + reserved.length + entries.length >= US_PROSPECTIVE_MAX_POSITIONS) break;
    const sector = row.sector ?? "UNKNOWN";
    if (config.sectorCap && (sectorCounts.get(sector) ?? 0) >= config.sectorCap) continue;
    entries.push(row);
    current.add(row.symbol);
    sectorCounts.set(sector, (sectorCounts.get(sector) ?? 0) + 1);
  }

  const desired = [...retained.map((p) => p.symbol), ...reserved, ...entries.map((r) => r.symbol)];
  if (desired.length > 0 && entries.length > 0) {
    const target = 1 / desired.length;
    entries.forEach(
      (r) =>
        (state.pendingTargets[r.symbol] = {
          symbol: r.symbol,
          targetWeight: target,
          signalDate: analysis.date,
          reason: "ENTRY_ONSET80",
        }),
    );
    const plannedExit = Object.keys(state.pendingExits).reduce(
      (sum, symbol) =>
        sum + (state.positions[symbol]?.shares ?? 0) * (state.positions[symbol]?.lastPrice ?? 0),
      0,
    );
    const need = entries.length * target * nav;
    const shortage = Math.max(0, need - state.cash - plannedExit);
    const retainedValue = retained.reduce((sum, p) => sum + p.shares * p.lastPrice, 0);
    if (shortage > 0 && retainedValue > 0) {
      const scale = Math.max(0, 1 - shortage / retainedValue);
      retained.forEach(
        (p) =>
          (state.pendingTargets[p.symbol] = {
            symbol: p.symbol,
            targetWeight: (p.shares * p.lastPrice * scale) / nav,
            signalDate: analysis.date,
            reason: "ENTRY_MINIMUM_PROPORTIONAL_FUNDING",
          }),
      );
    }
  }

  for (const pending of Object.values(state.pendingExits)) {
    const row = rows.get(pending.symbol),
      p = state.positions[pending.symbol];
    record({
      tradeKey: tkey(config.id, pending.signalDate, null, pending.symbol, "SELL", pending.reason),
      strategyId: config.id,
      signalDate: pending.signalDate,
      executionDate: null,
      symbol: pending.symbol,
      name: p?.name ?? row?.name ?? pending.symbol,
      sector: p?.sector ?? row?.sector ?? null,
      side: "SELL",
      reason: pending.reason,
      status: "PENDING",
      modelPrice: null,
      modelShares: p?.shares ?? null,
      modelNotional: null,
      feeUsd: 0,
      coreRank: row?.coreRank ?? null,
      detail: {},
    });
  }
  for (const pending of Object.values(state.pendingTargets)) {
    const row = rows.get(pending.symbol);
    const held = state.positions[pending.symbol];
    const deltaNotional = pending.targetWeight * nav - (held ? held.shares * held.lastPrice : 0);
    const side =
      deltaNotional < 0
        ? "REBALANCE_SELL"
        : pending.reason.startsWith("QUARTER")
          ? "REBALANCE_BUY"
          : "BUY";
    record({
      tradeKey: tkey(config.id, pending.signalDate, null, pending.symbol, "BUY", pending.reason),
      strategyId: config.id,
      signalDate: pending.signalDate,
      executionDate: null,
      symbol: pending.symbol,
      name: row?.name ?? state.positions[pending.symbol]?.name ?? pending.symbol,
      sector: row?.sector ?? state.positions[pending.symbol]?.sector ?? null,
      side,
      reason: pending.reason,
      status: "PENDING",
      modelPrice: null,
      modelShares: null,
      modelNotional: Math.abs(deltaNotional),
      feeUsd: 0,
      coreRank: row?.coreRank ?? null,
      detail: { targetWeight: pending.targetWeight },
    });
  }

  if (state.benchmarkBasePrice === null && spy) {
    state.benchmarkBasePrice = spy;
    state.benchmarkBaseDate = analysis.date;
  }
  state.lastDate = analysis.date;
  state.adv20BySymbol = Object.fromEntries(
    analysis.rows.filter((r) => r.adv20Usd !== null).map((r) => [r.symbol, r.adv20Usd!]),
  );
  const benchmarkNav =
    spy && state.benchmarkBasePrice
      ? (state.initialCapital * spy) / state.benchmarkBasePrice
      : null;
  return {
    state,
    trades,
    nav,
    cash: state.cash,
    benchmarkNav,
    dailyReturn,
    cumulativeReturn: nav / state.initialCapital - 1,
    turnover: nav > 0 ? turnover / nav : 0,
    feesUsd: fees,
    positionsCount: Object.keys(state.positions).length,
  };
}
