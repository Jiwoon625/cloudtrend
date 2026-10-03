import { decimal, format, fromLegacyNumber } from "../ledger/decimal";
import {
  US_PROSPECTIVE_MAX_POSITIONS,
  US_PROSPECTIVE_ONE_WAY_COST,
  US_PROSPECTIVE_PARTICIPATION,
  usFixedSlotPendingTargets,
  usFixedSlotBudget,
  type UsFixedSlotAllocationPolicy,
  type UsPendingTarget,
  type UsPortfolioState,
  type UsStrategyConfig,
} from "./usProspectivePortfolio";

/** Display-only projections. Never consumed by the frozen execution engine. */
export interface UsOrderPreviewQuote {
  symbol: string;
  name: string;
  sector: string | null;
  close: number | null;
  date: string;
}
export interface UsOrderPreviewRow {
  symbol: string;
  name: string;
  reason: string;
  side: "BUY" | "SELL" | "HOLD" | "EXIT";
  currentShares: number;
  targetShares: number | null;
  targetWeight: number | null;
  estimatedShares: number | null;
  remainingShares: number | null;
  referencePrice: number | null;
  priceDate: string | null;
  estimatedNotionalUsd: number | null;
  status: "ESTIMATED" | "PARTIAL" | "NO_CHANGE" | "BLOCKED";
  limitReason: string | null;
}
export interface UsOrderPlan {
  kind: "PENDING" | "QUARTER";
  sourceDate: string;
  quarter: string | null;
  confirmationDate: string;
  executionDate: string;
  status: "PROVISIONAL" | "READY" | "BLOCKED";
  navUsd: number | null;
  cashBeforeUsd: number | null;
  cashAfterUsd: number | null;
  feesUsd: number | null;
  rows: UsOrderPreviewRow[];
  warnings: string[];
}
export interface UsOrderPreviewBundle {
  version: 1;
  sourceDate: string;
  nextSession: UsOrderPlan;
  nextQuarter: UsOrderPlan | null;
  allocationPolicy?: UsFixedSlotAllocationPolicy;
}
const iso = (date: Date) => date.toISOString().slice(0, 10);
const day = (date: string, offset = 0) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return iso(value);
};
const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && day(date) === date;
const quarter = (date: string) => `${date.slice(0, 4)}Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const nthWeekday = (year: number, month: number, dow: number, nth: number) => {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  return day(first, ((dow - weekday(first) + 7) % 7) + (nth - 1) * 7);
};
const observed = (date: string) =>
  day(date, weekday(date) === 6 ? -1 : weekday(date) === 0 ? 1 : 0);
function easter(year: number) {
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100;
  const d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const date = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
}
/** Scheduled NYSE equity sessions, not evidence a future market actually opened.
 * https://www.nyse.com/trade/hours-calendars (2026–2028 verified 2026-10-02).
 * Jan 1 on Saturday is NOT observed on Dec 31. Exceptional closures can supersede this calendar.
 * Noon UTC/date-only arithmetic makes KST, New York and DST identical for session labels.
 */
export function isScheduledUsSession(date: string): boolean {
  if (!validDate(date)) return false;
  if ([0, 6].includes(weekday(date))) return false;
  const year = Number(date.slice(0, 4));
  const jan1 = `${year}-01-01`;
  const memorial = day(nthWeekday(year, 6, 1, 1), -7);
  const holidays = new Set([
    weekday(jan1) === 0 ? day(jan1, 1) : jan1,
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    day(easter(year), -2),
    memorial,
    ...(year >= 2022 ? [observed(`${year}-06-19`)] : []),
    observed(`${year}-07-04`),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observed(`${year}-12-25`),
    "2025-01-09", // National day of mourning for President Carter.
  ]);
  return !holidays.has(date);
}
export function nextScheduledUsSession(date: string, direction: 1 | -1 = 1): string {
  let next = day(date, direction);
  while (!isScheduledUsSession(next)) next = day(next, direction);
  return next;
}
function nextQuarterStart(date: string) {
  const year = Number(date.slice(0, 4));
  const month = Math.floor((Number(date.slice(5, 7)) - 1) / 3) * 3 + 3;
  return iso(new Date(Date.UTC(year, month, 1, 12)));
}
const positive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Estimate a single future open by substituting ONLY known close prices.
 * Deliberately independent of stepUsProspectivePortfolio: no signals, trades or NAV are written.
 * Sell exits first, value post-exit NAV, then target reductions/buys, matching frozen sizing order.
 */
function plan(
  config: UsStrategyConfig,
  state: UsPortfolioState,
  quotes: Map<string, UsOrderPreviewQuote>,
  targets: Record<string, UsPendingTarget>,
  executionDate: string,
  kind: UsOrderPlan["kind"],
  quarterKey: string | null,
  allocationPolicy?: UsFixedSlotAllocationPolicy,
): UsOrderPlan {
  const fixedSlots = allocationPolicy && executionDate >= allocationPolicy.effectiveDate;
  const oneWayCost = state.executionPolicy
    ? Number(state.executionPolicy.oneWayCost)
    : US_PROSPECTIVE_ONE_WAY_COST;
  const sourceDate = state.lastDate!;
  const confirmationDate = nextScheduledUsSession(executionDate, -1);
  const result: UsOrderPlan = {
    kind,
    sourceDate,
    quarter: quarterKey,
    confirmationDate,
    executionDate,
    status: sourceDate === confirmationDate ? "READY" : "PROVISIONAL",
    navUsd: null,
    cashBeforeUsd: Number.isFinite(state.cash) ? state.cash : null,
    cashAfterUsd: null,
    feesUsd: null,
    rows: [],
    warnings: [],
  };
  if (result.status === "PROVISIONAL")
    result.warnings.push(
      "현재 저장된 보유·신호·종가가 유지된다는 가정입니다. 분기 직전 거래일까지 종목·수량이 바뀔 수 있습니다.",
    );
  if (Number(executionDate.slice(0, 4)) > 2028 || Number(executionDate.slice(0, 4)) < 2026)
    result.warnings.push(
      "거래일은 정기 휴장 규칙으로 추정했습니다. 해당 연도 거래소 일정을 다시 확인하세요.",
    );
  const holdings = Object.fromEntries(
    Object.entries(state.positions).map(([symbol, p]) => [symbol, { ...p }]),
  );
  const entries = Object.values(targets).filter((t) => !state.pendingExits[t.symbol]);
  const exits = Object.values(state.pendingExits).filter((t) => holdings[t.symbol]);
  const names = new Set([...Object.keys(holdings), ...entries.map((t) => t.symbol)]);
  const price = (symbol: string) => {
    const q = quotes.get(symbol);
    return q?.date === sourceDate && positive(q.close) ? q.close : null;
  };
  const makeRow = (
    symbol: string,
    reason: string,
    targetWeight: number | null,
  ): UsOrderPreviewRow => ({
    symbol,
    name: quotes.get(symbol)?.name ?? holdings[symbol]?.name ?? symbol,
    reason,
    side: "HOLD",
    currentShares: holdings[symbol]?.shares ?? 0,
    targetShares: null,
    targetWeight,
    estimatedShares: null,
    remainingShares: null,
    referencePrice: price(symbol),
    priceDate: price(symbol) === null ? null : sourceDate,
    estimatedNotionalUsd: null,
    status: "BLOCKED",
    limitReason: null,
  });
  const invalid =
    !Number.isFinite(state.cash) ||
    state.cash < 0 ||
    Object.values(holdings).some((p) => !Number.isInteger(p.shares) || p.shares < 0) ||
    entries.some(
      (t) => !Number.isFinite(t.targetWeight) || t.targetWeight < 0 || t.targetWeight > 1,
    ) ||
    [...names].some((symbol) => price(symbol) === null);
  if (invalid) {
    result.status = "BLOCKED";
    result.warnings.push(
      "동일 확정일 종가 또는 모델 잔고를 확인할 수 없어 예정수량을 계산하지 않았습니다.",
    );
    result.rows = [
      ...exits.map((t) => ({
        ...makeRow(t.symbol, t.reason, 0),
        side: "EXIT" as const,
        targetShares: 0,
      })),
      ...entries.map((t) => makeRow(t.symbol, t.reason, t.targetWeight)),
    ].map((r) => ({ ...r, limitReason: "확정일 가격·잔고 확인 필요" }));
    return result;
  }
  let cash = state.cash,
    fees = 0;
  const capacity = (symbol: string) => {
    const adv = state.adv20BySymbol?.[symbol];
    return positive(adv) ? Math.floor((adv * US_PROSPECTIVE_PARTICIPATION) / price(symbol)!) : 0;
  };
  const estimate = (
    r: UsOrderPreviewRow,
    desired: number,
    requested: number,
    shares: number,
    limit: string | null,
  ) => {
    r.targetShares = desired;
    r.estimatedShares = shares;
    r.remainingShares = Math.max(0, requested - shares);
    r.estimatedNotionalUsd = shares * r.referencePrice!;
    r.status = requested === 0 ? "NO_CHANGE" : shares < requested ? "PARTIAL" : "ESTIMATED";
    r.limitReason = limit;
    const fee = state.executionPolicy
      ? Number(
          format(
            (decimal(fromLegacyNumber(r.referencePrice!)) *
              BigInt(shares) *
              decimal(state.executionPolicy.oneWayCost) +
              decimal("1") -
              1n) /
              decimal("1"),
          ),
        )
      : r.estimatedNotionalUsd * oneWayCost;
    fees += fee;
    cash += r.side === "BUY" ? -r.estimatedNotionalUsd - fee : r.estimatedNotionalUsd - fee;
    result.rows.push(r);
  };
  for (const exit of exits) {
    const p = holdings[exit.symbol]!;
    const r = makeRow(exit.symbol, exit.reason, 0);
    r.side = "EXIT";
    const shares = Math.min(p.shares, capacity(exit.symbol));
    estimate(
      r,
      0,
      p.shares,
      shares,
      shares < p.shares ? "직전 ADV20 1% 한도 · 잔량 청산 우선" : null,
    );
    p.shares -= shares;
    if (p.shares === 0) delete holdings[exit.symbol];
  }
  // This NAV includes unfilled exit holdings, just as the engine does.
  const targetNav =
    cash + Object.values(holdings).reduce((sum, p) => sum + p.shares * price(p.symbol)!, 0);
  result.navUsd = targetNav;
  const orders = entries
    .map((t) => {
      const current = holdings[t.symbol]?.shares ?? 0;
      const desired = fixedSlots
        ? Math.max(
            current,
            t.fixedTargetShares ??
              Number(decimal(t.fixedBudgetUsd!) / decimal(fromLegacyNumber(price(t.symbol)!))),
          )
        : Math.max(0, Math.floor((t.targetWeight * targetNav) / price(t.symbol)!));
      const budget = fixedSlots ? decimal(t.remainingBudgetUsd ?? t.fixedBudgetUsd!) : 0n;
      const reserved =
        fixedSlots && t.fixedTargetShares === undefined
          ? decimal(fromLegacyNumber(price(t.symbol)!)) * BigInt(current)
          : 0n;
      const remainingBudget = budget > reserved ? budget - reserved : 0n;
      return {
        t,
        current,
        desired,
        delta: fixedSlots ? Math.max(0, desired - current) : desired - current,
        remainingBudget,
      };
    })
    .sort((a, b) => a.delta - b.delta);
  for (const { t, current, desired, delta, remainingBudget } of orders) {
    const r = makeRow(t.symbol, t.reason, t.targetWeight);
    r.side = delta < 0 ? "SELL" : delta > 0 ? "BUY" : "HOLD";
    const requested = Math.abs(delta);
    let shares = Math.min(requested, capacity(t.symbol));
    const reasons: string[] = [];
    if (shares < requested) reasons.push("직전 ADV20 1% 한도");
    if (delta > 0) {
      const affordable = Math.max(0, Math.floor(cash / (price(t.symbol)! * (1 + oneWayCost))));
      if (affordable < shares) reasons.push("현금·비용 한도");
      shares = Math.min(shares, affordable);
      if (fixedSlots) {
        const budgetShares = Number(remainingBudget / decimal(fromLegacyNumber(price(t.symbol)!)));
        if (budgetShares < shares) reasons.push("초기자본 고정 매입예산 한도");
        shares = Math.min(shares, budgetShares);
      }
      if (!holdings[t.symbol]) {
        const held = Object.values(holdings);
        const sector = quotes.get(t.symbol)?.sector ?? "UNKNOWN";
        if (held.length >= US_PROSPECTIVE_MAX_POSITIONS) {
          shares = 0;
          reasons.push("최대 보유종목 한도");
        }
        if (
          config.sectorCap &&
          held.filter((p) => (p.sector ?? "UNKNOWN") === sector).length >= config.sectorCap
        ) {
          shares = 0;
          reasons.push("섹터 한도");
        }
      }
    }
    estimate(r, desired, requested, shares, reasons.join(" · ") || null);
    const after = current + (delta > 0 ? shares : -shares);
    if (after > 0)
      holdings[t.symbol] = holdings[t.symbol]
        ? { ...holdings[t.symbol]!, shares: after, lastPrice: price(t.symbol)! }
        : {
            symbol: t.symbol,
            name: r.name,
            sector: quotes.get(t.symbol)?.sector ?? null,
            shares: after,
            lastPrice: price(t.symbol)!,
            entryDate: sourceDate,
            entryCoreRank: null,
          };
    else delete holdings[t.symbol];
  }
  result.cashAfterUsd = cash;
  result.feesUsd = fees;
  return result;
}

export function buildUsOrderPreview(
  config: UsStrategyConfig,
  state: UsPortfolioState,
  sourceQuotes: UsOrderPreviewQuote[],
  requestedAllocationPolicy?: UsFixedSlotAllocationPolicy,
): UsOrderPreviewBundle | null {
  const allocationPolicy = requestedAllocationPolicy ?? state.allocationPolicy;
  if (allocationPolicy) {
    usFixedSlotBudget(allocationPolicy);
    if (Number(allocationPolicy.initialCapitalUsd) !== state.initialCapital) return null;
  }
  if (
    !state.lastDate ||
    !validDate(state.lastDate) ||
    !state.positions ||
    !state.pendingTargets ||
    !state.pendingExits
  )
    return null;
  // Completed snapshots cannot contain future signals or mismatched map identities.
  // Reject malformed legacy state rather than sizing orders the execution engine would skip.
  if (
    !Object.entries(state.positions).every(([symbol, p]) => p && p.symbol === symbol) ||
    ![...Object.entries(state.pendingTargets), ...Object.entries(state.pendingExits)].every(
      ([symbol, pending]) =>
        pending &&
        pending.symbol === symbol &&
        validDate(pending.signalDate) &&
        pending.signalDate <= state.lastDate!,
    )
  )
    return null;
  const quotes = new Map(
    sourceQuotes.filter((q) => q.date === state.lastDate).map((q) => [q.symbol, q]),
  );
  const start = nextQuarterStart(state.lastDate);
  const executionDate = isScheduledUsSession(start) ? start : nextScheduledUsSession(start);
  // Overwriting a pending key must retain its insertion order: the frozen engine's
  // stable delta sort uses that order to allocate cash when two buys tie.
  const quarterTargets: Record<string, UsPendingTarget> = { ...state.pendingTargets };
  const symbols = [
    ...new Set([...Object.keys(state.positions), ...Object.keys(state.pendingTargets)]),
  ].filter((symbol) => !state.pendingExits[symbol]);
  for (const symbol of symbols)
    quarterTargets[symbol] = {
      symbol,
      targetWeight: 1 / symbols.length,
      signalDate: state.lastDate,
      reason: "QUARTER_EQUAL_WEIGHT",
    };
  const nextQuarter =
    config.quarterlyRebalance &&
    !(allocationPolicy && executionDate >= allocationPolicy.effectiveDate)
      ? plan(
          config,
          state,
          quotes,
          quarterTargets,
          executionDate,
          "QUARTER",
          quarter(start),
          allocationPolicy,
        )
      : null;
  const nextDate = nextScheduledUsSession(state.lastDate);
  const nextSession =
    nextQuarter?.executionDate === nextDate
      ? { ...nextQuarter, kind: "PENDING" as const }
      : plan(
          config,
          state,
          quotes,
          allocationPolicy && nextDate >= allocationPolicy.effectiveDate
            ? usFixedSlotPendingTargets(state, allocationPolicy)
            : state.pendingTargets,
          nextDate,
          "PENDING",
          null,
          allocationPolicy,
        );
  return {
    version: 1,
    sourceDate: state.lastDate,
    nextSession,
    nextQuarter,
    ...(allocationPolicy ? { allocationPolicy: { ...allocationPolicy } } : {}),
  };
}

/** Reject stale/partial persisted presentation payloads rather than displaying fabricated zeros. */
export function isUsOrderPreviewBundle(
  value: unknown,
  sourceDate: string,
): value is UsOrderPreviewBundle {
  if (!value || typeof value !== "object" || !validDate(sourceDate)) return false;
  const bundle = value as UsOrderPreviewBundle;
  const nullableNumber = (n: unknown) =>
    n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0);
  const checkRow = (r: UsOrderPreviewRow): boolean => {
    if (
      !r ||
      typeof r.symbol !== "string" ||
      !r.symbol ||
      typeof r.name !== "string" ||
      typeof r.reason !== "string" ||
      !["BUY", "SELL", "HOLD", "EXIT"].includes(r.side) ||
      !["ESTIMATED", "PARTIAL", "NO_CHANGE", "BLOCKED"].includes(r.status) ||
      !Number.isInteger(r.currentShares) ||
      r.currentShares < 0 ||
      ![r.targetShares, r.estimatedShares, r.remainingShares].every(
        (n) => n === null || (Number.isInteger(n) && n >= 0),
      ) ||
      !nullableNumber(r.targetWeight) ||
      (r.targetWeight !== null && r.targetWeight > 1) ||
      !(r.referencePrice === null || positive(r.referencePrice)) ||
      !nullableNumber(r.estimatedNotionalUsd) ||
      !(r.priceDate === null || r.priceDate === sourceDate) ||
      !(r.limitReason === null || typeof r.limitReason === "string")
    )
      return false;
    if ((r.referencePrice === null) !== (r.priceDate === null)) return false;
    if (r.status === "BLOCKED")
      return (
        r.estimatedShares === null && r.remainingShares === null && r.estimatedNotionalUsd === null
      );
    if (
      r.targetShares === null ||
      r.estimatedShares === null ||
      r.remainingShares === null ||
      r.referencePrice === null ||
      r.estimatedNotionalUsd === null
    )
      return false;
    const delta = r.targetShares - r.currentShares;
    if (
      r.side === "EXIT"
        ? r.targetShares !== 0
        : r.side !== (delta < 0 ? "SELL" : delta > 0 ? "BUY" : "HOLD")
    )
      return false;
    const requested = Math.abs(delta);
    return (
      r.estimatedShares <= requested &&
      r.remainingShares === requested - r.estimatedShares &&
      Math.abs(r.estimatedNotionalUsd - r.estimatedShares * r.referencePrice) < 1e-6 &&
      r.status ===
        (requested === 0 ? "NO_CHANGE" : r.estimatedShares < requested ? "PARTIAL" : "ESTIMATED")
    );
  };
  const start = nextQuarterStart(sourceDate);
  const quarterDate = isScheduledUsSession(start) ? start : nextScheduledUsSession(start);
  const nextDate = nextScheduledUsSession(sourceDate);
  const checkPlan = (p: UsOrderPlan | null, kind: UsOrderPlan["kind"]) => {
    if (
      !p ||
      p.kind !== kind ||
      p.sourceDate !== sourceDate ||
      p.executionDate !== (kind === "QUARTER" ? quarterDate : nextDate) ||
      p.confirmationDate !== nextScheduledUsSession(p.executionDate, -1) ||
      p.confirmationDate < sourceDate ||
      p.quarter !==
        (kind === "QUARTER" || (bundle.nextQuarter !== null && nextDate === quarterDate)
          ? quarter(start)
          : null) ||
      !["PROVISIONAL", "READY", "BLOCKED"].includes(p.status) ||
      (p.status !== "BLOCKED" &&
        p.status !== (sourceDate === p.confirmationDate ? "READY" : "PROVISIONAL")) ||
      ![p.navUsd, p.cashBeforeUsd, p.cashAfterUsd, p.feesUsd].every(nullableNumber) ||
      !Array.isArray(p.warnings) ||
      !p.warnings.every((w) => typeof w === "string") ||
      !Array.isArray(p.rows) ||
      !p.rows.every(checkRow) ||
      new Set(p.rows.map((r) => r.symbol)).size !== p.rows.length
    )
      return false;
    return (
      p.status === "BLOCKED" ||
      [p.navUsd, p.cashBeforeUsd, p.cashAfterUsd, p.feesUsd].every((n) => n !== null)
    );
  };
  return (
    bundle.version === 1 &&
    bundle.sourceDate === sourceDate &&
    checkPlan(bundle.nextSession, "PENDING") &&
    (bundle.nextQuarter === null || checkPlan(bundle.nextQuarter, "QUARTER"))
  );
}
