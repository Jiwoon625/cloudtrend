import type { ActualExecution, Quote } from "./portfolioLedgers";
import { ACTUAL_PERFORMANCE_SERIES, ACTUAL_PERFORMANCE_START } from "./ledger/actualPerformance";
import { validDate } from "./ledger/date";
import {
  decimal,
  divide,
  format,
  fromLegacyNumber,
  multiply,
  representedLegacyNumber,
} from "./ledger/decimal";

export type NewActualAsset = "KR" | "US" | "ETF";
export type NewActualCurrency = "KRW" | "USD";
export type NewActualExecution = ActualExecution<"KOSPI" | "KOSDAQ" | "ETF" | "US">;

/** A reviewed slice of one canonical fill. Never infer this from its date or ticker. */
export interface NewActualAssignment {
  executionId: string;
  quantity: number;
  gross: number;
  fee: number;
  brokerReference: string;
}
export interface NewActualCashEvent {
  id: string;
  date: string;
  kind: "DEPOSIT" | "WITHDRAWAL" | "DIVIDEND" | "INTEREST" | "FEE" | "TAX";
  amount: number;
  reference: string;
  voided?: boolean;
}
export interface NewActualAuditSnapshot {
  execution?: NewActualExecution | undefined;
  assignment?: NewActualAssignment | undefined;
  cashEvent?: NewActualCashEvent | undefined;
}
export interface NewActualAudit {
  requestId: string;
  fingerprint: string;
  action: string;
  recordedAt: string;
  targetId: string;
  reason?: string;
  before?: NewActualAuditSnapshot | undefined;
  after?: NewActualAuditSnapshot | undefined;
}
/** One owner currency pool: domestic KR and ETF share KRW; US has its own USD pool. */
export interface NewActualMetadata {
  version: 1;
  seriesId: typeof ACTUAL_PERFORMANCE_SERIES;
  assignments: Record<string, NewActualAssignment>;
  cashEvents: NewActualCashEvent[];
  audit: NewActualAudit[];
}
export interface NewActualPosition {
  symbol: string;
  name: string;
  market: NewActualExecution["market"];
  asset: NewActualAsset;
  quantity: string;
  cost: string;
  averagePrice: string;
  currentPrice: string | null;
  priceDate: string | null;
  marketValue: string | null;
  unrealizedPnl: string | null;
}
export interface NewActualTrade {
  execution: NewActualExecution;
  allocation: NewActualAssignment;
  realizedPnl: string | null;
  /** Mixed provenance is permanent, even after a later allocation-only correction. */
  rawProtected?: boolean;
}
export interface NewActualPool {
  currency: NewActualCurrency;
  fundingStatus: "PENDING" | "CONFIRMED" | "INCOMPLETE";
  netContributions: string | null;
  cash: string | null;
  marketValue: string | null;
  nav: string | null;
  realizedPnl: string;
  unrealizedPnl: string | null;
  totalPnl: string | null;
  returnPercent: string | null;
  issues: string[];
  positions: NewActualPosition[];
  trades: NewActualTrade[];
  cashEvents: NewActualCashEvent[];
}

export function emptyNewActualMetadata(): NewActualMetadata {
  return {
    version: 1,
    seriesId: ACTUAL_PERFORMANCE_SERIES,
    assignments: {},
    cashEvents: [],
    audit: [],
  };
}

export function hasMixedActualProvenance(
  metadata: NewActualMetadata,
  execution: NewActualExecution,
): boolean {
  const assignment = metadata.assignments[execution.id];
  return (
    (assignment !== undefined && assignment.quantity < execution.shares) ||
    metadata.audit.some(
      (a) =>
        a.targetId === execution.id &&
        [a.before, a.after].some(
          (snapshot) =>
            snapshot?.execution !== undefined &&
            snapshot.assignment !== undefined &&
            snapshot.assignment.quantity < snapshot.execution.shares,
        ),
    )
  );
}

export function newActualAsset(market: NewActualExecution["market"]): NewActualAsset {
  if (market === "US") return "US";
  if (market === "ETF") return "ETF";
  if (market === "KOSPI" || market === "KOSDAQ") return "KR";
  throw new Error("Invalid new actual execution market");
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const exactNumber = (value: number): bigint => decimal(fromLegacyNumber(value));
const legacyNumber = (value: number): bigint => decimal(representedLegacyNumber(value));
const timestamp = (value: string) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
    value,
  ) &&
  validDate(value.slice(0, 10)) &&
  Number.isFinite(Date.parse(value));

function validateAssignment(assignment: NewActualAssignment) {
  if (!record(assignment) || !text(assignment.executionId) || !text(assignment.brokerReference))
    throw new Error("Explicit execution identity and broker reference required");
  if (
    exactNumber(assignment.quantity) <= 0n ||
    exactNumber(assignment.gross) <= 0n ||
    exactNumber(assignment.fee) < 0n
  )
    throw new Error("Invalid new actual allocation quantity, gross or fee");
}

function validateCashEvent(event: NewActualCashEvent) {
  if (
    !record(event) ||
    !text(event.id) ||
    !text(event.reference) ||
    !validDate(event.date) ||
    event.date < ACTUAL_PERFORMANCE_START ||
    !["DEPOSIT", "WITHDRAWAL", "DIVIDEND", "INTEREST", "FEE", "TAX"].includes(event.kind) ||
    (event.voided !== undefined && typeof event.voided !== "boolean")
  )
    throw new Error("Invalid dated new actual cash event or reference");
  if (exactNumber(event.amount) <= 0n)
    throw new Error("Cash event amount must be strictly positive");
}

/** Validate persisted metadata as well as writes; malformed sidecars never import old capital. */
export function validateNewActualMetadata(metadata: NewActualMetadata): void {
  if (
    !record(metadata) ||
    metadata.version !== 1 ||
    metadata.seriesId !== ACTUAL_PERFORMANCE_SERIES ||
    !record(metadata.assignments) ||
    !Array.isArray(metadata.cashEvents) ||
    !Array.isArray(metadata.audit)
  )
    throw new Error("New actual performance metadata identity mismatch");
  const references = new Set<string>();
  for (const [id, assignment] of Object.entries(metadata.assignments)) {
    validateAssignment(assignment);
    if (id !== assignment.executionId)
      throw new Error("New actual assignment execution identity mismatch");
    const reference = assignment.brokerReference.trim();
    if (references.has(reference)) throw new Error("Duplicate active allocation broker reference");
    references.add(reference);
  }
  const cashIds = new Set<string>(),
    cashReferences = new Set<string>();
  for (const event of metadata.cashEvents) {
    validateCashEvent(event);
    if (cashIds.has(event.id)) throw new Error("Duplicate new actual cash event identity");
    cashIds.add(event.id);
    if (!event.voided) {
      const reference = event.reference.trim();
      if (cashReferences.has(reference)) throw new Error("Duplicate active cash event reference");
      cashReferences.add(reference);
    }
  }
  const requestIds = new Set<string>();
  for (const audit of metadata.audit) {
    if (
      !record(audit) ||
      !text(audit.requestId) ||
      !text(audit.fingerprint) ||
      !text(audit.action) ||
      !text(audit.targetId) ||
      !timestamp(audit.recordedAt) ||
      (audit.reason !== undefined && !text(audit.reason)) ||
      requestIds.has(audit.requestId)
    )
      throw new Error("Invalid or duplicate new actual audit identity");
    requestIds.add(audit.requestId);
    for (const value of [audit.before, audit.after]) {
      if (value === undefined) continue;
      if (!record(value)) throw new Error("Invalid new actual audit snapshot");
      const snapshot = value as NewActualAuditSnapshot;
      if (snapshot.assignment !== undefined) validateAssignment(snapshot.assignment);
      if (snapshot.cashEvent !== undefined) validateCashEvent(snapshot.cashEvent);
      if (
        snapshot.execution !== undefined &&
        (!record(snapshot.execution) || !text(snapshot.execution.id))
      )
        throw new Error("Invalid new actual audit execution snapshot");
    }
  }
}

interface Holding {
  execution: NewActualExecution;
  quantity: bigint;
  cost: bigint;
  lastFillDate: string;
}

/** Pure, native-currency, allocated-slice projection over the complete canonical journal. */
export function projectNewActualPool(input: {
  currency: NewActualCurrency;
  executions: NewActualExecution[];
  metadata?: NewActualMetadata | null | undefined;
  quotes: Record<string, Quote>;
  valuationDate: string | null;
  today: string;
}): NewActualPool {
  const { currency, executions, quotes, valuationDate, today } = input;
  if (!["KRW", "USD"].includes(currency) || !validDate(today) || !Array.isArray(executions))
    throw new Error("Invalid new actual pool currency or observation date");
  if (valuationDate !== null && !validDate(valuationDate))
    throw new Error("Invalid valuation date");
  const metadata = input.metadata ?? emptyNewActualMetadata();
  validateNewActualMetadata(metadata);
  const canonical = new Map<string, NewActualExecution>();
  for (const execution of executions) {
    if (!record(execution) || !text(execution.id) || canonical.has(execution.id))
      throw new Error("Duplicate or missing canonical execution identity");
    canonical.set(execution.id, execution);
  }
  const assigned = Object.values(metadata.assignments)
    .map((allocation) => {
      const execution = canonical.get(allocation.executionId);
      if (!execution) throw new Error("Orphan new actual execution assignment");
      const asset = newActualAsset(execution.market);
      if ((asset === "US" ? "USD" : "KRW") !== currency)
        throw new Error("Assigned execution is outside the owner currency pool");
      if (
        !text(execution.symbol) ||
        !text(execution.name) ||
        !validDate(execution.date) ||
        execution.date < ACTUAL_PERFORMANCE_START ||
        execution.date > today ||
        !["BUY", "SELL"].includes(execution.side) ||
        !Number.isSafeInteger(execution.order) ||
        execution.order < 0 ||
        legacyNumber(execution.price) <= 0n ||
        exactNumber(execution.shares) <= 0n ||
        legacyNumber(execution.fee) < 0n
      )
        throw new Error("Invalid or pre-start/future assigned canonical execution");
      const quantity = exactNumber(allocation.quantity),
        fullQuantity = exactNumber(execution.shares),
        gross = exactNumber(allocation.gross),
        fullGross = legacyNumber(execution.price * execution.shares),
        fee = exactNumber(allocation.fee),
        fullFee = legacyNumber(execution.fee);
      if (quantity > fullQuantity || gross > fullGross || fee > fullFee)
        throw new Error("New actual allocation exceeds its canonical execution");
      if (quantity === fullQuantity && (gross !== fullGross || fee !== fullFee))
        throw new Error("Full execution allocation requires exact canonical gross and all fees");
      return { execution, allocation, quantity, gross, fee };
    })
    .sort(
      (a, b) =>
        a.execution.date.localeCompare(b.execution.date) ||
        a.execution.order - b.execution.order ||
        a.execution.id.localeCompare(b.execution.id),
    );

  const issues = new Set<string>();
  const holdings = new Map<string, Holding>();
  const dailyCash = new Map<string, bigint>();
  const cashChange = (date: string, change: bigint) =>
    dailyCash.set(date, (dailyCash.get(date) ?? 0n) + change);
  let realized = 0n;
  const trades: NewActualTrade[] = [];
  for (const { execution, allocation, quantity, gross, fee } of assigned) {
    const key = `${execution.market}:${execution.symbol}`;
    const holding = holdings.get(key);
    let pnl: bigint | null = null;
    if (execution.side === "BUY") {
      holdings.set(key, {
        execution,
        quantity: (holding?.quantity ?? 0n) + quantity,
        cost: (holding?.cost ?? 0n) + gross + fee,
        lastFillDate: execution.date,
      });
      cashChange(execution.date, -gross - fee);
    } else {
      if (!holding || quantity > holding.quantity)
        throw new Error(
          "Allocated sell exceeds new-slice holdings; legacy holdings cannot cover it",
        );
      // One exact 8dp rational operation. A full exit consumes every residual cost unit.
      const soldCost =
        quantity === holding.quantity ? holding.cost : (holding.cost * quantity) / holding.quantity;
      pnl = gross - fee - soldCost;
      realized += pnl;
      if (quantity === holding.quantity) holdings.delete(key);
      else
        holdings.set(key, {
          ...holding,
          quantity: holding.quantity - quantity,
          cost: holding.cost - soldCost,
          lastFillDate: execution.date,
        });
      cashChange(execution.date, gross - fee);
    }
    trades.push({
      execution: structuredClone(execution),
      rawProtected: hasMixedActualProvenance(metadata, execution),
      allocation: structuredClone(allocation),
      realizedPnl: pnl === null ? null : format(pnl),
    });
  }

  const cashEvents = [...metadata.cashEvents].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  for (const event of cashEvents) {
    if (event.date > today) throw new Error("Future new actual cash event is not allowed");
  }
  const activeCash = cashEvents.filter((event) => !event.voided);
  const externalFlows = activeCash.filter(
    (event) => event.kind === "DEPOSIT" || event.kind === "WITHDRAWAL",
  );
  const funded = externalFlows.some((event) => event.kind === "DEPOSIT");
  let netContributions = 0n;
  for (const event of activeCash) {
    const amount = exactNumber(event.amount);
    const incoming = ["DEPOSIT", "DIVIDEND", "INTEREST"].includes(event.kind);
    cashChange(event.date, incoming ? amount : -amount);
    if (event.kind === "DEPOSIT") netContributions += amount;
    if (event.kind === "WITHDRAWAL") netContributions -= amount;
  }
  let cash = 0n,
    shortfall = false;
  for (const [, change] of [...dailyCash.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    cash += change;
    // Day-level records establish closing cash only, not intraday buying power or settlement.
    if (cash < 0n) shortfall = true;
  }
  if (!funded) issues.add("funding_pending");
  else if (shortfall) issues.add("funding_shortfall");

  let marketValue = 0n,
    unrealized = 0n,
    allMarked = true;
  const activityDates = [
    ...assigned.map(({ execution }) => execution.date),
    ...activeCash.map((event) => event.date),
  ].sort();
  // A prior-session mark cannot close a later cash/trade snapshot, even for a
  // different security. Keep dated individual marks, but suppress combined totals.
  if (holdings.size > 0 && valuationDate !== null && activityDates.at(-1)! > valuationDate) {
    allMarked = false;
    issues.add("stale_price");
  }
  const positions: NewActualPosition[] = [];
  for (const [key, holding] of [...holdings.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const quote = quotes[key];
    let price: bigint | null = null;
    if (valuationDate === null) issues.add("valuation_date_missing");
    else if (valuationDate > today) issues.add("future_valuation_date");
    else if (!quote) issues.add("missing_price");
    else if (!validDate(quote.date)) issues.add("invalid_price");
    else if (quote.date > today || quote.date > valuationDate) issues.add("future_price");
    else if (quote.date < holding.lastFillDate) issues.add("price_before_last_fill");
    else if (quote.date !== valuationDate) issues.add("stale_price");
    else {
      try {
        const value = legacyNumber(quote.price);
        if (value > 0n) price = value;
        else issues.add("invalid_price");
      } catch {
        issues.add("invalid_price");
      }
    }
    const value = price === null ? null : multiply(holding.quantity, price);
    const pnl = value === null ? null : value - holding.cost;
    if (value === null || pnl === null) allMarked = false;
    else {
      marketValue += value;
      unrealized += pnl;
    }
    positions.push({
      symbol: holding.execution.symbol,
      name: holding.execution.name,
      market: holding.execution.market,
      asset: newActualAsset(holding.execution.market),
      quantity: format(holding.quantity),
      cost: format(holding.cost),
      averagePrice: format(divide(holding.cost, holding.quantity)),
      currentPrice: price === null ? null : format(price),
      priceDate: price === null ? null : quote!.date,
      marketValue: value === null ? null : format(value),
      unrealizedPnl: pnl === null ? null : format(pnl),
    });
  }
  const knownCash = funded && !shortfall;
  const nav = knownCash && allMarked ? cash + marketValue : null;
  const totalPnl = nav === null ? null : nav - netContributions;
  const firstActivityDate = activityDates[0];
  const initialDeposit =
    externalFlows.length === 1 &&
    externalFlows[0]!.kind === "DEPOSIT" &&
    externalFlows[0]!.date === firstActivityDate
      ? externalFlows[0]!
      : null;
  if (funded && initialDeposit === null) issues.add("flow_adjusted_return_pending");
  return {
    currency,
    fundingStatus: !funded ? "PENDING" : shortfall ? "INCOMPLETE" : "CONFIRMED",
    netContributions: funded ? format(netContributions) : null,
    cash: knownCash ? format(cash) : null,
    marketValue: allMarked ? format(marketValue) : null,
    nav: nav === null ? null : format(nav),
    realizedPnl: format(realized),
    unrealizedPnl: allMarked ? format(unrealized) : null,
    totalPnl: totalPnl === null ? null : format(totalPnl),
    returnPercent:
      totalPnl !== null && initialDeposit !== null
        ? format(divide(totalPnl * 100n, exactNumber(initialDeposit.amount)))
        : null,
    issues: [...issues].sort(),
    positions,
    trades,
    cashEvents: structuredClone(cashEvents),
  };
}
