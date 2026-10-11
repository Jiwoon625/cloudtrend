import { etfEntryWeight } from "./engine/etfStrategy";
import {
  decimal,
  divide,
  exactNotionalFee,
  format,
  integerBudgetQuantity,
  multiply,
} from "./ledger/decimal";
import { validDate } from "./ledger/date";
import { hashSeriesValue, type SeriesHash } from "./ledger/modelSeries";

/** A new prospective contract. Never an alias of the eight adopted books or frozen CM research. */
export const INTEGRATED_ALLOCATION_VERSION = "integrated-allocation-shadow-2026-10-12-v1" as const;
export const INTEGRATED_ALLOCATION_START = "2026-10-12" as const;
export const INTEGRATED_ALLOCATION_FX = "1339.2" as const;
export const INTEGRATED_O1_INITIAL_REFERENCE = Object.freeze({
  reportSha256: "dd338780b0507053640a941cebab72e2634711ce9473f85a65aceb5f7d83821b",
  targetAsOf: "2026-09-11",
  sessionWindow: { first: "2026-08-14", last: "2026-09-11", count: 20 },
  positiveDemandCounts: { K: 5, E: 3, U: 14 },
  fallback: false,
  historicalResearchOnly: true,
  wasExecutedMonthlyReview: false,
} as const);
export const ALLOCATION_MARKETS = ["K", "E", "U"] as const;
export type AllocationMarket = (typeof ALLOCATION_MARKETS)[number];
export type AllocationShadowKind = "O1" | "S07";
/** Integer rational weights avoid losing the remainder of a one-third split. */
export interface AllocationTarget {
  denominator: number;
  K: number;
  E: number;
  U: number;
  C: number;
}
export interface IntegratedAllocationContract {
  version: typeof INTEGRATED_ALLOCATION_VERSION;
  book: "ALLOCATION_SHADOW";
  bookId: string;
  kind: AllocationShadowKind;
  startDate: typeof INTEGRATED_ALLOCATION_START;
  initialCapitalKrw: "30000000";
  fixedUsdKrw: typeof INTEGRATED_ALLOCATION_FX;
  codeHash: SeriesHash;
  initialTarget: AllocationTarget;
  initialReference: typeof INTEGRATED_O1_INITIAL_REFERENCE | null;
  sizing: "CALENDAR_YEAR_PRIOR_COMPLETE_NAV_K30_U20_ETF_PRIOR_CLOSE_NAV_VOLATILITY";
  pending: "KEEP_SIGNAL_BUDGET";
  zeroTarget: "CANCEL_UNFILLED_BUYS_RELEASE_RESERVATIONS_KEEP_HOLDINGS";
  reallocation: "O1_MONTH_END_IDLE_CASH_ONLY_NO_FORCED_SALES" | "STATIC_NO_TRANSFERS";
  researchEquivalence: "LIVE_DELIVERED_SIGNAL_CALENDAR_MONTH_O1_NOT_CM_RESEARCH";
  demandPolicy: "PREVIOUS_CALENDAR_MONTH_DELIVERED_ENTRY_SIGNALS";
  cost: "KR_ETF_FEE_INCLUSIVE_US_GROSS_PLUS_FEE_0.0015";
}
export interface AllocationPosition {
  symbol: string;
  venue: "KOSPI" | "KOSDAQ" | "ETF" | "US";
  sector: string | null;
  quantity: string;
  costKrw: string;
  entryDate: string;
  lastMark: { date: string; price: string } | null;
}
export interface AllocationPending {
  id: string;
  symbol: string;
  venue: AllocationPosition["venue"];
  sector: string | null;
  signalDate: string;
  originDate: string;
  availableAt: string;
  reason: string;
  sourceHash: SeriesHash;
  budgetKrw: string;
  remainingBudgetKrw: string;
  budgetYear: number;
  budgetNavDate: string;
  /** Frozen at the first executable open; never rebalance existing shares. */
  remainingQuantity: string | null;
  priority: number[];
}
export interface AllocationSleeve {
  cashKrw: string;
  positions: AllocationPosition[];
  pendingBuys: AllocationPending[];
  pendingExits: Array<{ symbol: string; signalDate: string; availableAt: string; reason: string }>;
  observedOnsets: Array<{ symbol: string; date: string }>;
  signalObservations: Array<{ date: string; status: "COMPLETE" | "MISSING" }>;
  holdingWindows: Array<{ symbol: string; entryDate: string; exitDate: string | null }>;
  sessions: string[];
  lastSessionDate: string | null;
  lastDecisionAt: string | null;
  navKrw: string | null;
  sizing: {
    year: number;
    navKrw: string | null;
    navDate: string;
    status: "READY" | "MISSING_PRIOR_YEAR_NAV" | "MISSING_PRIOR_CLOSE_NAV";
  };
}
export interface DeliveredAllocationSignal {
  market: AllocationMarket;
  symbol: string;
  originDate: string;
  /** Market confirmation/session date, even if its official delivery is next morning. */
  confirmationDate: string;
  deliveredAt: string;
  sourceHash: SeriesHash;
  reason: string;
}
export interface AllocationRecord {
  id: string;
  type: "SESSION" | "MONTH_REVIEW";
  date: string;
  sourceHash: SeriesHash;
  fills: Array<{
    market: AllocationMarket;
    symbol: string;
    side: "BUY" | "SELL";
    quantity: string;
    price: string;
    grossKrw: string;
    feeKrw: string;
    reason: string;
  }>;
  cancelledBuys: Array<{
    market: AllocationMarket;
    id: string;
    reason: "TARGET_ZERO" | "EXIT_SIGNAL";
  }>;
  transfers: Array<{ from: AllocationMarket | "C"; to: AllocationMarket | "C"; amountKrw: string }>;
  issues: string[];
  monthReview?: {
    signalMonth: string;
    targetMonth: string;
    coverageStart: string;
    coverageEnd: string;
    partialMonth: boolean;
    signalCounts: Record<AllocationMarket, number>;
    activeMarkets: AllocationMarket[];
    observationStatus: "COMPLETE" | "MISSING";
    applied: boolean;
  };
}
export interface IntegratedAllocationLedger {
  book: "ALLOCATION_SHADOW";
  bookId: string;
  contract: IntegratedAllocationContract;
  contractHash: SeriesHash;
  centralCashKrw: string;
  target: AllocationTarget;
  markets: Record<AllocationMarket, AllocationSleeve>;
  /** Common delivered conditions, recorded before portfolio holdings, sizing, cash, slots, or target gates. */
  deliveredEntrySignals: DeliveredAllocationSignal[];
  lastReviewMonth: string | null;
  receipts: Array<{ id: string; inputHash: SeriesHash; record: AllocationRecord }>;
  stateHash: SeriesHash;
}
export interface AllocationCalendar {
  sourceHash: SeriesHash;
  /** Complete, strictly increasing regular-session calendar, including the next session. */
  sessions: string[];
}
export interface AllocationSignal {
  symbol: string;
  venue: AllocationPosition["venue"];
  sector: string | null;
  side: "BUY" | "SELL";
  originDate: string;
  reason: string;
  /** Already ordered by the unchanged market signal engine's signal-time priority. */
  annualVolatility: number | null;
  priority?: number[];
}
export interface IntegratedAllocationSessionInput {
  market: AllocationMarket;
  date: string;
  previousSessionDate: string | null;
  openAt: string;
  closeAt: string;
  availableAt: string;
  decisionAt: string;
  sourceHash: SeriesHash;
  codeHash: SeriesHash;
  calendar: AllocationCalendar;
  /** Native quote currency: KRW for K/E, USD for U. Never use execution-day close for sizing. */
  prices: Array<{
    symbol: string;
    open: string | null;
    close: string | null;
    volume: number | null;
    maxBuyQuantity: string | null;
    maxSellQuantity?: string | null;
    entryAllowed?: boolean;
  }>;
  /** Derived by the existing KR exit planner, including H60 and explicit model-only missing-data exits. */
  executionExits?: Array<{
    symbol: string;
    timing: "OPEN" | "CLOSE";
    price: string;
    priceDate: string;
    reason: string;
  }>;
  inputIssues?: string[];
  signalObservation: "COMPLETE" | "MISSING";
  deliveredEntrySignals: AllocationSignal[];
  rawOnsets: string[];
  signals: AllocationSignal[];
}
export interface IntegratedAllocationMonthReview {
  month: string;
  decisionAt: string;
  sourceHash: SeriesHash;
  codeHash: SeriesHash;
  calendars: Record<AllocationMarket, AllocationCalendar>;
}
export type AllocationStepResult = {
  status: "NEW" | "REUSE";
  ledger: IntegratedAllocationLedger;
  record: AllocationRecord;
};
const feeRate = "0.0015";
const zero = () => decimal("0");
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
function hash(value: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value))
    throw new Error("Allocation SHA-256 provenance required");
}
function date(value: string) {
  if (!validDate(value)) throw new Error("Invalid allocation date");
}
function time(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !validDate(value.slice(0, 10)) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Explicit allocation timestamp required");
  return Date.parse(value);
}
function calendar(value: AllocationCalendar) {
  hash(value.sourceHash);
  value.sessions.forEach(date);
  if (!value.sessions.length || value.sessions[0]! > INTEGRATED_ALLOCATION_START)
    throw new Error("Allocation calendar must cover the series start");
  if (value.sessions.some((day, i) => i > 0 && day <= value.sessions[i - 1]!))
    throw new Error("Complete ordered allocation calendar required");
}
function targetAmount(nav: bigint, target: AllocationTarget, market: AllocationMarket | "C") {
  return (nav * BigInt(target[market])) / BigInt(target.denominator);
}
function nativeKrw(market: AllocationMarket, price: string) {
  return market === "U"
    ? multiply(decimal(price), decimal(INTEGRATED_ALLOCATION_FX))
    : decimal(price);
}
function capitalFor(kind: AllocationShadowKind): Record<AllocationMarket, string> {
  return kind === "O1"
    ? { K: "10000000", E: "10000000", U: "10000000" }
    : { K: "18000000", E: "6000000", U: "6000000" };
}
export async function createIntegratedAllocationShadow(
  kind: AllocationShadowKind,
  input: { codeHash: SeriesHash },
): Promise<IntegratedAllocationLedger> {
  hash(input.codeHash);
  if (kind !== "O1" && kind !== "S07")
    throw new Error("Only O1/S07 allocation Shadow contracts are supported");
  const initialTarget: AllocationTarget =
    kind === "O1"
      ? { denominator: 3, K: 1, E: 1, U: 1, C: 0 }
      : { denominator: 5, K: 3, E: 1, U: 1, C: 0 };
  const contract: IntegratedAllocationContract = {
    version: INTEGRATED_ALLOCATION_VERSION,
    book: "ALLOCATION_SHADOW",
    bookId: `${INTEGRATED_ALLOCATION_VERSION}:${kind}`,
    kind,
    startDate: INTEGRATED_ALLOCATION_START,
    initialCapitalKrw: "30000000",
    fixedUsdKrw: INTEGRATED_ALLOCATION_FX,
    codeHash: input.codeHash,
    initialTarget,
    initialReference: kind === "O1" ? structuredClone(INTEGRATED_O1_INITIAL_REFERENCE) : null,
    sizing: "CALENDAR_YEAR_PRIOR_COMPLETE_NAV_K30_U20_ETF_PRIOR_CLOSE_NAV_VOLATILITY",
    pending: "KEEP_SIGNAL_BUDGET",
    zeroTarget: "CANCEL_UNFILLED_BUYS_RELEASE_RESERVATIONS_KEEP_HOLDINGS",
    reallocation:
      kind === "O1" ? "O1_MONTH_END_IDLE_CASH_ONLY_NO_FORCED_SALES" : "STATIC_NO_TRANSFERS",
    researchEquivalence: "LIVE_DELIVERED_SIGNAL_CALENDAR_MONTH_O1_NOT_CM_RESEARCH",
    demandPolicy: "PREVIOUS_CALENDAR_MONTH_DELIVERED_ENTRY_SIGNALS",
    cost: "KR_ETF_FEE_INCLUSIVE_US_GROSS_PLUS_FEE_0.0015",
  };
  const capital = capitalFor(kind);
  const makeSleeve = (market: AllocationMarket): AllocationSleeve => ({
    cashKrw: capital[market],
    positions: [],
    pendingBuys: [],
    pendingExits: [],
    observedOnsets: [],
    signalObservations: [],
    holdingWindows: [],
    sessions: [],
    lastSessionDate: null,
    lastDecisionAt: null,
    navKrw: capital[market],
    sizing: {
      year: 2026,
      navKrw: capital[market],
      navDate: INTEGRATED_ALLOCATION_START,
      status: "READY",
    },
  });
  const markets: Record<AllocationMarket, AllocationSleeve> = {
    K: makeSleeve("K"),
    E: makeSleeve("E"),
    U: makeSleeve("U"),
  };
  const body = {
    book: "ALLOCATION_SHADOW" as const,
    bookId: contract.bookId,
    contract,
    contractHash: await hashSeriesValue(contract),
    centralCashKrw: "0",
    target: structuredClone(initialTarget),
    markets,
    deliveredEntrySignals: [],
    lastReviewMonth: null,
    receipts: [],
  };
  return { ...body, stateHash: await hashSeriesValue(body) };
}
export async function verifyIntegratedAllocationLedger(ledger: IntegratedAllocationLedger) {
  const { stateHash, ...body } = ledger;
  if (
    ledger.book !== "ALLOCATION_SHADOW" ||
    ledger.bookId !== `${INTEGRATED_ALLOCATION_VERSION}:${ledger.contract.kind}` ||
    ledger.contract.bookId !== ledger.bookId ||
    ledger.contract.version !== INTEGRATED_ALLOCATION_VERSION ||
    (await hashSeriesValue(body)) !== stateHash ||
    (await hashSeriesValue(ledger.contract)) !== ledger.contractHash
  )
    throw new Error("Allocation Shadow integrity/isolation mismatch");
  // Validate against the one approved contract rather than trusting a newly rehashed altered policy.
  const canonical = await createIntegratedAllocationShadow(ledger.contract.kind, {
    codeHash: ledger.contract.codeHash,
  });
  if (canonical.contractHash !== ledger.contractHash)
    throw new Error("Unsupported allocation contract");
}
function emptyRecord(
  id: string,
  type: AllocationRecord["type"],
  at: string,
  sourceHash: SeriesHash,
): AllocationRecord {
  return {
    id,
    type,
    date: at,
    sourceHash,
    fills: [],
    cancelledBuys: [],
    transfers: [],
    issues: [],
  };
}
async function begin(
  previous: IntegratedAllocationLedger,
  id: string,
  input: unknown,
  codeHash: SeriesHash,
) {
  await verifyIntegratedAllocationLedger(previous);
  if (codeHash !== previous.contract.codeHash)
    throw new Error("Allocation engine code changed; create a new contract");
  const inputHash = await hashSeriesValue(input),
    receipt = previous.receipts.find((x) => x.id === id);
  if (receipt && receipt.inputHash !== inputHash)
    throw new Error("Immutable allocation event conflict");
  return { inputHash, receipt };
}
async function finish(
  ledger: IntegratedAllocationLedger,
  record: AllocationRecord,
  inputHash: SeriesHash,
): Promise<AllocationStepResult> {
  ledger.receipts.push({ id: record.id, inputHash, record });
  const { stateHash: _, ...body } = ledger;
  ledger.stateHash = await hashSeriesValue(body);
  return { status: "NEW", ledger, record };
}
export function allocationReservedCash(
  ledger: IntegratedAllocationLedger,
  market: AllocationMarket,
): string {
  const sleeve = ledger.markets[market];
  const reserved = sleeve.pendingBuys.reduce((sum, pending) => {
    const budget = decimal(pending.remainingBudgetKrw);
    return sum + budget + (market === "U" ? exactNotionalFee(budget, feeRate) : 0n);
  }, 0n);
  return format(min(decimal(sleeve.cashKrw), reserved));
}
export function allocationTotalNav(ledger: IntegratedAllocationLedger): string | null {
  if (ALLOCATION_MARKETS.some((m) => ledger.markets[m].navKrw === null)) return null;
  return format(
    ALLOCATION_MARKETS.reduce(
      (sum, m) => sum + decimal(ledger.markets[m].navKrw!),
      decimal(ledger.centralCashKrw),
    ),
  );
}
function budgetFor(sleeve: AllocationSleeve, market: AllocationMarket, volatility: number | null) {
  if (sleeve.sizing.status !== "READY" || sleeve.sizing.navKrw === null) return null;
  if (market !== "E")
    return format(divide(decimal(sleeve.sizing.navKrw), decimal(market === "K" ? "30" : "20")));
  const weight = etfEntryWeight(volatility);
  if (weight === null) return null;
  // Matches the existing ETF executor's conservative eight-decimal weight projection.
  return format(
    multiply(decimal(sleeve.sizing.navKrw), decimal((Math.floor(weight * 1e8) / 1e8).toFixed(8))),
  );
}
function validateSignal(market: AllocationMarket, signal: AllocationSignal, at: string) {
  date(signal.originDate);
  if (signal.priority?.some((value) => !Number.isFinite(value)))
    throw new Error("Invalid signal-time priority");
  if (
    !signal.symbol ||
    signal.originDate > at ||
    (signal.side !== "BUY" && signal.side !== "SELL") ||
    !signal.reason ||
    !(market === "K" ? ["KOSPI", "KOSDAQ"] : market === "E" ? ["ETF"] : ["US"]).includes(
      signal.venue,
    )
  )
    throw new Error("Invalid market allocation signal");
}
/** One completed market session. No network, persistence, actual holdings, or legacy state is read. */
export async function stepIntegratedAllocationSession(
  previous: IntegratedAllocationLedger,
  input: IntegratedAllocationSessionInput,
): Promise<AllocationStepResult> {
  const id = `session:${input.market}:${input.date}`;
  const checked = await begin(previous, id, input, input.codeHash);
  if (checked.receipt) return { status: "REUSE", ledger: previous, record: checked.receipt.record };
  date(input.date);
  hash(input.sourceHash);
  calendar(input.calendar);
  if (
    !ALLOCATION_MARKETS.includes(input.market) ||
    input.date < INTEGRATED_ALLOCATION_START ||
    time(input.openAt) >= time(input.closeAt) ||
    time(input.closeAt) > time(input.availableAt) ||
    time(input.availableAt) > time(input.decisionAt)
  )
    throw new Error("Invalid allocation market session/availability");
  const ledger = structuredClone(previous),
    sleeve = ledger.markets[input.market];
  const regular = input.calendar.sessions.filter((d) => d >= INTEGRATED_ALLOCATION_START);
  const expected =
    sleeve.lastSessionDate === null
      ? regular[0]
      : regular[regular.indexOf(sleeve.lastSessionDate) + 1];
  if (
    input.date !== expected ||
    input.previousSessionDate !== sleeve.lastSessionDate ||
    sleeve.sessions.some((day) => !regular.includes(day))
  )
    throw new Error("Missing or changed allocation market sessions");
  const record = emptyRecord(id, "SESSION", input.date, input.sourceHash);
  record.issues.push(...(input.inputIssues ?? []));
  const prices = new Map(input.prices.map((p) => [p.symbol, p]));
  if (
    prices.size !== input.prices.length ||
    new Set(input.rawOnsets).size !== input.rawOnsets.length ||
    new Set(input.signals.map((s) => `${s.symbol}:${s.side}`)).size !== input.signals.length
  )
    throw new Error("Duplicate allocation observations/signals");
  for (const p of input.prices) {
    if (
      !p.symbol ||
      [p.open, p.close].some((v) => v !== null && decimal(v) <= 0n) ||
      (p.volume !== null && (!Number.isFinite(p.volume) || p.volume < 0)) ||
      (p.maxBuyQuantity !== null && !/^\d+$/.test(p.maxBuyQuantity)) ||
      (p.maxSellQuantity != null && !/^\d+$/.test(p.maxSellQuantity))
    )
      throw new Error("Invalid allocation price/volume");
  }
  input.signals.forEach((s) => validateSignal(input.market, s, input.date));
  if (
    !["COMPLETE", "MISSING"].includes(input.signalObservation) ||
    !Array.isArray(input.deliveredEntrySignals)
  )
    throw new Error("Explicit delivered-signal observation evidence required");
  for (const delivered of input.deliveredEntrySignals) {
    validateSignal(input.market, delivered, input.date);
    if (delivered.side !== "BUY" || input.signalObservation !== "COMPLETE")
      throw new Error("Delivered entry signals require complete market observation");
  }
  if (input.signalObservation === "MISSING")
    record.issues.push("MISSING_MARKET_SIGNAL_OBSERVATION");
  const localDate = (at: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: input.market === "U" ? "America/New_York" : "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(at));
  if (
    localDate(input.openAt) !== input.date ||
    localDate(input.closeAt) !== input.date ||
    (sleeve.lastDecisionAt && time(input.decisionAt) <= time(sleeve.lastDecisionAt))
  )
    throw new Error("Allocation clock/session mismatch");
  const year = Number(input.date.slice(0, 4));
  if (input.market !== "E" && year !== sleeve.sizing.year) {
    const prior = input.calendar.sessions.filter((d) => d < input.date).at(-1);
    const ready =
      !!prior &&
      prior.slice(0, 4) === String(year - 1) &&
      sleeve.lastSessionDate === prior &&
      sleeve.navKrw !== null &&
      sleeve.lastDecisionAt !== null &&
      time(sleeve.lastDecisionAt) < time(input.openAt);
    sleeve.sizing = {
      year,
      navKrw: ready ? sleeve.navKrw : null,
      navDate: prior ?? input.date,
      status: ready ? "READY" : "MISSING_PRIOR_YEAR_NAV",
    };
    if (!ready) record.issues.push("MISSING_PRIOR_YEAR_NAV_NEW_BUYS_BLOCKED");
  }
  const sold = new Set<string>();
  const sell = (symbol: string, price: string, reason: string, limit: string | null = null) => {
    const position = sleeve.positions.find((p) => p.symbol === symbol);
    if (!position) return;
    const oldQuantity = BigInt(position.quantity),
      quantity = limit === null ? oldQuantity : min(oldQuantity, BigInt(limit));
    if (quantity <= 0n) {
      record.issues.push(`EXIT_CAPACITY_CARRIED:${symbol}`);
      return;
    }
    const gross = quantity * nativeKrw(input.market, price),
      fee = exactNotionalFee(gross, feeRate);
    sleeve.cashKrw = format(decimal(sleeve.cashKrw) + gross - fee);
    position.quantity = (oldQuantity - quantity).toString();
    position.costKrw = format((decimal(position.costKrw) * (oldQuantity - quantity)) / oldQuantity);
    if (position.quantity === "0") {
      sleeve.positions = sleeve.positions.filter((p) => p !== position);
      sleeve.pendingExits = sleeve.pendingExits.filter((p) => p.symbol !== symbol);
      for (const w of sleeve.holdingWindows)
        if (w.symbol === symbol && w.exitDate === null) w.exitDate = input.date;
    }
    sleeve.pendingBuys = sleeve.pendingBuys.filter((p) => p.symbol !== symbol);
    sold.add(symbol);
    record.fills.push({
      market: input.market,
      symbol,
      side: "SELL",
      quantity: quantity.toString(),
      price,
      grossKrw: format(gross),
      feeKrw: format(fee),
      reason,
    });
  };
  for (const exit of input.executionExits ?? []) {
    date(exit.priceDate);
    if (
      input.market === "U" ||
      decimal(exit.price) <= 0n ||
      exit.priceDate > input.date ||
      !["OPEN", "CLOSE"].includes(exit.timing)
    )
      throw new Error("Invalid common-engine exit plan");
    if (exit.timing === "OPEN") sell(exit.symbol, exit.price, exit.reason);
  }
  // Existing exit intents precede buys; zero-target allocation never creates an exit intent.
  for (const pending of [...sleeve.pendingExits]) {
    const quote = prices.get(pending.symbol);
    if (!sleeve.positions.some((p) => p.symbol === pending.symbol)) {
      sleeve.pendingExits = sleeve.pendingExits.filter((p) => p !== pending);
      continue;
    }
    if (
      !quote?.open ||
      (input.market !== "U" && !quote.volume) ||
      time(pending.availableAt) > time(input.openAt)
    ) {
      record.issues.push(`EXIT_CARRIED:${pending.symbol}`);
      continue;
    }
    sell(pending.symbol, quote.open, pending.reason, quote.maxSellQuantity ?? null);
  }
  const rankedPending = [...sleeve.pendingBuys].sort((a, b) => {
    for (let i = 0; i < Math.max(a.priority.length, b.priority.length); i++) {
      const difference = (b.priority[i] ?? -Infinity) - (a.priority[i] ?? -Infinity);
      if (difference) return difference;
    }
    return a.symbol.localeCompare(b.symbol);
  });
  for (const pending of rankedPending) {
    const quote = prices.get(pending.symbol);
    if (
      !quote?.open ||
      (input.market !== "U" && !quote.volume) ||
      quote.entryAllowed === false ||
      sold.has(pending.symbol) ||
      (input.market === "E" && previous.markets.E.navKrw === null) ||
      time(pending.availableAt) > time(input.openAt)
    ) {
      record.issues.push(`ENTRY_CARRIED:${pending.symbol}`);
      continue;
    }
    const held = sleeve.positions.find((p) => p.symbol === pending.symbol);
    const cap = input.market === "K" ? 30 : input.market === "U" ? 20 : 10;
    const sameSector = sleeve.positions.filter((p) => p.sector === pending.sector).length;
    if (
      !held &&
      (sleeve.positions.length >= cap ||
        (input.market === "K" && sameSector >= (pending.venue === "KOSPI" ? 3 : 6)))
    ) {
      record.issues.push(`ENTRY_CAP_CARRIED:${pending.symbol}`);
      continue;
    }
    const price = nativeKrw(input.market, quote.open),
      budget = decimal(pending.remainingBudgetKrw);
    if (pending.remainingQuantity === null || input.market !== "U")
      pending.remainingQuantity =
        input.market === "U"
          ? (budget / price).toString()
          : integerBudgetQuantity(
              pending.remainingBudgetKrw,
              pending.remainingBudgetKrw,
              format(price),
              feeRate,
            );
    const cash = decimal(sleeve.cashKrw);
    let quantity = min(
      BigInt(pending.remainingQuantity),
      BigInt(
        integerBudgetQuantity(
          input.market === "U"
            ? format(budget + exactNotionalFee(budget, feeRate))
            : format(budget),
          format(cash),
          format(price),
          feeRate,
        ),
      ),
    );
    if (input.market === "U") quantity = min(quantity, budget / price);
    if (quote.maxBuyQuantity !== null) quantity = min(quantity, BigInt(quote.maxBuyQuantity));
    if (quantity <= 0n) {
      record.issues.push(`ENTRY_UNFUNDED_CARRIED:${pending.symbol}`);
      continue;
    }
    const gross = quantity * price,
      fee = exactNotionalFee(gross, feeRate),
      spend = gross + fee;
    sleeve.cashKrw = format(cash - spend);
    pending.remainingBudgetKrw = format(budget - (input.market === "U" ? gross : spend));
    pending.remainingQuantity = (BigInt(pending.remainingQuantity) - quantity).toString();
    if (held) {
      held.quantity = (BigInt(held.quantity) + quantity).toString();
      held.costKrw = format(decimal(held.costKrw) + spend);
    } else {
      sleeve.holdingWindows.push({ symbol: pending.symbol, entryDate: input.date, exitDate: null });
      sleeve.positions.push({
        symbol: pending.symbol,
        venue: pending.venue,
        sector: pending.sector,
        quantity: quantity.toString(),
        costKrw: format(spend),
        entryDate: input.date,
        lastMark: null,
      });
    }
    if (input.market !== "U" || pending.remainingQuantity === "0")
      sleeve.pendingBuys = sleeve.pendingBuys.filter((p) => p !== pending);
    record.fills.push({
      market: input.market,
      symbol: pending.symbol,
      side: "BUY",
      quantity: quantity.toString(),
      price: quote.open,
      grossKrw: format(gross),
      feeKrw: format(fee),
      reason: pending.reason,
    });
  }
  for (const exit of input.executionExits ?? [])
    if (exit.timing === "CLOSE") sell(exit.symbol, exit.price, exit.reason);
  let complete = true,
    marketValue = 0n;
  for (const held of sleeve.positions) {
    const quote = prices.get(held.symbol);
    if (quote?.close) {
      held.lastMark = { date: input.date, price: quote.close };
      marketValue += BigInt(held.quantity) * nativeKrw(input.market, quote.close);
    } else {
      complete = false;
      record.issues.push(`MISSING_CURRENT_MARK:${held.symbol}`);
    }
  }
  sleeve.navKrw = complete ? format(decimal(sleeve.cashKrw) + marketValue) : null;
  if (input.market === "E")
    sleeve.sizing = {
      year,
      navKrw: sleeve.navKrw,
      navDate: input.date,
      status: sleeve.navKrw === null ? "MISSING_PRIOR_CLOSE_NAV" : "READY",
    };
  for (const symbol of input.rawOnsets)
    if (!sleeve.observedOnsets.some((s) => s.symbol === symbol && s.date === input.date))
      sleeve.observedOnsets.push({ symbol, date: input.date });
  // Pure signal delivery is shared across allocations and never depends on orders, budgets, or holdings.
  for (const delivered of input.deliveredEntrySignals) {
    if (
      delivered.originDate < INTEGRATED_ALLOCATION_START ||
      !sleeve.observedOnsets.some(
        (s) => s.symbol === delivered.symbol && s.date === delivered.originDate,
      )
    ) {
      record.issues.push(`UNOBSERVED_OR_PRESTART_DELIVERED_ONSET:${delivered.symbol}`);
      continue;
    }
    if (
      !ledger.deliveredEntrySignals.some(
        (s) =>
          s.market === input.market &&
          s.symbol === delivered.symbol &&
          s.originDate === delivered.originDate,
      )
    )
      ledger.deliveredEntrySignals.push({
        market: input.market,
        symbol: delivered.symbol,
        originDate: delivered.originDate,
        confirmationDate: input.date,
        deliveredAt: input.availableAt,
        sourceHash: input.sourceHash,
        reason: delivered.reason,
      });
  }
  sleeve.signalObservations.push({ date: input.date, status: input.signalObservation });
  for (const signal of input.signals) {
    if (signal.side === "SELL") {
      for (const pending of sleeve.pendingBuys.filter((p) => p.symbol === signal.symbol))
        record.cancelledBuys.push({ market: input.market, id: pending.id, reason: "EXIT_SIGNAL" });
      sleeve.pendingBuys = sleeve.pendingBuys.filter((p) => p.symbol !== signal.symbol);
      if (
        sleeve.positions.some((p) => p.symbol === signal.symbol) &&
        !sleeve.pendingExits.some((p) => p.symbol === signal.symbol)
      )
        sleeve.pendingExits.push({
          symbol: signal.symbol,
          signalDate: input.date,
          availableAt: input.availableAt,
          reason: signal.reason,
        });
      continue;
    }
    if (
      signal.originDate < INTEGRATED_ALLOCATION_START ||
      !sleeve.observedOnsets.some((s) => s.symbol === signal.symbol && s.date === signal.originDate)
    ) {
      record.issues.push(`UNOBSERVED_OR_PRESTART_ONSET:${signal.symbol}`);
      continue;
    }
    const budget = budgetFor(sleeve, input.market, signal.annualVolatility);
    if (budget === null || decimal(budget) <= 0n) {
      record.issues.push(`ENTRY_SIZING_UNAVAILABLE:${signal.symbol}`);
      continue;
    }
    const demandId = `${signal.symbol}:${signal.originDate}`;
    if (
      ledger.target[input.market] === 0 ||
      sold.has(signal.symbol) ||
      sleeve.holdingWindows.some(
        (w) =>
          w.symbol === signal.symbol &&
          w.entryDate <= input.date &&
          (w.exitDate === null || w.exitDate >= signal.originDate),
      ) ||
      sleeve.positions.some((p) => p.symbol === signal.symbol) ||
      sleeve.pendingBuys.some((p) => p.symbol === signal.symbol) ||
      sleeve.pendingExits.some((p) => p.symbol === signal.symbol)
    )
      continue;
    sleeve.pendingBuys.push({
      id: `${input.market}:${demandId}`,
      symbol: signal.symbol,
      venue: signal.venue,
      sector: signal.sector,
      signalDate: input.date,
      originDate: signal.originDate,
      availableAt: input.availableAt,
      reason: signal.reason,
      sourceHash: input.sourceHash,
      budgetKrw: budget,
      remainingBudgetKrw: budget,
      budgetYear: sleeve.sizing.year,
      budgetNavDate: sleeve.sizing.navDate,
      remainingQuantity: null,
      priority: signal.priority ? [...signal.priority] : [],
    });
  }
  sleeve.sessions.push(input.date);
  sleeve.lastSessionDate = input.date;
  sleeve.lastDecisionAt = input.decisionAt;
  return finish(ledger, record, checked.inputHash);
}
/** Review the just-completed calendar month and apply its delivered-signal target for next month. */
export async function reviewIntegratedAllocationMonth(
  previous: IntegratedAllocationLedger,
  input: IntegratedAllocationMonthReview,
): Promise<AllocationStepResult> {
  const id = `month:${input.month}`,
    checked = await begin(previous, id, input, input.codeHash);
  if (checked.receipt) return { status: "REUSE", ledger: previous, record: checked.receipt.record };
  hash(input.sourceHash);
  time(input.decisionAt);
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month) ||
    input.month < "2026-10" ||
    (previous.lastReviewMonth !== null && input.month <= previous.lastReviewMonth)
  )
    throw new Error("Invalid allocation review month/order");
  const ledger = structuredClone(previous),
    record = emptyRecord(id, "MONTH_REVIEW", input.month, input.sourceHash);
  let historyComplete = true;
  const active: AllocationMarket[] = [];
  const counts: Record<AllocationMarket, number> = { K: 0, E: 0, U: 0 };
  for (const market of ALLOCATION_MARKETS) {
    const c = input.calendars[market],
      sleeve = ledger.markets[market];
    calendar(c);
    const expected = c.sessions.filter(
      (day) => day.slice(0, 7) === input.month && day >= INTEGRATED_ALLOCATION_START,
    );
    const last = expected.at(-1),
      next = last ? c.sessions[c.sessions.indexOf(last) + 1] : undefined;
    if (!last || !next || next.slice(0, 7) <= input.month)
      throw new Error(`Month-end completed calendar/data not verified: ${market}`);
    if (sleeve.lastDecisionAt && time(sleeve.lastDecisionAt) > time(input.decisionAt))
      throw new Error(`Month-end decision precedes completed data: ${market}`);
    if (
      sleeve.lastSessionDate !== last ||
      expected.some(
        (day) =>
          !sleeve.sessions.includes(day) ||
          !sleeve.signalObservations.some((o) => o.date === day && o.status === "COMPLETE"),
      )
    )
      historyComplete = false;
    counts[market] = ledger.deliveredEntrySignals.filter(
      (s) =>
        s.market === market &&
        s.confirmationDate.slice(0, 7) === input.month &&
        time(s.deliveredAt) <= time(input.decisionAt),
    ).length;
    if (counts[market] > 0) active.push(market);
  }
  const [year, month] = input.month.split("-").map(Number);
  record.monthReview = {
    signalMonth: input.month,
    targetMonth: new Date(Date.UTC(year!, month!, 1)).toISOString().slice(0, 7),
    coverageStart:
      input.month === INTEGRATED_ALLOCATION_START.slice(0, 7)
        ? INTEGRATED_ALLOCATION_START
        : `${input.month}-01`,
    coverageEnd: new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10),
    partialMonth: input.month === INTEGRATED_ALLOCATION_START.slice(0, 7),
    signalCounts: counts,
    activeMarkets: active,
    observationStatus: historyComplete ? "COMPLETE" : "MISSING",
    applied: false,
  };
  if (record.monthReview.partialMonth)
    record.issues.push("PARTIAL_START_MONTH_SIGNALS_2026_10_12_ONWARD");
  if (ledger.contract.kind === "S07") record.issues.push("STATIC_TARGET_NO_TRANSFERS");
  else if (!historyComplete)
    record.issues.push("INCOMPLETE_CALENDAR_MONTH_SIGNAL_OBSERVATION_KEEP_TARGET");
  else if (allocationTotalNav(ledger) === null)
    record.issues.push("INCOMPLETE_MARKET_NAV_KEEP_TARGET");
  else {
    record.monthReview.applied = true;
    ledger.target =
      active.length === 3
        ? { denominator: 3, K: 1, E: 1, U: 1, C: 0 }
        : active.length === 2
          ? {
              denominator: 2,
              K: Number(active.includes("K")),
              E: Number(active.includes("E")),
              U: Number(active.includes("U")),
              C: 0,
            }
          : active.length === 1
            ? {
                denominator: 5,
                K: active[0] === "K" ? 3 : 0,
                E: active[0] === "E" ? 3 : 0,
                U: active[0] === "U" ? 3 : 0,
                C: 2,
              }
            : { denominator: 1, K: 0, E: 0, U: 0, C: 1 };
    for (const market of ALLOCATION_MARKETS)
      if (ledger.target[market] === 0) {
        for (const p of ledger.markets[market].pendingBuys)
          record.cancelledBuys.push({ market, id: p.id, reason: "TARGET_ZERO" });
        ledger.markets[market].pendingBuys = [];
      }
    const total = decimal(allocationTotalNav(ledger)!);
    // Collect only excess, unreserved market cash. Existing holdings are never sold to meet targets.
    for (const market of ALLOCATION_MARKETS) {
      const sleeve = ledger.markets[market],
        desired = targetAmount(total, ledger.target, market);
      const excess = max(0n, decimal(sleeve.navKrw!) - desired);
      const idle = decimal(sleeve.cashKrw) - decimal(allocationReservedCash(ledger, market));
      const amount = min(idle, excess);
      if (amount > 0n) {
        sleeve.cashKrw = format(decimal(sleeve.cashKrw) - amount);
        sleeve.navKrw = format(decimal(sleeve.navKrw!) - amount);
        ledger.centralCashKrw = format(decimal(ledger.centralCashKrw) + amount);
        record.transfers.push({ from: market, to: "C", amountKrw: format(amount) });
      }
    }
    const distributable = max(
      0n,
      decimal(ledger.centralCashKrw) - targetAmount(total, ledger.target, "C"),
    );
    const deficits = ALLOCATION_MARKETS.map((m) =>
      max(0n, targetAmount(total, ledger.target, m) - decimal(ledger.markets[m].navKrw!)),
    );
    const sum = deficits.reduce((a, b) => a + b, 0n);
    ALLOCATION_MARKETS.forEach((market, i) => {
      const amount = sum > 0n ? (min(distributable, sum) * deficits[i]!) / sum : 0n;
      if (amount > 0n) {
        const sleeve = ledger.markets[market];
        sleeve.cashKrw = format(decimal(sleeve.cashKrw) + amount);
        sleeve.navKrw = format(decimal(sleeve.navKrw!) + amount);
        ledger.centralCashKrw = format(decimal(ledger.centralCashKrw) - amount);
        record.transfers.push({ from: "C", to: market, amountKrw: format(amount) });
      }
    });
  }
  ledger.lastReviewMonth = input.month;
  return finish(ledger, record, checked.inputHash);
}
