import { supabase, userId } from "@/lib/cloud";
import { ensureManualDataset } from "@/lib/manualDataStore";
import { loadSnapshots } from "@/lib/screeningHistory";
import type { ScreeningSnapshot, SnapshotEntry } from "@/lib/screeningSnapshot";
import type { DailyPrice, Market } from "@/lib/engine/types";

export interface PortfolioSettings {
  initialCapital: number;
  maxPositions: number;
  sectorCap: number;
  roundTripCostRate: number;
}

export type PortfolioTradeStatus = "OPEN" | "CLOSED";

export interface PortfolioTrade {
  id: string;
  symbol: string;
  name: string;
  market: Market;
  sectorCode: string;
  sectorName: string;
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  entryTechnicalPoints: number | null;
  entryPriorityPoints: number | null;
  entryStatus: string;
  targetWeight: number;
  targetAmount: number;
  shares: number;
  buyAmount: number;
  entryFee: number;
  markDate: string | null;
  currentPrice: number | null;
  currentTechnicalPoints: number | null;
  currentPriorityPoints: number | null;
  currentStatus: string | null;
  holdingDays: number;
  exitSignalDate: string | null;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  exitFee: number;
  realizedPnl: number | null;
  realizedReturn: number | null;
  status: PortfolioTradeStatus;
}

export interface PortfolioSummary {
  cash: number;
  marketValue: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  totalReturn: number;
  openPositions: number;
  slotTargetAmount: number;
  latestDate: string | null;
}

export interface PortfolioState {
  settings: PortfolioSettings;
  trades: PortfolioTrade[];
  summary: PortfolioSummary;
}

const DEFAULT_SETTINGS: PortfolioSettings = {
  initialCapital: 10_000_000,
  maxPositions: 30,
  sectorCap: 0.3,
  roundTripCostRate: 0.003,
};

interface PortfolioTradeRow {
  id: string;
  symbol: string;
  name: string;
  market: Market;
  sector_code: string;
  sector_name: string;
  signal_date: string;
  entry_date: string;
  entry_price: number | string;
  entry_technical_points: number | string | null;
  entry_priority_points: number | string | null;
  entry_status: string;
  target_weight: number | string;
  target_amount: number | string;
  shares: number;
  buy_amount: number | string;
  entry_fee: number | string;
  mark_date: string | null;
  current_price: number | string | null;
  current_technical_points: number | string | null;
  current_priority_points: number | string | null;
  current_status: string | null;
  holding_days: number;
  exit_signal_date: string | null;
  exit_date: string | null;
  exit_price: number | string | null;
  exit_reason: string | null;
  exit_fee: number | string;
  realized_pnl: number | string | null;
  realized_return: number | string | null;
  status: PortfolioTradeStatus;
}

interface EntryCandidate {
  snapshot: ScreeningSnapshot;
  entry: SnapshotEntry;
  market: Market;
  entryBar: DailyPrice;
}

interface ExitPlan {
  signalDate: string | null;
  exitDate: string;
  exitPrice: number;
  reason: string;
  timing: "OPEN" | "CLOSE";
}

const num = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const money = (value: number) => Math.round(value * 100) / 100;
const rate = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

function mapTrade(row: PortfolioTradeRow): PortfolioTrade {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    sectorCode: row.sector_code,
    sectorName: row.sector_name,
    signalDate: row.signal_date,
    entryDate: row.entry_date,
    entryPrice: num(row.entry_price) ?? 0,
    entryTechnicalPoints: num(row.entry_technical_points),
    entryPriorityPoints: num(row.entry_priority_points),
    entryStatus: row.entry_status,
    targetWeight: num(row.target_weight) ?? 0,
    targetAmount: num(row.target_amount) ?? 0,
    shares: row.shares,
    buyAmount: num(row.buy_amount) ?? 0,
    entryFee: num(row.entry_fee) ?? 0,
    markDate: row.mark_date,
    currentPrice: num(row.current_price),
    currentTechnicalPoints: num(row.current_technical_points),
    currentPriorityPoints: num(row.current_priority_points),
    currentStatus: row.current_status,
    holdingDays: row.holding_days,
    exitSignalDate: row.exit_signal_date,
    exitDate: row.exit_date,
    exitPrice: num(row.exit_price),
    exitReason: row.exit_reason,
    exitFee: num(row.exit_fee) ?? 0,
    realizedPnl: num(row.realized_pnl),
    realizedReturn: num(row.realized_return),
    status: row.status,
  };
}

async function ensureSettings(): Promise<PortfolioSettings> {
  const uid = await userId();
  const { data, error } = await supabase
    .from("portfolio_settings")
    .select("initial_capital,max_positions,sector_cap,round_trip_cost_rate")
    .eq("user_id", uid)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const { error: insertError } = await supabase.from("portfolio_settings").insert({
      user_id: uid,
      initial_capital: DEFAULT_SETTINGS.initialCapital,
      max_positions: DEFAULT_SETTINGS.maxPositions,
      sector_cap: DEFAULT_SETTINGS.sectorCap,
      round_trip_cost_rate: DEFAULT_SETTINGS.roundTripCostRate,
    });
    if (insertError) throw insertError;
    return { ...DEFAULT_SETTINGS };
  }
  return {
    initialCapital: num(data.initial_capital) ?? DEFAULT_SETTINGS.initialCapital,
    maxPositions: Number(data.max_positions) || DEFAULT_SETTINGS.maxPositions,
    sectorCap: num(data.sector_cap) ?? DEFAULT_SETTINGS.sectorCap,
    roundTripCostRate: num(data.round_trip_cost_rate) ?? DEFAULT_SETTINGS.roundTripCostRate,
  };
}

async function fetchTrades(): Promise<PortfolioTrade[]> {
  const uid = await userId();
  const { data, error } = await supabase
    .from("portfolio_trades")
    .select("*")
    .eq("user_id", uid)
    .order("entry_date", { ascending: true })
    .order("symbol", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as PortfolioTradeRow[]).map(mapTrade);
}

function normalizeSnapshots(input: ScreeningSnapshot[]): ScreeningSnapshot[] {
  const byAsOf = new Map<string, ScreeningSnapshot>();
  for (const snapshot of [...input].sort((a, b) => a.savedAt.localeCompare(b.savedAt))) {
    if (!snapshot.asOfDate) continue;
    byAsOf.set(snapshot.asOfDate, snapshot);
  }
  return [...byAsOf.values()].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
}

function isKosdaqOnset(entry: SnapshotEntry) {
  if (entry.kosdaq80Onset === true) return true;
  return /KOSDAQ\s*(?:80|8)\s*(?:Onset|ONSET)/i.test(entry.status ?? "");
}

function operationalExit(entry: SnapshotEntry): "UP90" | "DOWN30" | null {
  if (entry.exitSignal === "UP90" || entry.exitSignal === "DOWN30") return entry.exitSignal;
  const status = entry.status ?? "";
  if (/9\.0점.*상향/i.test(status)) return "UP90";
  if (/3\.0점.*하향/i.test(status)) return "DOWN30";
  return null;
}

function firstBarAfter(bars: DailyPrice[], date: string): DailyPrice | null {
  for (const bar of bars) if (bar.tradeDate > date) return bar;
  return null;
}

function barOnOrBefore(bars: DailyPrice[], date: string): DailyPrice | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i]!;
    if (bar.tradeDate <= date) return bar;
  }
  return null;
}

function holdingDays(bars: DailyPrice[], entryDate: string, endDate: string) {
  return bars.filter((bar) => bar.tradeDate >= entryDate && bar.tradeDate <= endDate).length;
}

function latestSnapshotEntry(snapshots: ScreeningSnapshot[], symbol: string): SnapshotEntry | null {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const found = snapshots[i]!.entries.find((entry) => entry.symbol === symbol);
    if (found) return found;
  }
  return null;
}

function deriveExitPlan(
  trade: PortfolioTrade,
  snapshots: ScreeningSnapshot[],
  bars: DailyPrice[],
  latestDate: string,
): ExitPlan | null {
  let scorePlan: ExitPlan | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.asOfDate < trade.entryDate || snapshot.asOfDate > latestDate) continue;
    const entry = snapshot.entries.find((item) => item.symbol === trade.symbol);
    if (!entry) continue;
    const signal = operationalExit(entry);
    if (!signal) continue;
    const execution = firstBarAfter(bars, snapshot.asOfDate);
    if (!execution || execution.tradeDate > latestDate || execution.open <= 0) continue;
    scorePlan = {
      signalDate: snapshot.asOfDate,
      exitDate: execution.tradeDate,
      exitPrice: execution.open,
      reason: signal === "UP90" ? "9.0점 상향 재돌파" : "3.0점 하향 이탈",
      timing: "OPEN",
    };
    break;
  }

  const entryIndex = bars.findIndex((bar) => bar.tradeDate === trade.entryDate);
  const timeBar = entryIndex >= 0 ? bars[entryIndex + 59] : undefined;
  const timePlan: ExitPlan | null =
    timeBar && timeBar.tradeDate <= latestDate && timeBar.close > 0
      ? {
          signalDate: null,
          exitDate: timeBar.tradeDate,
          exitPrice: timeBar.close,
          reason: "60거래일 만기",
          timing: "CLOSE",
        }
      : null;

  if (!scorePlan) return timePlan;
  if (!timePlan) return scorePlan;
  if (scorePlan.exitDate < timePlan.exitDate) return scorePlan;
  if (scorePlan.exitDate > timePlan.exitDate) return timePlan;
  return scorePlan.timing === "OPEN" ? scorePlan : timePlan;
}

function activeAtEntry(trade: PortfolioTrade, date: string) {
  if (trade.entryDate > date) return false;
  if (!trade.exitDate) return true;
  if (trade.exitDate > date) return true;
  return trade.exitDate === date && trade.exitReason === "60거래일 만기";
}

function cashAtEntry(settings: PortfolioSettings, trades: PortfolioTrade[], date: string) {
  let cash = settings.initialCapital;
  for (const trade of trades) {
    if (trade.entryDate <= date) cash -= trade.buyAmount + trade.entryFee;
    if (!trade.exitDate || trade.exitPrice === null) continue;
    const proceeds = trade.shares * trade.exitPrice - trade.exitFee;
    if (trade.exitDate < date) cash += proceeds;
    else if (trade.exitDate === date && trade.exitReason !== "60거래일 만기") cash += proceeds;
  }
  return cash;
}

async function closeTrade(
  trade: PortfolioTrade,
  plan: ExitPlan,
  halfCostRate: number,
): Promise<PortfolioTrade> {
  const uid = await userId();
  const exitGross = trade.shares * plan.exitPrice;
  const exitFee = money(exitGross * halfCostRate);
  const costBasis = trade.buyAmount + trade.entryFee;
  const realizedPnl = money(exitGross - exitFee - costBasis);
  const realizedReturn = costBasis > 0 ? rate((realizedPnl / costBasis) * 100) : 0;
  const next: Partial<PortfolioTradeRow> = {
    exit_signal_date: plan.signalDate,
    exit_date: plan.exitDate,
    exit_price: plan.exitPrice,
    exit_reason: plan.reason,
    exit_fee: exitFee,
    realized_pnl: realizedPnl,
    realized_return: realizedReturn,
    status: "CLOSED",
    mark_date: plan.exitDate,
    current_price: plan.exitPrice,
    current_status: `청산 · ${plan.reason}`,
  };
  const { data, error } = await supabase
    .from("portfolio_trades")
    .update({ ...next, updated_at: new Date().toISOString() })
    .eq("user_id", uid)
    .eq("id", trade.id)
    .select("*")
    .single();
  if (error) throw error;
  return mapTrade(data as PortfolioTradeRow);
}

function buildSummary(settings: PortfolioSettings, trades: PortfolioTrade[], latestDate: string | null) {
  const halfCost = settings.roundTripCostRate / 2;
  let cash = settings.initialCapital;
  let marketValue = 0;
  let realizedPnl = 0;
  let unrealizedPnl = 0;
  let openPositions = 0;
  for (const trade of trades) {
    cash -= trade.buyAmount + trade.entryFee;
    if (trade.status === "CLOSED" && trade.exitPrice !== null) {
      cash += trade.shares * trade.exitPrice - trade.exitFee;
      realizedPnl += trade.realizedPnl ?? 0;
      continue;
    }
    openPositions += 1;
    const value = trade.shares * (trade.currentPrice ?? trade.entryPrice);
    const estimatedExitFee = value * halfCost;
    marketValue += value;
    unrealizedPnl += value - estimatedExitFee - trade.buyAmount - trade.entryFee;
  }
  const equity = cash + marketValue;
  const totalPnl = equity - settings.initialCapital;
  return {
    cash: money(cash),
    marketValue: money(marketValue),
    equity: money(equity),
    realizedPnl: money(realizedPnl),
    unrealizedPnl: money(unrealizedPnl),
    totalPnl: money(totalPnl),
    totalReturn: settings.initialCapital > 0 ? rate((totalPnl / settings.initialCapital) * 100) : 0,
    openPositions,
    slotTargetAmount: money(settings.initialCapital / settings.maxPositions),
    latestDate,
  } satisfies PortfolioSummary;
}

export async function loadPortfolioState(): Promise<PortfolioState> {
  const settings = await ensureSettings();
  const trades = await fetchTrades();
  const snapshots = normalizeSnapshots(loadSnapshots());
  const latestDate = snapshots.at(-1)?.asOfDate ?? null;
  return { settings, trades, summary: buildSummary(settings, trades, latestDate) };
}

export async function savePortfolioCapital(initialCapital: number): Promise<void> {
  if (!Number.isFinite(initialCapital) || initialCapital <= 0)
    throw new Error("운용자금은 0보다 큰 금액으로 입력해 주세요.");
  const uid = await userId();
  const { error } = await supabase.from("portfolio_settings").upsert(
    {
      user_id: uid,
      initial_capital: money(initialCapital),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
}

/**
 * 스크리닝 이력을 거래 원장으로 연결한다.
 * - KOSDAQ 8 ONSET 발생 다음 거래일 시가에 진입
 * - 9.0 상향 재돌파 / 3.0 하향 이탈은 신호 다음 거래일 시가에 청산
 * - 60거래일 만기는 해당 거래일 종가에 청산
 * - P30, 동일섹터 최대 30%, 왕복비용 0.30% 기본값을 적용
 */
export async function syncPortfolioFromHistory(): Promise<PortfolioState> {
  const settings = await ensureSettings();
  const snapshots = normalizeSnapshots(loadSnapshots());
  const latestDate = snapshots.at(-1)?.asOfDate ?? null;
  if (!latestDate || snapshots.length === 0)
    return { settings, trades: await fetchTrades(), summary: buildSummary(settings, await fetchTrades(), latestDate) };

  const parsed = await ensureManualDataset();
  if (!parsed) return loadPortfolioState();
  const dataset = parsed.dataset;
  const instrumentMap = new Map(dataset.instruments.map((instrument) => [instrument.symbol, instrument]));
  const working = await fetchTrades();
  const existingKeys = new Set(working.map((trade) => `${trade.symbol}|${trade.signalDate}`));
  const halfCost = settings.roundTripCostRate / 2;

  const replaceWorking = (trade: PortfolioTrade) => {
    const index = working.findIndex((item) => item.id === trade.id);
    if (index >= 0) working[index] = trade;
    else working.push(trade);
  };

  const closeDue = async (cutoffDate: string, beforeEntry: boolean) => {
    for (const trade of [...working]) {
      if (trade.status !== "OPEN") continue;
      const bars = dataset.bars[trade.symbol] ?? [];
      const plan = deriveExitPlan(trade, snapshots, bars, latestDate);
      if (!plan) continue;
      if (plan.exitDate > cutoffDate) continue;
      if (beforeEntry && plan.exitDate === cutoffDate && plan.timing === "CLOSE") continue;
      const closed = await closeTrade(trade, plan, halfCost);
      replaceWorking(closed);
    }
  };

  const candidates: EntryCandidate[] = [];
  for (const snapshot of snapshots) {
    for (const entry of snapshot.entries) {
      if (!isKosdaqOnset(entry)) continue;
      const instrument = instrumentMap.get(entry.symbol);
      if (!instrument || instrument.instrumentType !== "STOCK" || instrument.market !== "KOSDAQ") continue;
      const bars = dataset.bars[entry.symbol] ?? [];
      const entryBar = firstBarAfter(bars, snapshot.asOfDate);
      if (!entryBar || entryBar.tradeDate > latestDate || entryBar.open <= 0) continue;
      candidates.push({ snapshot, entry, market: instrument.market, entryBar });
    }
  }
  candidates.sort((a, b) => {
    const dateDiff = a.entryBar.tradeDate.localeCompare(b.entryBar.tradeDate);
    if (dateDiff !== 0) return dateDiff;
    const techDiff = (b.entry.technicalPoints ?? -Infinity) - (a.entry.technicalPoints ?? -Infinity);
    if (techDiff !== 0) return techDiff;
    const priorityDiff = (b.entry.priorityPoints ?? -Infinity) - (a.entry.priorityPoints ?? -Infinity);
    if (priorityDiff !== 0) return priorityDiff;
    return a.entry.symbol.localeCompare(b.entry.symbol);
  });

  const uid = await userId();
  for (const candidate of candidates) {
    const key = `${candidate.entry.symbol}|${candidate.snapshot.asOfDate}`;
    if (existingKeys.has(key)) continue;
    await closeDue(candidate.entryBar.tradeDate, true);

    const sameSymbolOpen = working.some(
      (trade) => trade.symbol === candidate.entry.symbol && activeAtEntry(trade, candidate.entryBar.tradeDate),
    );
    if (sameSymbolOpen) continue;
    const active = working.filter((trade) => activeAtEntry(trade, candidate.entryBar.tradeDate));
    if (active.length >= settings.maxPositions) continue;

    const sectorSlots = Math.max(1, Math.floor(settings.maxPositions * settings.sectorCap + 1e-9));
    const sectorCount = active.filter((trade) => trade.sectorCode === candidate.entry.sectorCode).length;
    if (sectorCount >= sectorSlots) continue;

    const targetAmount = settings.initialCapital / settings.maxPositions;
    const availableCash = cashAtEntry(settings, working, candidate.entryBar.tradeDate);
    const maxAffordableShares = Math.floor(availableCash / (candidate.entryBar.open * (1 + halfCost)));
    if (maxAffordableShares < 1) continue;
    const nearestShares = Math.max(1, Math.round(targetAmount / candidate.entryBar.open));
    const shares = Math.min(nearestShares, maxAffordableShares);
    const buyAmount = money(shares * candidate.entryBar.open);
    const entryFee = money(buyAmount * halfCost);

    const { data, error } = await supabase
      .from("portfolio_trades")
      .insert({
        user_id: uid,
        symbol: candidate.entry.symbol,
        name: candidate.entry.name,
        market: candidate.market,
        sector_code: candidate.entry.sectorCode,
        sector_name: candidate.entry.sectorName,
        signal_date: candidate.snapshot.asOfDate,
        entry_date: candidate.entryBar.tradeDate,
        entry_price: candidate.entryBar.open,
        entry_technical_points: candidate.entry.technicalPoints,
        entry_priority_points: candidate.entry.priorityPoints,
        entry_status: "KOSDAQ 8 ONSET",
        target_weight: rate(1 / settings.maxPositions),
        target_amount: money(targetAmount),
        shares,
        buy_amount: buyAmount,
        entry_fee: entryFee,
        mark_date: candidate.entryBar.tradeDate,
        current_price: candidate.entryBar.open,
        current_technical_points: candidate.entry.technicalPoints,
        current_priority_points: candidate.entry.priorityPoints,
        current_status: "보유",
        holding_days: 1,
        status: "OPEN",
      })
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") {
        existingKeys.add(key);
        continue;
      }
      throw error;
    }
    const inserted = mapTrade(data as PortfolioTradeRow);
    working.push(inserted);
    existingKeys.add(key);
  }

  await closeDue(latestDate, false);

  for (const trade of [...working]) {
    if (trade.status !== "OPEN") continue;
    const bars = dataset.bars[trade.symbol] ?? [];
    const mark = barOnOrBefore(bars, latestDate);
    if (!mark || mark.close <= 0) continue;
    const current = latestSnapshotEntry(snapshots, trade.symbol);
    const days = Math.max(1, holdingDays(bars, trade.entryDate, mark.tradeDate));
    const { data, error } = await supabase
      .from("portfolio_trades")
      .update({
        mark_date: mark.tradeDate,
        current_price: mark.close,
        current_technical_points: current?.technicalPoints ?? null,
        current_priority_points: current?.priorityPoints ?? null,
        current_status: current?.status ?? "보유",
        holding_days: days,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", uid)
      .eq("id", trade.id)
      .select("*")
      .single();
    if (error) throw error;
    replaceWorking(mapTrade(data as PortfolioTradeRow));
  }

  working.sort((a, b) => b.entryDate.localeCompare(a.entryDate) || a.symbol.localeCompare(b.symbol));
  return { settings, trades: working, summary: buildSummary(settings, working, latestDate) };
}
