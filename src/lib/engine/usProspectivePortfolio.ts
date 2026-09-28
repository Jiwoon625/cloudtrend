import type { UsProspectiveAnalysis, UsProspectiveRow, UsProspectiveStrategyId } from "./usProspective";

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
}

export const US_PROSPECTIVE_STRATEGIES: UsStrategyConfig[] = [
  { id: "A0_QUARTER_PRIMARY", label: "A0 분기 · 실제운용 기준", role: "PRIMARY", style: "AGGRESSIVE", sectorCap: null, exitCore: 0.7, quarterlyRebalance: true },
  { id: "A2_QUARTER_SHADOW", label: "A2 분기 · Shadow", role: "SHADOW", style: "AGGRESSIVE", sectorCap: 2, exitCore: 0.7, quarterlyRebalance: true },
  { id: "B3_BETA_SHADOW", label: "B3 Beta 0.60×3 · Shadow", role: "SHADOW", style: "BALANCED", sectorCap: 3, exitCore: 0.5, quarterlyRebalance: false },
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
export interface UsPendingTarget { symbol: string; targetWeight: number; signalDate: string; reason: string }
export interface UsPendingExit { symbol: string; signalDate: string; reason: string }
export interface UsPortfolioState {
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
const tkey = (strategy: string, signal: string, execution: string | null, symbol: string, side: string, reason: string) =>
  [strategy, signal, execution ?? "PENDING", symbol, side, reason].join("|");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const maps = (analysis: UsProspectiveAnalysis) => new Map(analysis.rows.map((r) => [r.symbol, r]));

function fresh(date: string, spy: number | null): UsPortfolioState {
  return { initializedDate: date, initialCapital: US_PROSPECTIVE_INITIAL_CAPITAL, cash: US_PROSPECTIVE_INITIAL_CAPITAL, positions: {}, pendingTargets: {}, pendingExits: {}, lastQuarterRebalance: null, benchmarkBasePrice: spy, benchmarkBaseDate: spy ? date : null, totalFees: 0 };
}
function navOf(state: UsPortfolioState, rows: Map<string, UsProspectiveRow>, open = false) {
  return state.cash + Object.values(state.positions).reduce((sum, p) => {
    const r = rows.get(p.symbol);
    const px = (open ? r?.open : r?.close) ?? p.lastPrice;
    return sum + p.shares * (px > 0 ? px : p.lastPrice);
  }, 0);
}
function capShares(row: UsProspectiveRow, price: number) {
  return Math.max(0, Math.floor(((row.adv20Usd ?? 0) * US_PROSPECTIVE_PARTICIPATION) / price));
}
function entryRows(config: UsStrategyConfig, rows: UsProspectiveRow[]) {
  return rows
    .filter((r) => (config.style === "BALANCED" ? r.b3Entry : r.a0Entry))
    .sort((a, b) =>
      (b.coreRank ?? -1) - (a.coreRank ?? -1) ||
      (b.betaRank ?? -1) - (a.betaRank ?? -1) ||
      ((config.style === "BALANCED" ? b.relvolRank : b.tkRank) ?? -1) - ((config.style === "BALANCED" ? a.relvolRank : a.tkRank) ?? -1) ||
      a.symbol.localeCompare(b.symbol),
    );
}
function shouldExit(config: UsStrategyConfig, row?: UsProspectiveRow) {
  if (!row) return true;
  return config.style === "BALANCED" ? row.b3Exit : row.a0Exit;
}

/** Future-only convention: today's close signal -> next observed US regular-session open. */
export function stepUsProspectivePortfolio(
  config: UsStrategyConfig,
  analysis: UsProspectiveAnalysis,
  previous: UsPortfolioState | null,
  previousNav: number | null,
): UsPortfolioStepResult {
  const rows = maps(analysis);
  const spy = rows.get("SPY")?.close ?? null;
  const state = previous ? clone(previous) : fresh(analysis.date, spy);
  const trades: UsModelTrade[] = [];
  let turnover = 0;
  let fees = 0;

  const record = (t: UsModelTrade) => trades.push(t);

  // 1) Pending exits: next open, REAL1 participation.
  for (const [symbol, pending] of Object.entries({ ...state.pendingExits })) {
    const p = state.positions[symbol];
    const row = rows.get(symbol);
    const px = row?.open ?? null;
    if (!p) { delete state.pendingExits[symbol]; continue; }
    if (!row || !px || px <= 0) continue;
    const shares = Math.min(p.shares, capShares(row, px));
    if (shares <= 0) continue;
    const notional = shares * px;
    const fee = notional * US_PROSPECTIVE_ONE_WAY_COST;
    p.shares -= shares; p.lastPrice = px; state.cash += notional - fee; state.totalFees += fee;
    turnover += notional; fees += fee;
    const partial = p.shares > 0;
    record({ tradeKey: tkey(config.id, pending.signalDate, analysis.date, symbol, "SELL", pending.reason), strategyId: config.id, signalDate: pending.signalDate, executionDate: analysis.date, symbol, name: p.name, sector: p.sector, side: "SELL", reason: pending.reason, status: partial ? "PARTIAL" : "EXECUTED", modelPrice: px, modelShares: shares, modelNotional: notional, feeUsd: fee, coreRank: row.coreRank, detail: { participation: US_PROSPECTIVE_PARTICIPATION } });
    if (!partial) { delete state.positions[symbol]; delete state.pendingExits[symbol]; delete state.pendingTargets[symbol]; }
  }

  // 2) Pending target weights: sells, then buys.
  const openNav = navOf(state, rows, true);
  const orders = Object.values(state.pendingTargets).flatMap((pending) => {
    const row = rows.get(pending.symbol);
    const px = row?.open ?? null;
    if (!row || !px || px <= 0) return [];
    const current = state.positions[pending.symbol]?.shares ?? 0;
    const desired = Math.max(0, Math.floor((pending.targetWeight * openNav) / px));
    return [{ pending, row, px, current, desired, delta: desired - current }];
  }).sort((a, b) => a.delta - b.delta);

  for (const o of orders.filter((x) => x.delta < 0)) {
    const p = state.positions[o.row.symbol];
    if (!p) continue;
    const shares = Math.min(-o.delta, capShares(o.row, o.px));
    if (shares <= 0) continue;
    const notional = shares * o.px, fee = notional * US_PROSPECTIVE_ONE_WAY_COST;
    p.shares -= shares; p.lastPrice = o.px; state.cash += notional - fee; state.totalFees += fee;
    turnover += notional; fees += fee;
    const partial = p.shares > o.desired;
    record({ tradeKey: tkey(config.id, o.pending.signalDate, analysis.date, o.row.symbol, "REBALANCE_SELL", o.pending.reason), strategyId: config.id, signalDate: o.pending.signalDate, executionDate: analysis.date, symbol: o.row.symbol, name: o.row.name, sector: o.row.sector, side: "REBALANCE_SELL", reason: o.pending.reason, status: partial ? "PARTIAL" : "EXECUTED", modelPrice: o.px, modelShares: shares, modelNotional: notional, feeUsd: fee, coreRank: o.row.coreRank, detail: { targetWeight: o.pending.targetWeight } });
    if (p.shares <= 0) delete state.positions[o.row.symbol];
    if (!partial) delete state.pendingTargets[o.row.symbol];
  }
  for (const o of orders.filter((x) => x.delta > 0)) {
    const affordable = Math.max(0, Math.floor(state.cash / (o.px * (1 + US_PROSPECTIVE_ONE_WAY_COST))));
    const shares = Math.min(o.delta, capShares(o.row, o.px), affordable);
    if (shares <= 0) continue;
    const notional = shares * o.px, fee = notional * US_PROSPECTIVE_ONE_WAY_COST;
    state.cash -= notional + fee; state.totalFees += fee; turnover += notional; fees += fee;
    const p = state.positions[o.row.symbol];
    if (p) { p.shares += shares; p.lastPrice = o.px; }
    else state.positions[o.row.symbol] = { symbol: o.row.symbol, name: o.row.name, sector: o.row.sector, shares, lastPrice: o.px, entryDate: analysis.date, entryCoreRank: o.row.coreRank };
    const partial = state.positions[o.row.symbol]!.shares < o.desired;
    record({ tradeKey: tkey(config.id, o.pending.signalDate, analysis.date, o.row.symbol, "BUY", o.pending.reason), strategyId: config.id, signalDate: o.pending.signalDate, executionDate: analysis.date, symbol: o.row.symbol, name: o.row.name, sector: o.row.sector, side: o.pending.reason.startsWith("QUARTER") ? "REBALANCE_BUY" : "BUY", reason: o.pending.reason, status: partial ? "PARTIAL" : "EXECUTED", modelPrice: o.px, modelShares: shares, modelNotional: notional, feeUsd: fee, coreRank: o.row.coreRank, detail: { targetWeight: o.pending.targetWeight } });
    if (!partial) delete state.pendingTargets[o.row.symbol];
  }

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
    state.pendingExits[p.symbol] ??= { symbol: p.symbol, signalDate: analysis.date, reason: config.style === "BALANCED" && row?.b3BetaExit ? "B3_BETA_WEAK_3D" : `CORE_BELOW_${config.exitCore.toFixed(2)}` };
    delete state.pendingTargets[p.symbol];
  }

  // 4) Onset entries, enforcing max holdings and optional sector cap.
  const exiting = new Set(Object.keys(state.pendingExits));
  const retained = Object.values(state.positions).filter((p) => !exiting.has(p.symbol));
  const sectorCounts = new Map<string, number>();
  retained.forEach((p) => sectorCounts.set(p.sector ?? "UNKNOWN", (sectorCounts.get(p.sector ?? "UNKNOWN") ?? 0) + 1));
  const current = new Set(retained.map((p) => p.symbol));
  const entries: UsProspectiveRow[] = [];
  for (const row of entryRows(config, analysis.rows)) {
    if (row.symbol === "SPY" || current.has(row.symbol) || exiting.has(row.symbol)) continue;
    if (retained.length + entries.length >= US_PROSPECTIVE_MAX_POSITIONS) break;
    const sector = row.sector ?? "UNKNOWN";
    if (config.sectorCap && (sectorCounts.get(sector) ?? 0) >= config.sectorCap) continue;
    entries.push(row); current.add(row.symbol); sectorCounts.set(sector, (sectorCounts.get(sector) ?? 0) + 1);
  }

  const desired = [...retained.map((p) => p.symbol), ...entries.map((r) => r.symbol)];
  const quarter = qkey(analysis.date);
  const scheduled = config.quarterlyRebalance && state.lastQuarterRebalance !== quarter;
  if (desired.length > 0 && (scheduled || entries.length > 0)) {
    const target = 1 / desired.length;
    if (scheduled) {
      desired.forEach((symbol) => state.pendingTargets[symbol] = { symbol, targetWeight: target, signalDate: analysis.date, reason: "QUARTER_EQUAL_WEIGHT" });
      state.lastQuarterRebalance = quarter;
    } else {
      entries.forEach((r) => state.pendingTargets[r.symbol] = { symbol: r.symbol, targetWeight: target, signalDate: analysis.date, reason: "ENTRY_ONSET80" });
      const plannedExit = Object.keys(state.pendingExits).reduce((sum, symbol) => sum + (state.positions[symbol]?.shares ?? 0) * (state.positions[symbol]?.lastPrice ?? 0), 0);
      const need = entries.length * target * nav;
      const shortage = Math.max(0, need - state.cash - plannedExit);
      const retainedValue = retained.reduce((sum, p) => sum + p.shares * p.lastPrice, 0);
      if (shortage > 0 && retainedValue > 0) {
        const scale = Math.max(0, 1 - shortage / retainedValue);
        retained.forEach((p) => state.pendingTargets[p.symbol] = { symbol: p.symbol, targetWeight: (p.shares * p.lastPrice * scale) / nav, signalDate: analysis.date, reason: "ENTRY_MINIMUM_PROPORTIONAL_FUNDING" });
      }
    }
  }

  for (const pending of Object.values(state.pendingExits)) {
    const row = rows.get(pending.symbol), p = state.positions[pending.symbol];
    record({ tradeKey: tkey(config.id, pending.signalDate, null, pending.symbol, "SELL", pending.reason), strategyId: config.id, signalDate: pending.signalDate, executionDate: null, symbol: pending.symbol, name: p?.name ?? row?.name ?? pending.symbol, sector: p?.sector ?? row?.sector ?? null, side: "SELL", reason: pending.reason, status: "PENDING", modelPrice: null, modelShares: p?.shares ?? null, modelNotional: null, feeUsd: 0, coreRank: row?.coreRank ?? null, detail: {} });
  }
  for (const pending of Object.values(state.pendingTargets)) {
    const row = rows.get(pending.symbol);
    record({ tradeKey: tkey(config.id, pending.signalDate, null, pending.symbol, "BUY", pending.reason), strategyId: config.id, signalDate: pending.signalDate, executionDate: null, symbol: pending.symbol, name: row?.name ?? state.positions[pending.symbol]?.name ?? pending.symbol, sector: row?.sector ?? state.positions[pending.symbol]?.sector ?? null, side: pending.reason.startsWith("QUARTER") ? "REBALANCE_BUY" : "BUY", reason: pending.reason, status: "PENDING", modelPrice: null, modelShares: null, modelNotional: pending.targetWeight * nav, feeUsd: 0, coreRank: row?.coreRank ?? null, detail: { targetWeight: pending.targetWeight } });
  }

  if (state.benchmarkBasePrice === null && spy) { state.benchmarkBasePrice = spy; state.benchmarkBaseDate = analysis.date; }
  const benchmarkNav = spy && state.benchmarkBasePrice ? state.initialCapital * spy / state.benchmarkBasePrice : null;
  return { state, trades, nav, cash: state.cash, benchmarkNav, dailyReturn, cumulativeReturn: nav / state.initialCapital - 1, turnover: nav > 0 ? turnover / nav : 0, feesUsd: fees, positionsCount: Object.keys(state.positions).length };
}
