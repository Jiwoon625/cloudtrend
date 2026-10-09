import { decimal, divide, format, multiply } from "./decimal";
import { validDate } from "./date";
import { canonicalJson } from "./migration";
import { validateSource } from "./validation";
import type { CashLeg, Currency, FxMark, SourceRef } from "./types";
import type { AccountValuation } from "./valuation";

/** Reporting identity only. The underlying ACTUAL journal and tax basis never restart. */
export const ACTUAL_PERFORMANCE_SERIES = "actual-performance-2026-10-12-v1";
export const ACTUAL_PERFORMANCE_START = "2026-10-12";
export interface PerformanceSnapshot {
  date: string;
  recordedAt: string;
  source: SourceRef;
  /** Audited allocated-slice valuations, never full broker holdings or legacy asset-card cash. */
  accounts: AccountValuation[];
  fx: FxMark[];
  complete: boolean;
  /** Explicit reviewed last market sessions (e.g. a local holiday), never guessed from weekday. */
  requiredPriceDates?: Partial<Record<Currency, string>>;
  /** Separately approved prior-session opening FX; never inherited from MODEL contracts. */
  requiredFxDate?: string;
}
export interface PerformanceBaseline {
  scope: "POST_START_ALLOCATED_CAPITAL";
  baseCurrency: Currency;
  scopeConfirmed: boolean;
  accountScope: { accountId: string; currency: Currency }[];
  pricePolicy: "EXPLICIT_DATED_MARKS_BEFORE_START";
  /** Immediately before the first event on the start date; prices retain their actual dates. */
  valuation: PerformanceSnapshot;
  confirmedAt: string;
  sourceRevisions: { domestic: number; us: number };
  /** Frozen reviewable pre-restart summaries, not fabricated historical daily NAV. */
  betaArchive: { asOfDate: string; source: SourceRef; summaries: Record<string, string | null> };
}
export interface PerformanceFlow {
  id: string;
  date: string;
  kind: "DEPOSIT" | "WITHDRAWAL" | "TRANSFER";
  /** Unknown intraday timing permits P&L but blocks a fabricated time-weighted return. */
  timing: "BEGINNING" | "END" | "UNKNOWN";
  legs: CashLeg[];
  fx: FxMark[];
  source: SourceRef;
}
export interface PerformanceObservation {
  valuation: PerformanceSnapshot;
  previousDate: string;
  flowsComplete: boolean;
  intervalComplete: boolean;
  flows: PerformanceFlow[];
  allocationConfirmed: boolean;
  tradeAllocations: TradeAllocation[];
  cashAdjustments: CashAdjustment[];
}
/** Explicit partial or whole allocation of one source execution, never an inferred FIFO transfer. */
export interface TradeAllocation {
  sourceSystem: "portfolio_ledgers" | "us_actual_portfolio_ledgers";
  executionId: string;
  date: string;
  order: number;
  accountId: string;
  currency: Currency;
  securityId: string;
  side: "BUY" | "SELL";
  quantity: string;
  price: string;
  /** Verified source gross; rounded average price multiplied by quantity can differ by a unit. */
  gross: string;
  fee: string;
  source: SourceRef;
}
/** Slice income/cost evidence only. Never repeat a fee already present in a trade allocation. */
export interface CashAdjustment {
  id: string;
  date: string;
  accountId: string;
  currency: Currency;
  amount: string;
  kind: "DIVIDEND" | "INTEREST" | "FEE" | "TAX";
  source: SourceRef;
}
export interface ActualPerformanceSeries {
  id: typeof ACTUAL_PERFORMANCE_SERIES;
  startDate: typeof ACTUAL_PERFORMANCE_START;
  baseline: PerformanceBaseline | null;
  observations: PerformanceObservation[];
}
export interface ActualPerformancePoint {
  date: string;
  nav: string | null;
  netExternalFlow: string | null;
  pnl: string | null;
  dailyReturnPercent: string | null;
  cumulativeReturnPercent: string | null;
  issues: string[];
}
export interface ActualPerformanceView {
  id: string;
  startDate: string;
  status: "PENDING_BASELINE" | "WAITING_OBSERVATION" | "RECORDED" | "INCOMPLETE";
  baseCurrency: Currency | null;
  baselineNav: string | null;
  latestNav: string | null;
  totalPnl: string | null;
  returnPercent: string | null;
  points: ActualPerformancePoint[];
  issues: string[];
}
export function pendingActualPerformance(): ActualPerformanceSeries {
  return {
    id: ACTUAL_PERFORMANCE_SERIES,
    startDate: ACTUAL_PERFORMANCE_START,
    baseline: null,
    observations: [],
  };
}
const key = (a: { accountId: string; currency: Currency }) =>
  JSON.stringify([a.accountId, a.currency]);
const stamp = (s: string) =>
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
    s,
  ) &&
  validDate(s.slice(0, 10)) &&
  Number.isFinite(Date.parse(s));
function evidence(source: SourceRef) {
  validateSource(source);
  if (!["notion", "broker"].includes(source.system))
    throw new Error("Reconciled Notion or broker evidence required");
}
function currency(value: string): asserts value is Currency {
  if (!["KRW", "USD"].includes(value)) throw new Error("Invalid performance currency");
}
function rate(
  fx: FxMark[],
  from: Currency,
  to: Currency,
  date: string,
  knownAt: string,
): bigint | null {
  if (from === to) return decimal("1");
  const rates = fx.filter(
    (r) =>
      r.base === from &&
      r.quote === to &&
      r.date === date &&
      r.verified === true &&
      r.source.trim() &&
      !!r.availableAt &&
      stamp(r.availableAt) &&
      Date.parse(r.availableAt) <= Date.parse(knownAt),
  );
  const values = new Set(rates.map((r) => format(decimal(r.rate))));
  if (values.size !== 1 || !rates.length || decimal(rates[0]!.rate) <= 0n) return null;
  return decimal(rates[0]!.rate);
}
function snapshotValue(
  snapshot: PerformanceSnapshot,
  base: Currency,
  scope?: string[],
  opening = false,
) {
  if (!validDate(snapshot.date) || !stamp(snapshot.recordedAt))
    throw new Error("Invalid valuation date or recording time");
  const cutoffDate = new Date(snapshot.recordedAt).toISOString().slice(0, 10);
  if (!opening && snapshot.date > cutoffDate)
    throw new Error("Valuation date is later than its recording cutoff");
  evidence(snapshot.source);
  currency(base);
  const issues = new Set<string>();
  if (snapshot.complete !== true) issues.add("valuation_not_reconciled");
  if (!snapshot.accounts.length) issues.add("account_scope_missing");
  const keys = snapshot.accounts.map(key);
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate account/currency cash pool");
  if (scope && canonicalJson([...scope].sort()) !== canonicalJson([...keys].sort()))
    issues.add("account_scope_changed");
  let nav = 0n;
  for (const account of snapshot.accounts) {
    currency(account.currency);
    if (!account.accountId || account.accountId.startsWith("UNASSIGNED:"))
      issues.add("account_mapping_unverified");
    const expectedPriceDate = snapshot.requiredPriceDates?.[account.currency] ?? snapshot.date;
    if (
      !validDate(expectedPriceDate) ||
      expectedPriceDate > snapshot.date ||
      (account.positions.length > 0 && expectedPriceDate > cutoffDate)
    )
      throw new Error("Invalid reviewed market price date or recording cutoff");
    if (
      opening &&
      account.positions.length > 0 &&
      (!snapshot.requiredPriceDates?.[account.currency] || expectedPriceDate >= snapshot.date)
    )
      throw new Error("Explicit pre-start market price date required for opening holdings");
    for (const issue of account.issues) {
      const reviewedPriorClose =
        issue === "stale_price" &&
        !!snapshot.requiredPriceDates?.[account.currency] &&
        account.positions.every((p) => p.priceDate !== null && p.priceDate === expectedPriceDate);
      if (!reviewedPriorClose) issues.add(issue);
    }
    if (account.cash === null || account.unsettledCash === null || account.equity === null) {
      issues.add("account_value_missing");
      continue;
    }
    let equity = decimal(account.cash) + decimal(account.unsettledCash);
    const securities = new Set<string>();
    for (const p of account.positions) {
      if (!p.securityId || securities.has(p.securityId))
        throw new Error("Duplicate or missing position identity");
      securities.add(p.securityId);
      if (p.quantity === null || p.marketValue === null || !p.priceDate) {
        issues.add("position_value_missing");
        continue;
      }
      if (
        decimal(p.quantity) < 0n ||
        decimal(p.marketValue) < 0n ||
        !validDate(p.priceDate) ||
        (opening ? p.priceDate >= snapshot.date : p.priceDate > snapshot.date) ||
        p.priceDate > cutoffDate ||
        (decimal(p.quantity) === 0n && decimal(p.marketValue) !== 0n)
      )
        throw new Error("Invalid or future position valuation");
      if (p.priceDate !== expectedPriceDate) issues.add("stale_price");
      equity += decimal(p.marketValue);
    }
    if (equity !== decimal(account.equity)) issues.add("account_equity_mismatch");
    const fxDate = snapshot.requiredFxDate ?? snapshot.date;
    if (
      opening &&
      account.currency !== base &&
      (!snapshot.requiredFxDate || fxDate >= snapshot.date)
    )
      throw new Error("Explicit pre-start opening FX date required");
    if (
      !validDate(fxDate) ||
      fxDate > snapshot.date ||
      (account.currency !== base && fxDate > cutoffDate) ||
      (!opening && fxDate !== snapshot.date)
    )
      throw new Error("Invalid reviewed valuation FX date");
    const conversion = rate(snapshot.fx, account.currency, base, fxDate, snapshot.recordedAt);
    if (conversion === null) issues.add("verified_valuation_fx_missing");
    else nav += multiply(equity, conversion);
  }
  return { nav: issues.size ? null : nav, issues: [...issues].sort(), scope: keys };
}
function validateIdentity(series: ActualPerformanceSeries) {
  if (
    series.id !== ACTUAL_PERFORMANCE_SERIES ||
    series.startDate !== ACTUAL_PERFORMANCE_START ||
    !Array.isArray(series.observations)
  )
    throw new Error("Actual performance series identity mismatch");
  if (!series.baseline && series.observations.length)
    throw new Error("Observations require an approved baseline");
}
/** Calendar dates of reconciliation evidence use the Korean operating timezone. */
export function reconciliationDate(timestamp: string): string {
  const value = Date.parse(timestamp);
  return Number.isFinite(value)
    ? new Date(value + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : "";
}
export function confirmActualPerformanceBaseline(
  series: ActualPerformanceSeries,
  baseline: PerformanceBaseline,
): ActualPerformanceSeries {
  validateIdentity(series);
  if (series.baseline) {
    if (canonicalJson(series.baseline) === canonicalJson(baseline)) return structuredClone(series);
    throw new Error("Confirmed baseline is immutable; never reset holdings or overwrite history");
  }
  if (
    baseline.valuation.date !== series.startDate ||
    !stamp(baseline.confirmedAt) ||
    Date.parse(baseline.confirmedAt) < Date.parse(baseline.valuation.recordedAt) ||
    !validDate(baseline.betaArchive.asOfDate) ||
    baseline.betaArchive.asOfDate >= series.startDate ||
    baseline.betaArchive.asOfDate > reconciliationDate(baseline.confirmedAt) ||
    baseline.betaArchive.asOfDate > reconciliationDate(baseline.valuation.recordedAt)
  )
    throw new Error("Invalid performance start or beta boundary");
  evidence(baseline.betaArchive.source);
  for (const revision of [baseline.sourceRevisions.domestic, baseline.sourceRevisions.us])
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new Error("Audited source revisions required");
  if (
    baseline.scope !== "POST_START_ALLOCATED_CAPITAL" ||
    baseline.scopeConfirmed !== true ||
    baseline.pricePolicy !== "EXPLICIT_DATED_MARKS_BEFORE_START" ||
    !baseline.accountScope.length ||
    new Set(baseline.accountScope.map(key)).size !== baseline.accountScope.length
  )
    throw new Error("Explicit complete account scope and opening price policy required");
  for (const account of baseline.valuation.accounts) {
    if (
      account.positions.length !== 0 ||
      account.cash === null ||
      decimal(account.cash) < 0n ||
      account.unsettledCash === null ||
      decimal(account.unsettledCash) !== 0n
    )
      throw new Error(
        "Allocated opening requires nonnegative cash only; legacy positions and unsettled cash are excluded",
      );
  }
  const valued = snapshotValue(
    baseline.valuation,
    baseline.baseCurrency,
    baseline.accountScope.map(key),
    true,
  );
  if (valued.nav === null || valued.nav <= 0n)
    throw new Error(`Complete positive opening NAV required: ${valued.issues.join(", ")}`);
  return { ...structuredClone(series), baseline: structuredClone(baseline) };
}
export function appendActualPerformanceObservation(
  series: ActualPerformanceSeries,
  observation: PerformanceObservation,
): ActualPerformanceSeries {
  validateIdentity(series);
  if (!series.baseline)
    throw new Error("Confirm the reconciled baseline before recording performance");
  const saved = series.observations.find((p) => p.valuation.date === observation.valuation.date);
  if (saved) {
    if (canonicalJson(saved) === canonicalJson(observation)) return structuredClone(series);
    throw new Error("Recorded performance date is immutable; conflicting retry rejected");
  }
  const previous = series.observations.at(-1)?.valuation.date ?? series.startDate;
  if (
    (!series.observations.length && observation.valuation.date !== series.startDate) ||
    observation.previousDate !== previous ||
    !validDate(observation.valuation.date) ||
    observation.valuation.date < series.startDate ||
    (series.observations.length > 0 && observation.valuation.date <= previous)
  )
    throw new Error("Performance observations must append in order with their exact predecessor");
  const next = {
    ...structuredClone(series),
    observations: [...structuredClone(series.observations), structuredClone(observation)],
  };
  actualPerformanceView(next); // Validate all provenance, money and flow identities before persistence.
  return next;
}
export function actualPerformanceView(
  input?: ActualPerformanceSeries | null,
): ActualPerformanceView {
  const series = input ?? pendingActualPerformance();
  validateIdentity(series);
  const empty: ActualPerformanceView = {
    id: series.id,
    startDate: series.startDate,
    status: "PENDING_BASELINE",
    baseCurrency: null,
    baselineNav: null,
    latestNav: null,
    totalPnl: null,
    returnPercent: null,
    points: [],
    issues: ["opening_balance_reconciliation_pending"],
  };
  if (!series.baseline) return empty;
  const baseline = series.baseline;
  // Revalidate stored snapshots, not just inputs to the writer.
  confirmActualPerformanceBaseline(pendingActualPerformance(), baseline);
  const initial = snapshotValue(
    baseline.valuation,
    baseline.baseCurrency,
    baseline.accountScope.map(key),
    true,
  );
  let previousDate: string = series.startDate,
    previousNav = initial.nav,
    pnlTotal: bigint | null = 0n,
    growth: bigint | null = decimal("1");
  const points: ActualPerformancePoint[] = [],
    flowIds = new Set<string>(),
    allocationIds = new Set<string>(),
    adjustmentIds = new Set<string>();
  const allocatedQuantities = new Map<string, bigint>();
  const allocatedCash = new Map<string, bigint | null>(
    baseline.valuation.accounts.map((account) => [key(account), decimal(account.cash!)]),
  );
  const positionKey = (account: { accountId: string; currency: Currency }, securityId: string) =>
    JSON.stringify([account.accountId, account.currency, securityId]);
  const changeCash = (pool: string, amount: bigint | null) => {
    const previous = allocatedCash.get(pool);
    allocatedCash.set(
      pool,
      previous === null || previous === undefined || amount === null ? null : previous + amount,
    );
  };
  for (const observation of series.observations) {
    if (
      (!points.length && observation.valuation.date !== series.startDate) ||
      observation.previousDate !== previousDate ||
      observation.valuation.date < previousDate ||
      (points.length > 0 && observation.valuation.date === previousDate)
    )
      throw new Error("Invalid stored performance chain");
    const valued = snapshotValue(observation.valuation, baseline.baseCurrency, initial.scope);
    const issues = new Set(valued.issues);
    if (observation.intervalComplete !== true) issues.add("observation_interval_incomplete");
    if (observation.flowsComplete !== true) issues.add("external_flow_coverage_incomplete");
    if (observation.allocationConfirmed !== true) issues.add("allocation_coverage_unconfirmed");
    if (!Array.isArray(observation.tradeAllocations)) issues.add("trade_allocations_missing");
    if (!Array.isArray(observation.cashAdjustments)) issues.add("cash_adjustments_missing");
    let beginning = 0n,
      end = 0n,
      net = 0n;
    for (const flow of observation.flows) {
      evidence(flow.source);
      if (!flow.id || flowIds.has(flow.id)) throw new Error("Duplicate performance flow");
      flowIds.add(flow.id);
      if (
        flow.date !== observation.valuation.date ||
        !["DEPOSIT", "WITHDRAWAL", "TRANSFER"].includes(flow.kind) ||
        !["BEGINNING", "END", "UNKNOWN"].includes(flow.timing) ||
        !flow.legs.length
      )
        throw new Error("Invalid dated performance flow");
      let amount = 0n;
      for (const leg of flow.legs) {
        if (!initial.scope.includes(key(leg)))
          throw new Error("Flow account is outside the confirmed series scope");
        if (leg.amount === null) {
          issues.add("external_flow_amount_missing");
          changeCash(key(leg), null);
          continue;
        }
        const value = decimal(leg.amount),
          conversion = rate(
            flow.fx,
            leg.currency,
            baseline.baseCurrency,
            flow.date,
            observation.valuation.recordedAt,
          );
        changeCash(key(leg), value);
        if ((flow.kind === "DEPOSIT" && value <= 0n) || (flow.kind === "WITHDRAWAL" && value >= 0n))
          throw new Error("External flow direction mismatch");
        if (conversion === null) issues.add("verified_flow_fx_missing");
        else amount += multiply(value, conversion);
      }
      if (flow.kind === "TRANSFER") {
        if (new Set(flow.legs.map(key)).size < 2 || flow.legs.length < 2 || amount !== 0n)
          throw new Error(
            "Internal transfers require balanced in-scope legs; never count allocation as return",
          );
        continue;
      }
      net += amount;
      if (flow.timing === "BEGINNING") beginning += amount;
      else if (flow.timing === "END") end += amount;
      else issues.add("intraday_flow_timing_unverified");
    }
    for (const trade of [...(observation.tradeAllocations ?? [])].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.order - b.order ||
        a.sourceSystem.localeCompare(b.sourceSystem) ||
        a.executionId.localeCompare(b.executionId),
    )) {
      evidence(trade.source);
      if (
        !["portfolio_ledgers", "us_actual_portfolio_ledgers"].includes(trade.sourceSystem) ||
        !trade.executionId ||
        !trade.securityId ||
        !Number.isSafeInteger(trade.order) ||
        trade.order < 0 ||
        !["BUY", "SELL"].includes(trade.side) ||
        trade.date !== observation.valuation.date ||
        trade.date < series.startDate
      )
        throw new Error("Invalid post-start source execution allocation evidence");
      currency(trade.currency);
      if (!initial.scope.includes(key(trade)))
        throw new Error("Trade allocation account is outside the confirmed scope");
      const identity = JSON.stringify([trade.sourceSystem, trade.executionId]);
      if (allocationIds.has(identity))
        throw new Error("Source execution allocation cannot be reused");
      allocationIds.add(identity);
      const quantity = decimal(trade.quantity),
        price = decimal(trade.price),
        gross = decimal(trade.gross),
        fee = decimal(trade.fee);
      if (quantity <= 0n || price <= 0n || gross <= 0n || fee < 0n)
        throw new Error("Invalid allocated trade quantity, price, gross or fee");
      const security = positionKey(trade, trade.securityId),
        previous = allocatedQuantities.get(security) ?? 0n;
      if (trade.side === "SELL" && quantity > previous)
        throw new Error(
          "Allocated sell exceeds new-slice holdings; legacy holdings cannot cover it",
        );
      const next = previous + (trade.side === "BUY" ? quantity : -quantity);
      if (next === 0n) allocatedQuantities.delete(security);
      else allocatedQuantities.set(security, next);
      changeCash(key(trade), (trade.side === "BUY" ? -gross : gross) - fee);
    }
    for (const adjustment of observation.cashAdjustments ?? []) {
      evidence(adjustment.source);
      if (!adjustment.id || adjustmentIds.has(adjustment.id))
        throw new Error("Duplicate or missing cash adjustment identity");
      adjustmentIds.add(adjustment.id);
      if (
        adjustment.date !== observation.valuation.date ||
        adjustment.date < series.startDate ||
        !["DIVIDEND", "INTEREST", "FEE", "TAX"].includes(adjustment.kind)
      )
        throw new Error("Invalid dated allocated cash adjustment");
      currency(adjustment.currency);
      if (!initial.scope.includes(key(adjustment)))
        throw new Error("Cash adjustment account is outside the confirmed scope");
      const amount = decimal(adjustment.amount);
      if (["FEE", "TAX"].includes(adjustment.kind) ? amount >= 0n : amount <= 0n)
        throw new Error("Cash adjustment direction mismatch");
      changeCash(key(adjustment), amount);
    }
    const observedQuantities = new Map<string, bigint>();
    for (const account of observation.valuation.accounts) {
      for (const position of account.positions) {
        if (position.quantity === null) {
          issues.add("allocated_position_quantity_missing");
          continue;
        }
        observedQuantities.set(
          positionKey(account, position.securityId),
          decimal(position.quantity),
        );
      }
      const expectedCash = allocatedCash.get(key(account));
      // This is an end-of-observation net-cash limit. Dated facts do not establish
      // intraday funding order, and never authorize borrowing unallocated legacy cash.
      if (
        account.cash !== null &&
        account.unsettledCash !== null &&
        decimal(account.cash) + decimal(account.unsettledCash) < 0n
      )
        issues.add("allocated_cash_overdrawn");
      if (
        expectedCash === null ||
        expectedCash === undefined ||
        account.cash === null ||
        account.unsettledCash === null
      )
        issues.add("allocated_cash_unknown");
      else if (expectedCash !== decimal(account.cash) + decimal(account.unsettledCash))
        issues.add("allocated_cash_mismatch");
    }
    if (
      observedQuantities.size !== allocatedQuantities.size ||
      [...allocatedQuantities].some(
        ([identity, quantity]) => observedQuantities.get(identity) !== quantity,
      )
    )
      issues.add("allocated_position_mismatch");
    const allocationIssues = [...issues].some(
      (issue) =>
        issue.startsWith("allocated_") ||
        issue === "allocation_coverage_unconfirmed" ||
        issue === "trade_allocations_missing" ||
        issue === "cash_adjustments_missing",
    );
    const nav = allocationIssues ? null : valued.nav;
    const moneyIssues = [...issues].filter((i) => i !== "intraday_flow_timing_unverified");
    const pnl =
      !moneyIssues.length && nav !== null && previousNav !== null ? nav - previousNav - net : null;
    pnlTotal = pnlTotal !== null && pnl !== null ? pnlTotal + pnl : null;
    const denominator = previousNav !== null ? previousNav + beginning : null;
    let factor: bigint | null = null;
    if (!issues.size && nav !== null && denominator !== null && denominator > 0n && nav - end >= 0n)
      factor = divide(nav - end, denominator);
    else if (!issues.size) issues.add("return_denominator_unavailable");
    growth = growth !== null && factor !== null ? multiply(growth, factor) : null;
    points.push({
      date: observation.valuation.date,
      nav: nav === null ? null : format(nav),
      netExternalFlow: moneyIssues.length ? null : format(net),
      pnl: pnl === null ? null : format(pnl),
      dailyReturnPercent: factor === null ? null : format((factor - decimal("1")) * 100n),
      cumulativeReturnPercent: growth === null ? null : format((growth - decimal("1")) * 100n),
      issues: [...issues].sort(),
    });
    previousDate = observation.valuation.date;
    previousNav = nav;
  }
  const latest = points.at(-1);
  return {
    ...empty,
    status: !latest
      ? "WAITING_OBSERVATION"
      : points.some((p) => p.issues.length)
        ? "INCOMPLETE"
        : "RECORDED",
    baseCurrency: baseline.baseCurrency,
    baselineNav: format(initial.nav!),
    latestNav: latest?.nav ?? null,
    totalPnl: latest && pnlTotal !== null ? format(pnlTotal) : null,
    returnPercent: latest?.cumulativeReturnPercent ?? null,
    points,
    issues: [...new Set(points.flatMap((p) => p.issues))],
  };
}
