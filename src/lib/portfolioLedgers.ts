import type { KospiMarketGateEvidence } from "./engine/kospiMarketGate";
import type { DailyPrice, Market } from "./engine/types";
import type { ScreeningSnapshot } from "./screeningSnapshot";
import type { PortfolioSettings, PortfolioSummary, PortfolioTrade } from "./portfolioStoreCore";
import { KOSPI_ENTRY_POLICY } from "./engine/kospiEntryConfirmation";
import { STRATEGY_CONFIG } from "./engine/operationalStrategy";
import {
  normalizeSnapshots,
  isEntryOnset,
  isLegacyReplayEntry,
  nextKospiConfirmedEntry,
  heldDuringEntryWindow,
  firstBarAfter,
  deriveExitPlan,
  latestSnapshotEntry,
  operationalExit,
} from "./portfolioStrategyRules";

export const LEDGER_VERSION = 3;
export interface Quote {
  price: number;
  date: string;
  exitSignal: string | null;
}
export interface Candidate {
  key: string;
  symbol: string;
  name: string;
  market: Market;
  sectorCode: string;
  sectorName: string;
  signalDate: string;
  originDate?: string;
  confirmationDate?: string | null;
  entryState?: "none" | "pending" | "confirmed" | "rejected" | "unobservable";
  entryDate: string | null;
  price: number | null;
  technical: number | null;
  priority: number | null;
  decision: string;
}
export interface StrategyLedger {
  trades: PortfolioTrade[];
  candidates: Candidate[];
  summary: PortfolioSummary;
  firstSignalDate: string | null;
  quotes: Record<string, Quote>;
  fingerprint: string;
  calculatedAt: string;
}
export interface ActualExecution<M extends string = Market> {
  id: string;
  symbol: string;
  name: string;
  market: M;
  signalKey: string | null;
  side: "BUY" | "SELL";
  date: string;
  price: number;
  shares: number;
  fee: number;
  note: string;
  order: number;
}
export interface LedgerDocument {
  version: number;
  settings: PortfolioSettings;
  actualCapital: number;
  etfCapital?: number;
  executions: ActualExecution[];
  excluded: Record<string, string>;
  strategy: StrategyLedger | null;
  migratedAt: string;
}
export interface ActualPosition<M extends string = Market> {
  symbol: string;
  name: string;
  market: M;
  shares: number;
  cost: number;
  averagePrice: number;
  firstEntryDate: string;
  currentPrice: number;
  markDate: string | null;
  marketValue: number;
  unrealizedPnl: number;
  exitSignal: string | null;
}
export interface ActualLedger<M extends string = Market> {
  positions: ActualPosition<M>[];
  executions: (ActualExecution<M> & { realizedPnl: number | null })[];
  summary: PortfolioSummary;
}
export interface DualPortfolioState {
  revision: number;
  document: LedgerDocument;
  actual: ActualLedger;
  etfActual?: ActualLedger;
  etfRows?: import("./dashboardOperations").DashboardIndexRow[];
  etfTrackedSymbols?: string[];
  etfWarning?: string | null;
}
export const money = (v: number) => Math.round(v * 100) / 100;
export const keyFor = (symbol: string, date: string) => `${symbol}|${date}`;

function summary(
  capital: number,
  cash: number,
  value: number,
  realized: number,
  unrealized: number,
  count: number,
  latest: string | null,
  max = 30,
): PortfolioSummary {
  const equity = money(cash + value),
    pnl = money(equity - capital);
  return {
    cash: money(cash),
    marketValue: money(value),
    equity,
    realizedPnl: money(realized),
    unrealizedPnl: money(unrealized),
    totalPnl: pnl,
    totalReturn: capital > 0 ? (pnl / capital) * 100 : 0,
    openPositions: count,
    slotTargetAmount: money(capital / max),
    latestDate: latest,
  };
}

/** Deterministic strategy replay. No personal executions, exclusions or edited legacy fills enter here. */
export function simulateStrategy(
  settings: PortfolioSettings,
  input: ScreeningSnapshot[],
  bars: Record<string, DailyPrice[]>,
  markets: Record<string, Market>,
  fingerprint = "",
  marketDates: string[] = [],
  marketGates: Record<string, KospiMarketGateEvidence> = {},
): StrategyLedger {
  const snapshots = normalizeSnapshots(input);
  const entryBars = bars;
  // Source loading historically excluded invalid opens/closes. Keep that exact replay/quote
  // boundary while the confirmation executor alone sees raw observed suspension and gap evidence.
  bars = Object.fromEntries(
    Object.entries(bars).map(([symbol, series]) => [
      symbol,
      series.filter(
        (bar) =>
          Number.isFinite(bar.open) && bar.open > 0 && Number.isFinite(bar.close) && bar.close > 0,
      ),
    ]),
  );
  const latest = Object.values(bars).reduce<string | null>((d, b) => {
    const x = b.at(-1)?.tradeDate;
    return x && (!d || x > d) ? x : d;
  }, null);
  const observedDates = marketDates.length
    ? marketDates
    : [
        ...new Set([
          ...Object.values(entryBars).flatMap((series) => series.map((bar) => bar.tradeDate)),
          ...snapshots.map((snapshot) => snapshot.asOfDate),
        ]),
      ].sort();
  type ReplayCandidate = Candidate & { executable: boolean; confirmedPolicy: boolean };
  const byKey = new Map<string, ReplayCandidate>();
  for (const snapshot of snapshots)
    for (const entry of snapshot.entries) {
      const market = markets[entry.symbol] ?? (entry.kospiEntry ? "KOSPI" : undefined);
      if (!market || entry.instrumentType !== "STOCK") continue;
      const confirmation = market === "KOSPI" ? entry.kospiEntry : undefined;
      const legacy = isLegacyReplayEntry(entry, market, snapshot.asOfDate);
      const executable = isEntryOnset(entry, market, snapshot.asOfDate) || legacy;
      const confirmedPolicy = market === "KOSPI" && !legacy;
      if (
        !executable &&
        !(
          market === "KOSPI" &&
          (entry.kospi80Onset || (confirmation?.originDate && confirmation.state !== "none"))
        )
      )
        continue;
      const originDate = confirmation?.originDate ?? snapshot.asOfDate;
      const signalDate = confirmation?.confirmationDate ?? snapshot.asOfDate;
      let next: DailyPrice | null = null;
      let decision = "다음 거래일 대기";
      if (confirmedPolicy) {
        if (executable) {
          const execution = nextKospiConfirmedEntry(
            entryBars[entry.symbol] ?? [],
            confirmation!,
            observedDates,
            marketGates,
          );
          next = execution.bar;
          decision = execution.reason;
        } else if (
          confirmation?.state === "confirmed" &&
          snapshot.asOfDate < KOSPI_ENTRY_POLICY.effectiveConfirmationDate
        ) {
          decision = "적용일 이전 · 참고용";
        } else if (
          !confirmation ||
          confirmation.date !== snapshot.asOfDate ||
          confirmation.version !== KOSPI_ENTRY_POLICY.version
        ) {
          decision = "확인 자료 없음 · 진입 제외";
        } else if (confirmation.state === "pending") {
          decision = "익일 확인 대기";
        } else if (confirmation.state === "rejected") {
          decision = `확인 실패 · ${confirmation.issues.join(", ") || "진입 조건 미충족"}`;
        } else if (confirmation.state === "unobservable") {
          decision = `확인 관측 불가 · ${confirmation.issues.join(", ") || "자료 부족"}`;
        } else {
          decision = "확인 조건 미충족 · 진입 제외";
        }
      } else next = firstBarAfter(bars[entry.symbol] ?? [], snapshot.asOfDate);
      const key = keyFor(entry.symbol, confirmedPolicy ? originDate : snapshot.asOfDate);
      // A legacy origin immediately before adoption already owns its next-open replay fill.
      // A later confirmation must not replace or retime that historical trade.
      if (confirmedPolicy && byKey.get(key)?.confirmedPolicy === false) continue;
      byKey.set(key, {
        key,
        symbol: entry.symbol,
        name: entry.name,
        market,
        sectorCode: entry.sectorCode,
        sectorName: entry.sectorName,
        signalDate,
        ...(confirmedPolicy
          ? {
              originDate,
              confirmationDate: confirmation?.confirmationDate ?? null,
              entryState: confirmation?.state ?? "unobservable",
            }
          : {}),
        entryDate: next?.tradeDate ?? null,
        price: next?.open ?? null,
        technical: entry.technicalPoints,
        priority: entry.priorityPoints,
        decision,
        executable,
        confirmedPolicy,
      });
    }
  const rawCandidates = [...byKey.values()];
  rawCandidates.sort(
    (a, b) =>
      (a.entryDate ?? "9999").localeCompare(b.entryDate ?? "9999") ||
      (b.technical ?? -Infinity) - (a.technical ?? -Infinity) ||
      (b.priority ?? -Infinity) - (a.priority ?? -Infinity) ||
      a.symbol.localeCompare(b.symbol),
  );
  const candidates: Candidate[] = [];
  const trades: PortfolioTrade[] = [];
  const half = settings.roundTripCostRate / 2;
  let cash = settings.initialCapital;
  const closeDue = (cutoff: string, beforeEntry: boolean) => {
    for (const t of trades) {
      if (t.status !== "OPEN" || !latest) continue;
      const plan = deriveExitPlan(t, snapshots, bars[t.symbol] ?? [], latest);
      if (
        !plan ||
        plan.exitDate > cutoff ||
        (beforeEntry && plan.exitDate === cutoff && plan.timing === "CLOSE")
      )
        continue;
      const fee = money(t.shares * plan.exitPrice * half),
        pnl = money(t.shares * plan.exitPrice - fee - t.buyAmount - t.entryFee);
      Object.assign(t, {
        status: "CLOSED",
        exitSignalDate: plan.signalDate,
        exitDate: plan.exitDate,
        exitPrice: plan.exitPrice,
        exitReason: plan.reason,
        exitFee: fee,
        realizedPnl: pnl,
        realizedReturn: (pnl / (t.buyAmount + t.entryFee)) * 100,
        markDate: plan.exitDate,
        currentPrice: plan.exitPrice,
        currentStatus: "전략 청산",
        holdingDays: (bars[t.symbol] ?? []).filter(
          (b) => b.tradeDate >= t.entryDate && b.tradeDate <= plan.exitDate,
        ).length,
      });
      cash += t.shares * plan.exitPrice - fee;
    }
  };
  for (const candidate of rawCandidates) {
    const { executable, confirmedPolicy, ...c } = candidate;
    if (confirmedPolicy && c.entryDate && latest) closeDue(c.entryDate, true);
    const heldOnSignal = trades.some((trade) =>
      confirmedPolicy
        ? heldDuringEntryWindow(
            trade,
            c.symbol,
            c.originDate ?? c.signalDate,
            c.entryDate ?? c.signalDate,
          )
        : trade.symbol === c.symbol &&
          trade.entryDate <= c.signalDate &&
          (!trade.exitDate || trade.exitDate > c.signalDate),
    );
    if (heldOnSignal) {
      if (confirmedPolicy)
        candidates.push({
          ...c,
          entryDate: null,
          price: null,
          decision: "발생일 이후 보유/당일 매도 · 진입 제외",
        });
      continue;
    }
    candidates.push(c);
    if (
      !executable ||
      !c.entryDate ||
      !Number.isFinite(c.price) ||
      !c.price ||
      c.price < 0 ||
      !latest ||
      c.entryDate > latest
    )
      continue;
    if (!confirmedPolicy) closeDue(c.entryDate, true);
    const active = trades.filter((t) => t.status === "OPEN");
    if (active.some((t) => t.symbol === c.symbol)) {
      c.decision = "동일 종목 보유";
      continue;
    }
    if (active.length >= settings.maxPositions) {
      c.decision = "30종목 한도";
      continue;
    }
    const sectorSlots = Math.max(
      1,
      Math.floor(
        settings.maxPositions *
          STRATEGY_CONFIG[c.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI"].sectorCap +
          1e-9,
      ),
    );
    if (active.filter((t) => t.sectorCode === c.sectorCode).length >= sectorSlots) {
      c.decision = "섹터 한도";
      continue;
    }
    const target = settings.initialCapital / settings.maxPositions;
    const affordable = Math.floor(cash / (c.price * (1 + half)));
    if (affordable < 1) {
      c.decision = "현금 부족";
      continue;
    }
    const shares = Math.min(Math.max(1, Math.round(target / c.price)), affordable),
      amount = money(shares * c.price),
      fee = money(amount * half);
    cash -= amount + fee;
    c.decision = "전략 진입";
    trades.push({
      id: c.key,
      symbol: c.symbol,
      name: c.name,
      market: c.market,
      sectorCode: c.sectorCode,
      sectorName: c.sectorName,
      signalDate: c.signalDate,
      entryDate: c.entryDate,
      entryPrice: c.price,
      entryTechnicalPoints: c.technical,
      entryPriorityPoints: c.priority,
      entryStatus: confirmedPolicy ? "익일 확인 통과 · 전략 진입" : "Onset · 전략 진입",
      targetWeight: 1 / settings.maxPositions,
      targetAmount: target,
      shares,
      buyAmount: amount,
      entryFee: fee,
      markDate: c.entryDate,
      currentPrice: c.price,
      currentTechnicalPoints: c.technical,
      currentPriorityPoints: c.priority,
      currentStatus: "전략 보유",
      holdingDays: 1,
      exitSignalDate: null,
      exitDate: null,
      exitPrice: null,
      exitReason: null,
      exitFee: 0,
      realizedPnl: null,
      realizedReturn: null,
      status: "OPEN",
    });
  }
  if (latest) closeDue(latest, false);
  const quotes: Record<string, Quote> = {};
  for (const [symbol, series] of Object.entries(bars)) {
    const mark = [...series].reverse().find((bar) => Number.isFinite(bar.close) && bar.close > 0);
    if (!mark) continue;
    const current = latestSnapshotEntry(snapshots, symbol);
    quotes[symbol] = {
      price: mark.close,
      date: mark.tradeDate,
      exitSignal:
        current && markets[symbol] ? operationalExit(current, markets[symbol]!, true) : null,
    };
  }
  let value = 0,
    unrealized = 0,
    realized = 0,
    count = 0;
  for (const t of trades) {
    if (t.status === "CLOSED") {
      realized += t.realizedPnl ?? 0;
      continue;
    }
    const q = quotes[t.symbol];
    t.currentPrice = q?.price ?? t.entryPrice;
    t.markDate = q?.date ?? t.entryDate;
    const current = latestSnapshotEntry(snapshots, t.symbol);
    t.currentTechnicalPoints = current?.technicalPoints ?? null;
    t.currentPriorityPoints = current?.priorityPoints ?? null;
    t.currentStatus = q?.exitSignal ? "전략 청산 대기" : "전략 보유";
    t.holdingDays = (bars[t.symbol] ?? []).filter(
      (b) => b.tradeDate >= t.entryDate && b.tradeDate <= t.markDate!,
    ).length;
    const v = t.shares * t.currentPrice;
    value += v;
    unrealized += v - t.buyAmount - t.entryFee;
    count++;
  }
  return {
    trades,
    candidates,
    summary: summary(
      settings.initialCapital,
      cash,
      value,
      realized,
      unrealized,
      count,
      latest,
      settings.maxPositions,
    ),
    firstSignalDate: snapshots[0]?.asOfDate ?? null,
    quotes,
    fingerprint,
    calculatedAt: new Date().toISOString(),
  };
}

/** Actual book: only confirmed events create holdings. Moving-average basis supports partial sales. */
export function calculateActual<M extends string = Market>(
  capital: number,
  events: ActualExecution<M>[],
  quotes: Record<string, Quote>,
  latest: string | null,
): ActualLedger<M> {
  if (!Number.isFinite(capital) || capital <= 0) throw new Error("실제 운용자금을 확인하세요.");
  const positions = new Map<string, ActualPosition<M>>();
  const executions: ActualLedger<M>["executions"] = [];
  let cash = capital,
    realized = 0;
  const ids = new Set<string>();
  for (const e of [...events].sort(
    (a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.id.localeCompare(b.id),
  )) {
    if (ids.has(e.id)) throw new Error("중복 체결 기록입니다.");
    ids.add(e.id);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(e.date) ||
      !Number.isInteger(e.shares) ||
      e.shares <= 0 ||
      !Number.isFinite(e.price) ||
      e.price <= 0 ||
      !Number.isFinite(e.fee) ||
      e.fee < 0 ||
      !["BUY", "SELL"].includes(e.side)
    )
      throw new Error("체결 날짜·가격·수량·비용을 확인하세요.");
    let p = positions.get(e.symbol),
      pnl: number | null = null;
    const gross = e.price * e.shares;
    if (e.side === "BUY") {
      if (!p && positions.size >= 30)
        throw new Error(
          `${e.date}: 실제 보유 종목이 30개를 초과합니다. 실제 매도일과 수량을 먼저 확인하세요.`,
        );
      if (!p) {
        p = {
          symbol: e.symbol,
          name: e.name,
          market: e.market,
          shares: 0,
          cost: 0,
          averagePrice: 0,
          firstEntryDate: e.date,
          currentPrice: e.price,
          markDate: null,
          marketValue: 0,
          unrealizedPnl: 0,
          exitSignal: null,
        };
        positions.set(e.symbol, p);
      }
      p.shares += e.shares;
      p.cost += gross + e.fee;
      p.averagePrice = p.cost / p.shares;
      p.currentPrice = e.price;
      cash -= gross + e.fee;
    } else {
      if (!p || e.shares > p.shares)
        throw new Error(`${e.name}: 매도수량이 해당일 실제 보유수량을 초과합니다.`);
      const basis = (p.cost * e.shares) / p.shares;
      pnl = money(gross - e.fee - basis);
      realized += pnl;
      p.cost -= basis;
      p.shares -= e.shares;
      cash += gross - e.fee;
      if (p.shares === 0) positions.delete(e.symbol);
      else p.averagePrice = p.cost / p.shares;
    }
    executions.push({ ...e, realizedPnl: pnl });
  }
  let value = 0,
    unrealized = 0;
  for (const p of positions.values()) {
    const candidateQuote = quotes[p.symbol];
    const q =
      candidateQuote && candidateQuote.date >= p.firstEntryDate ? candidateQuote : undefined;
    p.currentPrice = q?.price ?? p.currentPrice;
    p.markDate = q?.date ?? null;
    p.exitSignal = q?.exitSignal ?? null;
    p.marketValue = money(p.shares * p.currentPrice);
    p.unrealizedPnl = money(p.marketValue - p.cost);
    value += p.marketValue;
    unrealized += p.unrealizedPnl;
  }
  return {
    positions: [...positions.values()],
    executions,
    summary: summary(capital, cash, value, realized, unrealized, positions.size, latest),
  };
}
