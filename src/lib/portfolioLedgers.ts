import { decimal, divide, format, fromLegacyNumber, integerBudgetQuantity } from "./ledger/decimal";
import { validDate } from "./ledger/date";
import type { KospiMarketGateEvidence } from "./engine/kospiMarketGate";
import type { DailyPrice, Market } from "./engine/types";
import type { ScreeningSnapshot } from "./screeningSnapshot";
import type { PortfolioSettings, PortfolioSummary, PortfolioTrade } from "./portfolioStoreCore";
import { KOSPI_ENTRY_POLICY, kospiPolicyVersionAt } from "./engine/kospiEntryConfirmation";
import { STRATEGY_CONFIG } from "./engine/operationalStrategy";
import { CURRENT_RULES_RESEARCH } from "./engine/operatingPolicyContext";
import {
  normalizeSnapshots,
  isEntryOnset,
  isLegacyReplayEntry,
  nextKospiConfirmedEntry,
  nextConfirmedEntry,
  heldDuringEntryWindow,
  firstBarAfter,
  barOnOrBefore,
  deriveExitPlan,
  latestSnapshotEntry,
  operationalExit,
  type ExitPlan,
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
  modelAccounting?: {
    cash: string;
    nav: string | null;
    valuationStatus: "COMPLETE" | "STALE" | "MISSING";
    fees: Record<string, { entry: string; exit: string | null }>;
    realizedPnl: string;
  };
  /** Research-only observations of this same executor, never a second cash simulation. */
  researchHistory?: {
    dailyNAV: KrResearchNavRow[];
    yearlyBudgets: KrResearchYearBudget[];
    exitTiming: Record<string, "OPEN" | "CLOSE">;
  };
}
export interface KrResearchNavRow {
  date: string;
  cash: string;
  marketValue: string;
  nav: string | null;
  realizedPnl: string;
  openPositions: number;
  valuationStatus: "COMPLETE" | "STALE" | "MISSING";
  entryBudget: string;
}
export interface KrResearchYearBudget {
  year: number;
  effectiveDate: string;
  valuationDate: string | null;
  nav: string;
  budget: string;
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
  /** Inert source references kept separate from the user-facing execution memo. */
  sourceLinks?: import("./ledger/executionMemo").ExecutionSourceLink[] | undefined;
  order: number;
}
export interface LedgerDocument {
  version: number;
  settings: PortfolioSettings;
  actualCapital: number;
  etfCapital?: number;
  executions: ActualExecution[];
  excluded: Record<string, string>;
  excludedSourceLinks?: Record<string, import("./ledger/executionMemo").ExecutionSourceLink[]>;
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

/** Explicit new-series opt-in. Historical callers keep the original execution contract. */
export type ProspectiveKrReplayPolicy =
  | {
      version: "kr-adopted-shadow-20261005-v1" | "kr-common-execution-20261012-v1";
      startDate: "2026-10-05" | "2026-10-12";
      throughDate: string;
      scope: "MIXED" | "KOSPI" | "KOSDAQ";
    }
  | {
      version: "kr-annual-signal-year-research-v2";
      startDate: string;
      throughDate: string;
      scope: "MIXED" | "KOSPI" | "KOSDAQ";
      entryBudgetPolicy: "ANNUAL_PRIOR_CLOSE_NAV";
    };

/** Deterministic strategy replay. No personal executions, exclusions or edited legacy fills enter here. */
export function simulateStrategy(
  settings: PortfolioSettings,
  input: ScreeningSnapshot[],
  bars: Record<string, DailyPrice[]>,
  markets: Record<string, Market>,
  fingerprint = "",
  marketDates: string[] = [],
  marketGates: Record<string, KospiMarketGateEvidence> = {},
  prospective?: ProspectiveKrReplayPolicy,
  marketLiquidCounts?: Record<string, number>,
): StrategyLedger {
  const research = prospective?.version === "kr-annual-signal-year-research-v2";
  const context = research ? CURRENT_RULES_RESEARCH : undefined;
  const unified = research || prospective?.version === "kr-common-execution-20261012-v1";
  if (unified && !marketLiquidCounts) {
    const observed = new Map<string, Set<string>>();
    for (const [symbol, rows] of Object.entries(bars))
      for (const bar of rows) {
        if (
          bar.tradeDate > prospective!.throughDate ||
          bar.volumeObserved === false ||
          !Number.isFinite(bar.volume) ||
          bar.volume <= 0
        )
          continue;
        const symbols = observed.get(bar.tradeDate) ?? new Set<string>();
        symbols.add(symbol);
        observed.set(bar.tradeDate, symbols);
      }
    marketLiquidCounts = Object.fromEntries(
      [...observed].map(([date, symbols]) => [date, symbols.size]),
    );
  }
  if (prospective) {
    if (
      (!unified && prospective.version !== "kr-adopted-shadow-20261005-v1") ||
      (!research && prospective.startDate !== (unified ? "2026-10-12" : "2026-10-05")) ||
      (research &&
        (!validDate(prospective.startDate) ||
          prospective.entryBudgetPolicy !== "ANNUAL_PRIOR_CLOSE_NAV" ||
          settings.maxPositions !== 30)) ||
      !validDate(prospective.throughDate) ||
      prospective.throughDate < prospective.startDate ||
      (!research && prospective.throughDate >= (unified ? "2027-10-12" : "2027-10-05")) ||
      (!unified && settings.initialCapital !== 100_000_000) ||
      !Number.isFinite(settings.initialCapital) ||
      settings.initialCapital <= 0 ||
      (!unified && settings.maxPositions !== 30) ||
      !Number.isInteger(settings.maxPositions) ||
      settings.maxPositions < 1 ||
      settings.roundTripCostRate !== 0.003
    )
      throw new Error("Invalid frozen first-year KR series contract");
    const inScope = (symbol: string) =>
      prospective.scope === "MIXED"
        ? markets[symbol] === "KOSPI" || markets[symbol] === "KOSDAQ"
        : markets[symbol] === prospective.scope;
    input = input
      .filter((s) => s.asOfDate >= prospective.startDate && s.asOfDate <= prospective.throughDate)
      .map((s) => ({
        ...s,
        entries: s.entries.filter(
          (e) =>
            inScope(e.symbol) &&
            (!e.kospiEntry?.originDate || e.kospiEntry.originDate >= prospective.startDate),
        ),
      }));
    bars = Object.fromEntries(
      Object.entries(bars)
        .filter(([symbol]) => inScope(symbol))
        .map(([symbol, series]) => [
          symbol,
          series.filter((b) => b.tradeDate <= prospective.throughDate),
        ]),
    );
    marketDates = marketDates.filter((date) => date <= prospective.throughDate);
  }
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
  let latest = Object.values(bars).reduce<string | null>((d, b) => {
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
  if (unified) latest = observedDates.at(-1) ?? latest;
  const liquidSymbolsByDate = new Map<string, Set<string>>();
  if (unified)
    for (const [symbol, rows] of Object.entries(entryBars))
      for (const bar of rows) {
        if (!(bar.volume > 0) || bar.volumeObserved === false) continue;
        const symbols = liquidSymbolsByDate.get(bar.tradeDate) ?? new Set<string>();
        symbols.add(symbol);
        liquidSymbolsByDate.set(bar.tradeDate, symbols);
      }
  type ReplayCandidate = Candidate & { executable: boolean; confirmedPolicy: boolean };
  const byKey = new Map<string, ReplayCandidate>();
  for (const snapshot of snapshots)
    for (const entry of snapshot.entries) {
      const market = markets[entry.symbol] ?? (entry.kospiEntry ? "KOSPI" : undefined);
      if (!market || entry.instrumentType !== "STOCK") continue;
      const confirmation = market === "KOSPI" ? entry.kospiEntry : undefined;
      const legacy = !research && isLegacyReplayEntry(entry, market, snapshot.asOfDate);
      const executable = isEntryOnset(entry, market, snapshot.asOfDate, context) || legacy;
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
            context,
          );
          next = execution.bar;
          decision = execution.reason;
        } else if (
          confirmation?.state === "confirmed" &&
          !research &&
          snapshot.asOfDate < KOSPI_ENTRY_POLICY.effectiveConfirmationDate
        ) {
          decision = "적용일 이전 · 참고용";
        } else if (
          !confirmation ||
          confirmation.date !== snapshot.asOfDate ||
          confirmation.version !== kospiPolicyVersionAt(confirmation.date, context)
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
      } else
        next = unified
          ? nextConfirmedEntry(
              entryBars[entry.symbol] ?? [],
              snapshot.asOfDate,
              observedDates,
              true,
            ).bar
          : firstBarAfter(bars[entry.symbol] ?? [], snapshot.asOfDate);
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
  let exactCash = prospective ? decimal(fromLegacyNumber(settings.initialCapital)) : 0n,
    exactRealized = 0n;
  const exactBasis = new Map<string, bigint>();
  const modelFees: Record<string, { entry: string; exit: string | null }> = {};
  const dailyNAV: KrResearchNavRow[] = [];
  const yearlyBudgets: KrResearchYearBudget[] = [];
  const exitTiming: Record<string, "OPEN" | "CLOSE"> = {};
  let entryBudget = prospective
    ? divide(
        decimal(fromLegacyNumber(settings.initialCapital)),
        decimal(String(settings.maxPositions)),
      )
    : 0n;
  const exactFee = (gross: bigint) =>
    (gross * decimal("0.0015") + decimal("1") - 1n) / decimal("1");
  const researchExitPlans = new Map<string, ExitPlan | null>();
  const researchHealthyDates = new Map<string, string[]>();
  const closeDue = (cutoff: string, beforeEntry: boolean) => {
    for (const t of trades) {
      if (t.status !== "OPEN" || !latest) continue;
      const healthyDates =
        research && researchHealthyDates.has(t.symbol)
          ? researchHealthyDates.get(t.symbol)!
          : unified
            ? observedDates.filter((date) => {
                const symbols = liquidSymbolsByDate.get(date);
                return (
                  (marketLiquidCounts?.[date] ?? symbols?.size ?? 0) >
                  (symbols?.has(t.symbol) ? 1 : 0)
                );
              })
            : undefined;
      if (research && healthyDates && !researchHealthyDates.has(t.symbol))
        researchHealthyDates.set(t.symbol, healthyDates);
      const plan =
        research && researchExitPlans.has(t.id)
          ? researchExitPlans.get(t.id)!
          : deriveExitPlan(
              t,
              snapshots,
              unified ? (entryBars[t.symbol] ?? []) : (bars[t.symbol] ?? []),
              latest,
              healthyDates,
              observedDates,
            );
      if (research && !researchExitPlans.has(t.id)) researchExitPlans.set(t.id, plan);
      if (
        !plan ||
        plan.exitDate > cutoff ||
        (beforeEntry && plan.exitDate === cutoff && plan.timing === "CLOSE")
      )
        continue;
      const grossExact = prospective
        ? decimal(fromLegacyNumber(plan.exitPrice)) * BigInt(t.shares)
        : 0n;
      const feeExact = prospective ? exactFee(grossExact) : 0n;
      const pnlExact = prospective ? grossExact - feeExact - exactBasis.get(t.id)! : 0n;
      const fee = prospective ? Number(format(feeExact)) : money(t.shares * plan.exitPrice * half),
        pnl = prospective
          ? Number(format(pnlExact))
          : money(t.shares * plan.exitPrice - fee - t.buyAmount - t.entryFee);
      if (prospective) {
        exactCash += grossExact - feeExact;
        exactRealized += pnlExact;
        modelFees[t.id]!.exit = format(feeExact);
        if (research) exitTiming[t.id] = plan.timing;
      }
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
        holdingDays: ((unified ? entryBars : bars)[t.symbol] ?? []).filter(
          (b) => b.tradeDate >= t.entryDate && b.tradeDate <= plan.exitDate,
        ).length,
      });
      cash = prospective ? Number(format(exactCash)) : cash + t.shares * plan.exitPrice - fee;
    }
  };
  const researchDates = research
    ? [...new Set(observedDates)]
        .filter((date) => date >= prospective!.startDate && date <= prospective!.throughDate)
        .sort()
    : [];
  let researchDateIndex = 0;
  const ensureYearBudget = (date: string) => {
    const year = Number(date.slice(0, 4));
    if (yearlyBudgets.at(-1)?.year === year) return;
    const previousClose = dailyNAV.at(-1);
    if (previousClose?.nav === null)
      throw new Error("Cannot reset annual KR budget without prior-close NAV");
    const nav = previousClose?.nav ?? fromLegacyNumber(settings.initialCapital);
    entryBudget = divide(decimal(nav), decimal(String(settings.maxPositions)));
    yearlyBudgets.push({
      year,
      effectiveDate: date,
      valuationDate: previousClose?.date ?? null,
      nav,
      budget: format(entryBudget),
    });
  };
  const recordResearchClose = (date: string) => {
    const active = trades.filter((trade) => trade.status === "OPEN");
    let marketValue = 0n;
    let valuationStatus: KrResearchNavRow["valuationStatus"] = "COMPLETE";
    for (const trade of active) {
      const mark = barOnOrBefore(bars[trade.symbol] ?? [], date);
      if (!mark) {
        valuationStatus = "MISSING";
        continue;
      }
      if (mark.tradeDate !== date && valuationStatus !== "MISSING") valuationStatus = "STALE";
      marketValue += decimal(fromLegacyNumber(mark.close)) * BigInt(trade.shares);
    }
    dailyNAV.push({
      date,
      cash: format(exactCash),
      marketValue: format(marketValue),
      nav: valuationStatus === "MISSING" ? null : format(exactCash + marketValue),
      realizedPnl: format(exactRealized),
      openPositions: active.length,
      valuationStatus,
      entryBudget: format(entryBudget),
    });
  };
  /** Close each intervening calendar session before the next entry, including quiet year boundaries. */
  const advanceResearch = (cutoff: string, includeCutoff: boolean) => {
    if (!research) return;
    while (researchDateIndex < researchDates.length) {
      const date = researchDates[researchDateIndex]!;
      if (date > cutoff || (!includeCutoff && date === cutoff)) break;
      ensureYearBudget(date);
      closeDue(date, false);
      recordResearchClose(date);
      researchDateIndex++;
    }
    if (!includeCutoff && researchDates[researchDateIndex] === cutoff) ensureYearBudget(cutoff);
  };
  const executionQueue = [...rawCandidates];
  while (executionQueue.length) {
    const candidate = executionQueue.shift()!;
    const { executable, confirmedPolicy, ...c } = candidate;
    if (c.entryDate) advanceResearch(c.entryDate, false);
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
    // Cancel only an observed exit after the originating signal and before this open.
    // An origin-day KOSDAQ U9 retains its existing entry priority; unknown rows do not cancel.
    if (
      unified &&
      snapshots.some(
        (snapshot) =>
          snapshot.asOfDate > (c.originDate ?? c.signalDate) &&
          snapshot.asOfDate < (c.entryDate ?? "9999") &&
          snapshot.asOfDate <= (latest ?? "") &&
          snapshot.entries.some(
            (entry) => entry.symbol === c.symbol && operationalExit(entry, c.market, true),
          ),
      )
    ) {
      const cancelled = {
        ...c,
        entryDate: null,
        price: null,
        decision: "청산 신호 관측 · 미체결 진입 취소",
      };
      const prior = candidates.findIndex((item) => item.key === c.key);
      if (prior >= 0) candidates[prior] = cancelled;
      else candidates.push(cancelled);
      continue;
    }
    const priorCandidate = candidates.findIndex((item) => item.key === c.key);
    if (priorCandidate >= 0) candidates[priorCandidate] = c;
    else candidates.push(c);
    const defer = (reason: string) => {
      c.decision = unified ? `${reason} · 미체결 이월` : reason;
      if (!unified || !c.entryDate) return;
      const next = nextConfirmedEntry(
        entryBars[c.symbol] ?? [],
        c.entryDate,
        observedDates,
        true,
      ).bar;
      if (!next || !latest || next.tradeDate > latest) return;
      executionQueue.push({ ...candidate, entryDate: next.tradeDate, price: next.open });
      executionQueue.sort(
        (a, b) =>
          (a.entryDate ?? "9999").localeCompare(b.entryDate ?? "9999") ||
          (b.technical ?? -Infinity) - (a.technical ?? -Infinity) ||
          (b.priority ?? -Infinity) - (a.priority ?? -Infinity) ||
          a.symbol.localeCompare(b.symbol),
      );
    };
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
    if (unified && c.market === "KOSPI") {
      const priorDate = observedDates.filter((date) => date < c.entryDate!).at(-1);
      const gate = priorDate ? marketGates[priorDate] : undefined;
      if (
        !gate ||
        gate.incomplete ||
        gate.issues.length ||
        !["RISK_ON", "NEUTRAL"].includes(gate.status)
      ) {
        defer("체결 전 시장국면 제한");
        continue;
      }
    }
    const active = trades.filter((t) => t.status === "OPEN");
    if (active.some((t) => t.symbol === c.symbol)) {
      c.decision = "동일 종목 보유";
      continue;
    }
    if (active.length >= settings.maxPositions) {
      defer(`${settings.maxPositions}종목 한도`);
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
      defer("섹터 한도");
      continue;
    }
    const signalYearBudget = research
      ? yearlyBudgets.find((year) => year.year === Number(c.signalDate.slice(0, 4)))
      : undefined;
    if (research && !signalYearBudget) throw new Error("Missing KR signal-year entry budget");
    const candidateBudget = research ? decimal(signalYearBudget!.budget) : entryBudget;
    const target = research
      ? Number(format(candidateBudget))
      : settings.initialCapital / settings.maxPositions;
    const affordable = Math.floor(cash / (c.price * (1 + half)));
    if (!prospective && affordable < 1) {
      c.decision = "현금 부족";
      continue;
    }
    const shares = prospective
      ? Number(
          integerBudgetQuantity(
            research
              ? format(candidateBudget)
              : format(
                  divide(
                    decimal(fromLegacyNumber(settings.initialCapital)),
                    decimal(String(settings.maxPositions)),
                  ),
                ),
            format(exactCash),
            fromLegacyNumber(c.price),
            "0.0015",
          ),
        )
      : Math.min(Math.max(1, Math.round(target / c.price)), affordable);
    if (shares < 1) {
      defer("목표예산 내 정수 수량 없음");
      continue;
    }
    const grossExact = prospective ? decimal(fromLegacyNumber(c.price)) * BigInt(shares) : 0n;
    const feeExact = prospective ? exactFee(grossExact) : 0n;
    const amount = prospective ? Number(format(grossExact)) : money(shares * c.price),
      fee = prospective ? Number(format(feeExact)) : money(amount * half);
    if (prospective) {
      exactCash -= grossExact + feeExact;
      if (exactCash < 0n) throw new Error("Exact KR model cash overspend");
      exactBasis.set(c.key, grossExact + feeExact);
      modelFees[c.key] = { entry: format(feeExact), exit: null };
      cash = Number(format(exactCash));
    } else cash -= amount + fee;
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
  if (latest) {
    if (research) advanceResearch(latest, true);
    else closeDue(latest, false);
  }
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
    t.holdingDays = ((unified ? entryBars : bars)[t.symbol] ?? []).filter(
      (b) =>
        b.tradeDate >= t.entryDate &&
        b.tradeDate <= (unified ? (latest ?? t.markDate!) : t.markDate!),
    ).length;
    const v = t.shares * t.currentPrice;
    value += v;
    unrealized += v - t.buyAmount - t.entryFee;
    count++;
  }
  return {
    trades,
    candidates,
    summary: {
      ...summary(
        settings.initialCapital,
        cash,
        value,
        realized,
        unrealized,
        count,
        latest,
        settings.maxPositions,
      ),
      ...(research ? { slotTargetAmount: Number(format(entryBudget)) } : {}),
    },
    firstSignalDate: snapshots[0]?.asOfDate ?? null,
    quotes,
    fingerprint,
    calculatedAt: new Date().toISOString(),
    ...(research ? { researchHistory: { dailyNAV, yearlyBudgets, exitTiming } } : {}),
    ...(prospective
      ? {
          modelAccounting: {
            cash: format(exactCash),
            nav: trades.filter((t) => t.status === "OPEN").some((t) => !quotes[t.symbol])
              ? null
              : format(
                  exactCash +
                    trades
                      .filter((t) => t.status === "OPEN")
                      .reduce(
                        (sum, t) =>
                          sum +
                          decimal(fromLegacyNumber(quotes[t.symbol]!.price)) * BigInt(t.shares),
                        0n,
                      ),
                ),
            valuationStatus: trades
              .filter((t) => t.status === "OPEN")
              .some((t) => !quotes[t.symbol])
              ? ("MISSING" as const)
              : trades
                    .filter((t) => t.status === "OPEN")
                    .some((t) => quotes[t.symbol]!.date !== prospective.throughDate)
                ? ("STALE" as const)
                : ("COMPLETE" as const),
            fees: modelFees,
            realizedPnl: format(exactRealized),
          },
        }
      : {}),
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
