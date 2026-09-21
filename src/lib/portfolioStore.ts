import {
  getStoredOperationalExit,
  isOperationalEntry,
  STRATEGY_CONFIG,
} from "@/lib/engine/operationalStrategy";
import { supabase, userId } from "@/lib/cloud";
import { ensureManualDataset } from "@/lib/manualDataStore";
import { loadSnapshots } from "@/lib/screeningHistory";
import type { ScreeningSnapshot, SnapshotEntry } from "@/lib/screeningSnapshot";
import type { DailyPrice, Market } from "@/lib/engine/types";
import type { MarketDataset } from "@/lib/engine/dataset";

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

type SignalDecision =
  "EXECUTED" | "SKIPPED_CAPACITY" | "SKIPPED_SECTOR" | "SKIPPED_CASH" | "SKIPPED_HELD";

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

let syncInFlight: Promise<PortfolioState> | null = null;

const num = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const money = (value: number) => Math.round(value * 100) / 100;
const rate = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const signalKey = (symbol: string, signalDate: string) => `${symbol}|${signalDate}`;

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
    if (insertError && insertError.code !== "23505") throw insertError;
    if (insertError?.code === "23505") return ensureSettings();
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

async function fetchHandledSignalKeys(uid: string) {
  const { data, error } = await supabase
    .from("portfolio_signal_log")
    .select("symbol,signal_date")
    .eq("user_id", uid);
  if (error) throw error;
  return new Set((data ?? []).map((row) => signalKey(String(row.symbol), String(row.signal_date))));
}

async function recordSignalDecision(
  uid: string,
  candidate: EntryCandidate,
  decision: SignalDecision,
  detail: string,
) {
  const { error } = await supabase.from("portfolio_signal_log").upsert(
    {
      user_id: uid,
      symbol: candidate.entry.symbol,
      signal_date: candidate.snapshot.asOfDate,
      decision,
      detail,
      decided_at: new Date().toISOString(),
    },
    { onConflict: "user_id,symbol,signal_date" },
  );
  if (error) throw error;
}

function normalizeSnapshots(input: ScreeningSnapshot[]): ScreeningSnapshot[] {
  const byAsOf = new Map<string, ScreeningSnapshot>();
  for (const snapshot of [...input].sort((a, b) => a.savedAt.localeCompare(b.savedAt))) {
    if (!snapshot.asOfDate) continue;
    byAsOf.set(snapshot.asOfDate, snapshot);
  }
  return [...byAsOf.values()].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
}

function datasetLatestDate(dataset: MarketDataset): string | null {
  let latest: string | null = null;
  for (const bars of Object.values(dataset.bars)) {
    const date = bars.at(-1)?.tradeDate ?? null;
    if (date && (latest === null || date > latest)) latest = date;
  }
  for (const series of dataset.indexSeries) {
    const date = series.bars.at(-1)?.tradeDate ?? null;
    if (date && (latest === null || date > latest)) latest = date;
  }
  return latest;
}

export function isEntryOnset(entry: SnapshotEntry, market: Market) {
  if (market === "KOSPI") return isOperationalEntry({ ...entry, kosdaq80Onset: false });
  if (market !== "KOSDAQ") return false;
  if (entry.kosdaq80Onset === true) return true;
  return /KOSDAQ\s*(?:80|8)\s*(?:Onset|ONSET)/i.test(entry.status ?? "");
}

function operationalExit(entry: SnapshotEntry, market: Market): "UP95" | "UP90" | "DOWN30" | null {
  if (market !== "KOSDAQ") return getStoredOperationalExit(entry, market);
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

export function deriveExitPlan(
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
    const signal = operationalExit(entry, trade.market);
    if (!signal) continue;
    const execution = firstBarAfter(bars, snapshot.asOfDate);
    if (!execution || execution.tradeDate > latestDate || execution.open <= 0) continue;
    scorePlan = {
      signalDate: snapshot.asOfDate,
      exitDate: execution.tradeDate,
      exitPrice: execution.open,
      reason:
        signal === "UP95"
          ? "9.5점 상향돌파"
          : signal === "UP90"
            ? "9.0점 상향 재돌파"
            : "3.0점 하향 이탈",
      timing: "OPEN",
    };
    break;
  }

  const entryIndex = bars.findIndex((bar) => bar.tradeDate === trade.entryDate);
  const timeBar =
    entryIndex >= 0
      ? bars[
          entryIndex +
            STRATEGY_CONFIG[trade.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI"].maxHoldingDays -
            1
        ]
      : undefined;
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
  uid: string,
  trade: PortfolioTrade,
  plan: ExitPlan,
  halfCostRate: number,
): Promise<PortfolioTrade> {
  const exitGross = trade.shares * plan.exitPrice;
  const exitFee = money(exitGross * halfCostRate);
  const costBasis = trade.buyAmount + trade.entryFee;
  const realizedPnl = money(exitGross - exitFee - costBasis);
  const realizedReturn = costBasis > 0 ? rate((realizedPnl / costBasis) * 100) : 0;
  const { data, error } = await supabase
    .from("portfolio_trades")
    .update({
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
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", uid)
    .eq("id", trade.id)
    .select("*")
    .single();
  if (error) throw error;
  return mapTrade(data as PortfolioTradeRow);
}

function buildSummary(
  settings: PortfolioSettings,
  trades: PortfolioTrade[],
  latestDate: string | null,
) {
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
  await ensureSettings();
  const uid = await userId();
  const { error } = await supabase
    .from("portfolio_settings")
    .update({ initial_capital: money(initialCapital), updated_at: new Date().toISOString() })
    .eq("user_id", uid);
  if (error) throw error;
}

async function runPortfolioSync(): Promise<PortfolioState> {
  const settings = await ensureSettings();
  const snapshots = normalizeSnapshots(loadSnapshots());
  const initialTrades = await fetchTrades();
  const parsed = await ensureManualDataset();
  if (!parsed) {
    const latestSnapshotDate = snapshots.at(-1)?.asOfDate ?? null;
    return {
      settings,
      trades: initialTrades,
      summary: buildSummary(settings, initialTrades, latestSnapshotDate),
    };
  }

  const dataset = parsed.dataset;
  const latestDate = datasetLatestDate(dataset) ?? snapshots.at(-1)?.asOfDate ?? null;
  if (!latestDate || snapshots.length === 0)
    return {
      settings,
      trades: initialTrades,
      summary: buildSummary(settings, initialTrades, latestDate),
    };

  const instrumentMap = new Map(
    dataset.instruments.map((instrument) => [instrument.symbol, instrument]),
  );
  const working = [...initialTrades];
  const uid = await userId();
  const handledKeys = await fetchHandledSignalKeys(uid);
  for (const trade of working) handledKeys.add(signalKey(trade.symbol, trade.signalDate));
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
      if (!plan || plan.exitDate > cutoffDate) continue;
      if (beforeEntry && plan.exitDate === cutoffDate && plan.timing === "CLOSE") continue;
      replaceWorking(await closeTrade(uid, trade, plan, halfCost));
    }
  };

  const candidates: EntryCandidate[] = [];
  for (const snapshot of snapshots) {
    for (const entry of snapshot.entries) {
      const instrument = instrumentMap.get(entry.symbol);
      if (
        !instrument ||
        instrument.instrumentType !== "STOCK" ||
        !isEntryOnset(entry, instrument.market)
      )
        continue;
      const entryBar = firstBarAfter(dataset.bars[entry.symbol] ?? [], snapshot.asOfDate);
      if (!entryBar || entryBar.tradeDate > latestDate || entryBar.open <= 0) continue;
      candidates.push({ snapshot, entry, market: instrument.market, entryBar });
    }
  }

  candidates.sort((a, b) => {
    const dateDiff = a.entryBar.tradeDate.localeCompare(b.entryBar.tradeDate);
    if (dateDiff !== 0) return dateDiff;
    const techDiff =
      (b.entry.technicalPoints ?? -Infinity) - (a.entry.technicalPoints ?? -Infinity);
    if (techDiff !== 0) return techDiff;
    const priorityDiff =
      (b.entry.priorityPoints ?? -Infinity) - (a.entry.priorityPoints ?? -Infinity);
    if (priorityDiff !== 0) return priorityDiff;
    return a.entry.symbol.localeCompare(b.entry.symbol);
  });

  for (const candidate of candidates) {
    const key = signalKey(candidate.entry.symbol, candidate.snapshot.asOfDate);
    if (handledKeys.has(key)) continue;
    await closeDue(candidate.entryBar.tradeDate, true);

    const sameSymbolOpen = working.some(
      (trade) =>
        trade.symbol === candidate.entry.symbol &&
        activeAtEntry(trade, candidate.entryBar.tradeDate),
    );
    if (sameSymbolOpen) {
      await recordSignalDecision(
        uid,
        candidate,
        "SKIPPED_HELD",
        "신호 다음 거래일 시가 시점에 동일 종목 보유 중",
      );
      handledKeys.add(key);
      continue;
    }

    const active = working.filter((trade) => activeAtEntry(trade, candidate.entryBar.tradeDate));
    if (active.length >= settings.maxPositions) {
      await recordSignalDecision(
        uid,
        candidate,
        "SKIPPED_CAPACITY",
        `P${settings.maxPositions} 포지션 한도 도달`,
      );
      handledKeys.add(key);
      continue;
    }

    const sectorCap =
      STRATEGY_CONFIG[candidate.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI"].sectorCap;
    const sectorSlots = Math.max(1, Math.floor(settings.maxPositions * sectorCap + 1e-9));
    const sectorCount = active.filter(
      (trade) => trade.sectorCode === candidate.entry.sectorCode,
    ).length;
    if (sectorCount >= sectorSlots) {
      await recordSignalDecision(
        uid,
        candidate,
        "SKIPPED_SECTOR",
        `${candidate.market} 동일 섹터 ${Math.round(sectorCap * 100)}% 한도 도달`,
      );
      handledKeys.add(key);
      continue;
    }

    const targetAmount = settings.initialCapital / settings.maxPositions;
    const availableCash = cashAtEntry(settings, working, candidate.entryBar.tradeDate);
    const maxAffordableShares = Math.floor(
      availableCash / (candidate.entryBar.open * (1 + halfCost)),
    );
    if (maxAffordableShares < 1) {
      await recordSignalDecision(uid, candidate, "SKIPPED_CASH", "가용 현금으로 1주 매수 불가");
      handledKeys.add(key);
      continue;
    }

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
        entry_status: `${candidate.market} 8.0 Onset · 신규 진입`,
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
    if (error && error.code !== "23505") throw error;
    if (data) replaceWorking(mapTrade(data as PortfolioTradeRow));
    await recordSignalDecision(
      uid,
      candidate,
      "EXECUTED",
      `${candidate.entryBar.tradeDate} 시가 ${candidate.entryBar.open}원 · ${shares}주`,
    );
    handledKeys.add(key);
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
        current_status:
          current && operationalExit(current, trade.market)
            ? `청산 대기 · ${current.status}`
            : "보유",
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

  working.sort(
    (a, b) => b.entryDate.localeCompare(a.entryDate) || a.symbol.localeCompare(b.symbol),
  );
  return { settings, trades: working, summary: buildSummary(settings, working, latestDate) };
}

/**
 * 스크리닝 이력을 거래 원장으로 연결한다.
 * - KOSPI/KOSDAQ 8.0 Onset 발생 다음 거래일 시가에 진입
 * - KOSPI는 U9.5 상향돌파만 점수 청산(DX), 과거 참고용 스냅샷은 진입하지 않음
 * - 9.0 상향 재돌파 / 3.0 하향 이탈은 신호 다음 거래일 시가에 청산
 * - 60거래일 만기는 해당 거래일 종가에 청산
 * - P30, KOSPI 동일섹터 최대 10% / KOSDAQ 최대 20%, 왕복비용 0.30%를 적용
 * - 다음 거래일 데이터가 원천데이터에 들어오는 즉시 체결 가능 상태로 본다.
 */
export async function syncPortfolioFromHistory(): Promise<PortfolioState> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runPortfolioSync().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}
