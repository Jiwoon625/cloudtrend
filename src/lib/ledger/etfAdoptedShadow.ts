import { ETF_POLICY, etfEntryWeight, type EtfStrategySnapshot } from "../engine/etfStrategy";
import { decimal, format, multiply } from "./decimal";
import {
  assertModelSeriesIsolation,
  assertModelCalendarContinuation,
  canonicalSeriesJson,
  firstModelSession,
  guardModelRun,
  hashSeriesValue,
  quoteModelBudget,
  verifyFrozenSeries,
  type FrozenModelSeries,
  type ModelCalendar,
  type ModelRunReceipt,
  type SeriesHash,
} from "./modelSeries";
import { validDate } from "./date";
import { isKrOfficialShadowDecision } from "./krShadowDecision";

/** An opt-in MODEL executor. It has no persistence, scheduler, broker, or real-holdings access. */
export interface EtfShadowPrice {
  asOfDate: string;
  availableAt: string;
  sourceHash: SeriesHash;
  price: string | null;
}
export interface EtfShadowSignal {
  symbol: string;
  availableAt: string;
  sourceHash: SeriesHash;
  strategy: EtfStrategySnapshot;
}
export interface EtfShadowMark {
  asOfDate: string;
  availableAt: string;
  sourceHash: SeriesHash;
  price: string;
}
export interface EtfShadowPosition {
  symbol: string;
  quantity: string;
  entryDate: string;
  originDate: string;
  confirmationDate: string;
  entryPrice: string;
  /** Includes the entry fee; it is never reset by a new closing mark. */
  costBasis: string;
  mark: EtfShadowMark | null;
}
export interface EtfShadowPendingEntry {
  symbol: string;
  originDate: string;
  confirmationDate: string;
  availableAt: string;
  sourceHash: SeriesHash;
  entryWeight: string;
  averageTradingValue20: number;
}
export interface EtfShadowPendingExit {
  symbol: string;
  signalDate: string;
  availableAt: string;
  sourceHash: SeriesHash;
  reason: "MA60";
}
export interface EtfShadowValuation {
  asOfDate: string;
  cash: string;
  /** Null if even one held position has no known close. Never substitutes zero. */
  marketValue: string | null;
  nav: string | null;
  unrealizedPnl: string | null;
  status: "COMPLETE" | "STALE" | "MISSING";
  marks: Array<{
    symbol: string;
    quantity: string;
    price: string | null;
    asOfDate: string | null;
    sourceHash: SeriesHash | null;
    value: string | null;
    status: "CURRENT" | "STALE" | "MISSING";
  }>;
}
export interface EtfAdoptedShadowState {
  book: "MODEL";
  bookId: string;
  contractHash: SeriesHash;
  codeHash: SeriesHash;
  configHash: SeriesHash;
  initialSourceHash: SeriesHash;
  scheduledStartDate: string;
  firstValidSessionDate: string | null;
  lastSessionDate: string | null;
  lastCloseAt: string | null;
  cash: string;
  positions: EtfShadowPosition[];
  /** Only raw onsets actually observed inside this new series can become confirmations. */
  pendingConfirmations: Array<{ symbol: string; originDate: string }>;
  pendingEntries: EtfShadowPendingEntry[];
  pendingExits: EtfShadowPendingExit[];
  valuation: EtfShadowValuation;
  cumulativeFees: string;
  realizedPnl: string;
}
export interface EtfShadowFill {
  symbol: string;
  side: "BUY" | "SELL";
  executionDate: string;
  executionAt: string;
  priceAsOfDate: string;
  priceSourceHash: SeriesHash;
  signalDate: string;
  signalSourceHash: SeriesHash;
  originDate: string | null;
  reason: "CONFIRM1" | "MA60";
  quantity: string;
  price: string;
  gross: string;
  fee: string;
  cashDelta: string;
  targetBudget: string | null;
  budgetNavDate: string | null;
  realizedPnl: string | null;
}
export type EtfShadowIssueCode =
  | "ENTRY_EXPIRED_MISSING_OPEN"
  | "EXIT_DELAYED_MISSING_OPEN"
  | "SIGNAL_UNAVAILABLE_AT_OPEN"
  | "ENTRY_EXPIRED_INCOMPLETE_PRIOR_NAV"
  | "ENTRY_EXPIRED_STALE_PRIOR_NAV"
  | "ENTRY_EXPIRED_MAX_POSITIONS"
  | "ENTRY_EXPIRED_INSUFFICIENT_BUDGET"
  | "ALREADY_HELD"
  | "SIGNAL_DATE_MISMATCH"
  | "SIGNAL_UNAVAILABLE_AT_CLOSE"
  | "SIGNAL_PRESTART_ORIGIN"
  | "SIGNAL_UNOBSERVED_ORIGIN"
  | "SIGNAL_INVALID_CONFIRMATION"
  | "SIGNAL_DATA_UNAVAILABLE"
  | "HELD_SIGNAL_MISSING"
  | "MARK_MISSING"
  | "MARK_STALE";
export interface EtfShadowIssue {
  symbol: string;
  code: EtfShadowIssueCode;
  phase: "OPEN" | "CLOSE";
}
export interface EtfShadowDailyRecord {
  receipt: ModelRunReceipt;
  calendarSourceHash: SeriesHash;
  previousSessionDate: string | null;
  openAt: string;
  closeAt: string;
  openingCash: string;
  priorCloseNav: string | null;
  priorCloseNavDate: string;
  fills: EtfShadowFill[];
  issues: EtfShadowIssue[];
  pendingConfirmations: EtfAdoptedShadowState["pendingConfirmations"];
  pendingEntries: EtfShadowPendingEntry[];
  pendingExits: EtfShadowPendingExit[];
  valuation: EtfShadowValuation;
  fees: string;
  realizedPnl: string;
}
export interface EtfShadowSessionInput {
  sessionDate: string;
  /** Previous processed regular market session; null only for the first session. */
  previousSessionDate: string | null;
  openAt: string;
  closeAt: string;
  /** Production KR publication waits for the next regular-session morning KRX refresh. */
  decisionWindow?: "SESSION_CLOSE" | "NEXT_SESSION_PREOPEN";
  calendar: ModelCalendar;
  codeHash: SeriesHash;
  configHash: SeriesHash;
  sourceHash: SeriesHash;
  prices: Array<{ symbol: string; open: EtfShadowPrice | null; close: EtfShadowPrice | null }>;
  closeSignals: EtfShadowSignal[];
}

/** Structurally compatible with ModelJournalRun; no persistence dependency or import cycle. */
export interface AdoptedEtfRun {
  book: "MODEL";
  bookId: string;
  contractHash: SeriesHash;
  receipt: ModelRunReceipt;
  previousStateHash: SeriesHash | null;
  stateHash: SeriesHash;
  calendar: ModelCalendar;
  result: { state: EtfAdoptedShadowState; record: EtfShadowDailyRecord };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function hash(value: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value))
    throw new Error("ETF provenance requires SHA-256 hashes");
}
function date(value: string) {
  if (!validDate(value)) throw new Error("Invalid ETF session/as-of date");
}
function time(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !validDate(value.slice(0, 10)) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Explicit ETF timestamp with timezone required");
  return Date.parse(value);
}
function marketDate(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(time(value)));
}
function symbol(value: string) {
  if (!/^[A-Z0-9]{6}$/.test(value))
    throw new Error("ETF symbol must preserve its six-character listing code");
}
function uniqueSymbols(items: ReadonlyArray<{ symbol: string }>) {
  const seen = new Set<string>();
  for (const item of items) {
    symbol(item.symbol);
    if (seen.has(item.symbol)) throw new Error("Duplicate ETF symbol");
    seen.add(item.symbol);
  }
}
async function assertSeries(series: FrozenModelSeries) {
  await verifyFrozenSeries(series);
  if (
    series.policy.kind !== "ETF_V02" ||
    series.policy.currency !== "KRW" ||
    series.fx !== null ||
    series.policy.maxPositions !== ETF_POLICY.maxPositions ||
    canonicalSeriesJson(series.policy.enginePolicy) !== canonicalSeriesJson(ETF_POLICY)
  )
    throw new Error("ETF shadow requires the frozen, unchanged V0.2 adopted MODEL series");
}
function valueAtClose(
  positions: EtfShadowPosition[],
  cash: string,
  asOfDate: string,
): EtfShadowValuation {
  const marks = positions.map((position): EtfShadowValuation["marks"][number] => ({
    symbol: position.symbol,
    quantity: position.quantity,
    price: position.mark?.price ?? null,
    asOfDate: position.mark?.asOfDate ?? null,
    sourceHash: position.mark?.sourceHash ?? null,
    value: position.mark ? format(decimal(position.mark.price) * BigInt(position.quantity)) : null,
    status: !position.mark ? "MISSING" : position.mark.asOfDate === asOfDate ? "CURRENT" : "STALE",
  }));
  const status = marks.some((mark) => mark.status === "MISSING")
    ? "MISSING"
    : marks.some((mark) => mark.status === "STALE")
      ? "STALE"
      : "COMPLETE";
  const marketValue =
    status === "MISSING" ? null : marks.reduce((sum, mark) => sum + decimal(mark.value!), 0n);
  const costBasis = positions.reduce((sum, position) => sum + decimal(position.costBasis), 0n);
  return {
    asOfDate,
    cash,
    marketValue: marketValue === null ? null : format(marketValue),
    nav: marketValue === null ? null : format(decimal(cash) + marketValue),
    unrealizedPnl: marketValue === null ? null : format(marketValue - costBasis),
    status,
    marks,
  };
}
function validatePrice(price: EtfShadowPrice | null) {
  if (!price) return;
  date(price.asOfDate);
  time(price.availableAt);
  hash(price.sourceHash);
  if (price.price !== null && decimal(price.price) <= 0n)
    throw new Error("ETF prices must be positive or explicitly missing");
}
function openPrice(
  price: EtfShadowPrice | null | undefined,
  input: EtfShadowSessionInput,
): EtfShadowMark | null {
  return price &&
    price.price !== null &&
    price.asOfDate === input.sessionDate &&
    marketDate(price.availableAt) === input.sessionDate &&
    time(price.availableAt) <= time(input.openAt)
    ? { ...price, price: price.price }
    : null;
}
function assertState(series: FrozenModelSeries, state: EtfAdoptedShadowState) {
  assertModelSeriesIsolation(series, state);
  if (
    state.scheduledStartDate !== series.accountingStartDate ||
    state.codeHash !== series.codeHash ||
    state.configHash !== series.configHash ||
    state.initialSourceHash !== series.sourceHash ||
    decimal(state.cash) < 0n ||
    decimal(state.cumulativeFees) < 0n ||
    state.positions.length > ETF_POLICY.maxPositions
  )
    throw new Error("Invalid ETF state or changed frozen provenance");
  decimal(state.realizedPnl);
  for (const items of [
    state.positions,
    state.pendingEntries,
    state.pendingExits,
    state.pendingConfirmations,
  ])
    uniqueSymbols(items);
  if (state.lastSessionDate === null) {
    if (
      state.firstValidSessionDate !== null ||
      state.lastCloseAt !== null ||
      state.positions.length ||
      state.pendingEntries.length ||
      state.pendingExits.length ||
      state.pendingConfirmations.length ||
      state.cash !== series.initialKrw ||
      state.cumulativeFees !== "0" ||
      state.realizedPnl !== "0"
    )
      throw new Error("Initial ETF state must be all cash without inherited signals or positions");
  } else {
    date(state.lastSessionDate);
    if (
      !state.firstValidSessionDate ||
      state.firstValidSessionDate < series.accountingStartDate ||
      state.firstValidSessionDate > state.lastSessionDate ||
      !state.lastCloseAt
    )
      throw new Error("Invalid ETF processed-session boundary");
    date(state.firstValidSessionDate);
    time(state.lastCloseAt);
  }
  for (const position of state.positions) {
    if (
      !/^[1-9]\d*$/.test(position.quantity) ||
      decimal(position.entryPrice) <= 0n ||
      decimal(position.costBasis) <= 0n ||
      !state.lastSessionDate ||
      position.entryDate > state.lastSessionDate ||
      position.originDate < series.accountingStartDate ||
      position.originDate >= position.confirmationDate ||
      position.confirmationDate >= position.entryDate
    )
      throw new Error("Invalid ETF position or pre-start history");
    date(position.entryDate);
    date(position.originDate);
    date(position.confirmationDate);
    if (position.mark) {
      validatePrice(position.mark);
      if (
        position.mark.asOfDate > state.lastSessionDate ||
        time(position.mark.availableAt) > time(state.lastCloseAt!)
      )
        throw new Error("Future mark in ETF state");
    }
  }
  for (const setup of state.pendingConfirmations)
    if (setup.originDate !== state.lastSessionDate)
      throw new Error("ETF setup must originate at the last close");
  for (const entry of state.pendingEntries) {
    date(entry.originDate);
    date(entry.confirmationDate);
    time(entry.availableAt);
    hash(entry.sourceHash);
    if (
      entry.originDate < series.accountingStartDate ||
      entry.originDate >= entry.confirmationDate ||
      entry.confirmationDate !== state.lastSessionDate ||
      time(entry.availableAt) > time(state.lastCloseAt!) ||
      decimal(entry.entryWeight) <= 0n ||
      decimal(entry.entryWeight) > decimal("0.1") ||
      !Number.isFinite(entry.averageTradingValue20) ||
      entry.averageTradingValue20 < 0
    )
      throw new Error("Invalid or stale ETF pending entry");
  }
  for (const exit of state.pendingExits) {
    date(exit.signalDate);
    time(exit.availableAt);
    hash(exit.sourceHash);
    if (
      exit.reason !== "MA60" ||
      exit.signalDate < series.accountingStartDate ||
      !state.lastSessionDate ||
      exit.signalDate > state.lastSessionDate ||
      time(exit.availableAt) > time(state.lastCloseAt!) ||
      !state.positions.some((position) => position.symbol === exit.symbol)
    )
      throw new Error("Invalid ETF pending exit");
  }
  if (
    canonicalSeriesJson(state.valuation) !==
    canonicalSeriesJson(
      valueAtClose(
        state.positions,
        state.cash,
        state.lastSessionDate ?? series.accountingStartDate,
      ),
    )
  )
    throw new Error("ETF state valuation does not reconcile");
}

/** Scheduled 2026-10-05 boundary is all cash even if that date is a market holiday. */
export async function initializeEtfAdoptedShadow(
  series: FrozenModelSeries,
): Promise<EtfAdoptedShadowState> {
  await assertSeries(series);
  return freeze({
    book: "MODEL",
    bookId: series.bookId,
    contractHash: series.contractHash,
    codeHash: series.codeHash,
    configHash: series.configHash,
    initialSourceHash: series.sourceHash,
    scheduledStartDate: series.accountingStartDate,
    firstValidSessionDate: null,
    lastSessionDate: null,
    lastCloseAt: null,
    cash: series.initialKrw,
    positions: [],
    pendingConfirmations: [],
    pendingEntries: [],
    pendingExits: [],
    valuation: valueAtClose([], series.initialKrw, series.accountingStartDate),
    cumulativeFees: "0",
    realizedPnl: "0",
  });
}

/**
 * Complete one observed regular session. All open fills are decided before examining
 * current-close signals or marks. Calling with the same or an omitted session fails.
 * A persistence adapter must atomically save state + record under (bookId, sessionDate).
 */
export async function stepEtfAdoptedShadow(
  series: FrozenModelSeries,
  previous: EtfAdoptedShadowState,
  input: EtfShadowSessionInput,
): Promise<{ state: EtfAdoptedShadowState; record: EtfShadowDailyRecord }> {
  await assertSeries(series);
  assertState(series, previous);
  date(input.sessionDate);
  const openAt = time(input.openAt),
    closeAt = time(input.closeAt),
    nextMorning = input.decisionWindow === "NEXT_SESSION_PREOPEN";
  if (
    marketDate(input.openAt) !== input.sessionDate ||
    (!nextMorning && marketDate(input.closeAt) !== input.sessionDate) ||
    (nextMorning &&
      !isKrOfficialShadowDecision(input.sessionDate, input.closeAt, input.closeAt)) ||
    openAt >= closeAt ||
    (previous.lastCloseAt && openAt <= time(previous.lastCloseAt))
  )
    throw new Error("Invalid ETF open/decision chronology");
  if (
    input.previousSessionDate !== previous.lastSessionDate ||
    (previous.lastSessionDate && input.sessionDate <= previous.lastSessionDate)
  )
    throw new Error("ETF steps require strictly increasing matching previous sessions");
  const first = firstModelSession(series, input.calendar);
  if (previous.firstValidSessionDate !== null && first !== previous.firstValidSessionDate)
    throw new Error("ETF calendar changed the recorded first valid session");
  const expected = previous.lastSessionDate
    ? [...input.calendar.regularSessions]
        .sort()
        .find((session) => session > previous.lastSessionDate!)
    : first;
  if (
    input.sessionDate !== expected ||
    input.sessionDate > input.calendar.coverageEnd ||
    (previous.lastSessionDate && !input.calendar.regularSessions.includes(previous.lastSessionDate))
  )
    throw new Error("ETF step must be the next covered regular market session");
  const { receipt } = await guardModelRun(series, {
    date: input.sessionDate,
    codeHash: input.codeHash,
    configHash: input.configHash,
    sourceHash: input.sourceHash,
  });
  uniqueSymbols(input.prices);
  uniqueSymbols(input.closeSignals);
  for (const prices of input.prices) {
    validatePrice(prices.open);
    validatePrice(prices.close);
  }
  for (const signal of input.closeSignals) {
    hash(signal.sourceHash);
    time(signal.availableAt);
    date(signal.strategy.date);
  }

  let cash = decimal(previous.cash),
    fees = 0n,
    realizedPnl = 0n;
  let positions = previous.positions.map((position) => ({
    ...position,
    mark: position.mark ? { ...position.mark } : null,
  }));
  const prices = new Map(input.prices.map((row) => [row.symbol, row]));
  const issues: EtfShadowIssue[] = [],
    fills: EtfShadowFill[] = [],
    pendingExits: EtfShadowPendingExit[] = [];
  const issue = (symbol: string, code: EtfShadowIssueCode, phase: EtfShadowIssue["phase"]) =>
    issues.push({ symbol, code, phase });
  const sold = new Set<string>();

  // A known MA60 liquidation may wait for a real open. No inferred or stale-price fills.
  for (const exit of [...previous.pendingExits].sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    const position = positions.find((held) => held.symbol === exit.symbol)!;
    const price = openPrice(prices.get(exit.symbol)?.open, input);
    if (!price || time(exit.availableAt) > openAt) {
      issue(
        exit.symbol,
        !price ? "EXIT_DELAYED_MISSING_OPEN" : "SIGNAL_UNAVAILABLE_AT_OPEN",
        "OPEN",
      );
      pendingExits.push({ ...exit });
      continue;
    }
    const gross = decimal(price.price) * BigInt(position.quantity);
    const scale = decimal("1"),
      fee = (gross * decimal(series.oneWayCost) + scale - 1n) / scale;
    const credit = gross - fee,
      pnl = credit - decimal(position.costBasis);
    cash += credit;
    fees += fee;
    realizedPnl += pnl;
    fills.push({
      symbol: exit.symbol,
      side: "SELL",
      executionDate: input.sessionDate,
      executionAt: input.openAt,
      priceAsOfDate: price.asOfDate,
      priceSourceHash: price.sourceHash,
      signalDate: exit.signalDate,
      signalSourceHash: exit.sourceHash,
      originDate: null,
      reason: "MA60",
      quantity: position.quantity,
      price: price.price,
      gross: format(gross),
      fee: format(fee),
      cashDelta: format(credit),
      targetBudget: null,
      budgetNavDate: null,
      realizedPnl: format(pnl),
    });
    positions = positions.filter((held) => held.symbol !== exit.symbol);
    sold.add(exit.symbol);
  }

  // Entry intent lasts for this eligible open only. Missing price/NAV does not license
  // carrying a confirmed signal into a later session, or replacing an existing holding.
  const entries = [...previous.pendingEntries].sort(
    (a, b) => b.averageTradingValue20 - a.averageTradingValue20 || a.symbol.localeCompare(b.symbol),
  );
  for (const entry of entries) {
    if (positions.some((position) => position.symbol === entry.symbol) || sold.has(entry.symbol)) {
      issue(entry.symbol, "ALREADY_HELD", "OPEN");
      continue;
    }
    if (time(entry.availableAt) > openAt) {
      issue(entry.symbol, "SIGNAL_UNAVAILABLE_AT_OPEN", "OPEN");
      continue;
    }
    if (positions.length >= ETF_POLICY.maxPositions) {
      issue(entry.symbol, "ENTRY_EXPIRED_MAX_POSITIONS", "OPEN");
      continue;
    }
    if (previous.valuation.nav === null) {
      issue(entry.symbol, "ENTRY_EXPIRED_INCOMPLETE_PRIOR_NAV", "OPEN");
      continue;
    }
    if (previous.valuation.status !== "COMPLETE") {
      issue(entry.symbol, "ENTRY_EXPIRED_STALE_PRIOR_NAV", "OPEN");
      continue;
    }
    const price = openPrice(prices.get(entry.symbol)?.open, input);
    if (!price) {
      issue(entry.symbol, "ENTRY_EXPIRED_MISSING_OPEN", "OPEN");
      continue;
    }
    const targetBudget = format(
      multiply(decimal(previous.valuation.nav), decimal(entry.entryWeight)),
    );
    const quote = quoteModelBudget(targetBudget, format(cash), price.price);
    if (quote.quantity === "0") {
      issue(entry.symbol, "ENTRY_EXPIRED_INSUFFICIENT_BUDGET", "OPEN");
      continue;
    }
    cash = decimal(quote.remainingCash);
    fees += decimal(quote.fee);
    positions.push({
      symbol: entry.symbol,
      quantity: quote.quantity,
      entryDate: input.sessionDate,
      originDate: entry.originDate,
      confirmationDate: entry.confirmationDate,
      entryPrice: price.price,
      costBasis: quote.debit,
      mark: null,
    });
    fills.push({
      symbol: entry.symbol,
      side: "BUY",
      executionDate: input.sessionDate,
      executionAt: input.openAt,
      priceAsOfDate: price.asOfDate,
      priceSourceHash: price.sourceHash,
      signalDate: entry.confirmationDate,
      signalSourceHash: entry.sourceHash,
      originDate: entry.originDate,
      reason: "CONFIRM1",
      quantity: quote.quantity,
      price: price.price,
      gross: quote.gross,
      fee: quote.fee,
      cashDelta: format(-decimal(quote.debit)),
      targetBudget,
      budgetNavDate: previous.valuation.asOfDate,
      realizedPnl: null,
    });
  }

  const pendingEntries: EtfShadowPendingEntry[] = [],
    pendingConfirmations: EtfAdoptedShadowState["pendingConfirmations"] = [];
  const currentSignals = new Map<string, EtfShadowSignal>();
  for (const signal of input.closeSignals) {
    const s = signal.strategy;
    if (
      s.date !== input.sessionDate ||
      (s.previousDate !== null && (!validDate(s.previousDate) || s.previousDate >= s.date)) ||
      (previous.lastSessionDate !== null && s.previousDate !== previous.lastSessionDate)
    ) {
      issue(signal.symbol, "SIGNAL_DATE_MISMATCH", "CLOSE");
      continue;
    }
    const signalReady = nextMorning
      ? isKrOfficialShadowDecision(s.date, signal.availableAt, input.closeAt)
      : marketDate(signal.availableAt) === s.date && time(signal.availableAt) <= closeAt;
    if (!signalReady) {
      issue(signal.symbol, "SIGNAL_UNAVAILABLE_AT_CLOSE", "CLOSE");
      continue;
    }
    if (s.version !== ETF_POLICY.version || s.dataStatus === "krx_batch_pending") {
      issue(signal.symbol, "SIGNAL_DATA_UNAVAILABLE", "CLOSE");
      continue;
    }
    currentSignals.set(signal.symbol, signal);
    if (
      s.exit === "MA60" &&
      positions.some((position) => position.symbol === signal.symbol) &&
      !pendingExits.some((exit) => exit.symbol === signal.symbol)
    )
      pendingExits.push({
        symbol: signal.symbol,
        signalDate: s.date,
        availableAt: signal.availableAt,
        sourceHash: signal.sourceHash,
        reason: "MA60",
      });
    if (s.exit === "DATA_UNAVAILABLE") issue(signal.symbol, "SIGNAL_DATA_UNAVAILABLE", "CLOSE");
    if (
      s.entryState === "pending" &&
      s.rawOnset &&
      s.originDate === s.date &&
      s.eligible &&
      s.score !== null &&
      Number.isFinite(s.score) &&
      s.score >= ETF_POLICY.entryScore &&
      s.previousScore !== null &&
      Number.isFinite(s.previousScore) &&
      s.previousScore < ETF_POLICY.entryScore
    )
      pendingConfirmations.push({ symbol: signal.symbol, originDate: s.date });
    if (s.entryState !== "confirmed" && !s.onset) continue;
    if (!s.originDate || s.originDate < series.accountingStartDate) {
      issue(signal.symbol, "SIGNAL_PRESTART_ORIGIN", "CLOSE");
      continue;
    }
    if (
      !previous.pendingConfirmations.some(
        (setup) => setup.symbol === signal.symbol && setup.originDate === s.originDate,
      ) ||
      s.originDate !== previous.lastSessionDate
    ) {
      issue(signal.symbol, "SIGNAL_UNOBSERVED_ORIGIN", "CLOSE");
      continue;
    }
    const weight = etfEntryWeight(s.annualVolatility);
    if (
      !s.eligible ||
      !s.onset ||
      s.entryState !== "confirmed" ||
      s.confirmationDate !== s.date ||
      s.exit !== null ||
      weight === null ||
      !Number.isFinite(s.averageTradingValue20) ||
      s.averageTradingValue20 === null ||
      s.averageTradingValue20 < 0 ||
      s.score === null ||
      !Number.isFinite(s.score) ||
      s.score < ETF_POLICY.entryScore ||
      s.previousScore === null ||
      !Number.isFinite(s.previousScore) ||
      s.previousScore < ETF_POLICY.entryScore ||
      s.underlyingClose === null ||
      s.underlyingMa60 === null ||
      !Number.isFinite(s.underlyingClose) ||
      !Number.isFinite(s.underlyingMa60) ||
      s.underlyingMa60 <= 0 ||
      s.underlyingClose < s.underlyingMa60 ||
      s.confirmationIssues.length
    ) {
      issue(signal.symbol, "SIGNAL_INVALID_CONFIRMATION", "CLOSE");
      continue;
    }
    // Same truncation as quoteEtfModelEntry; cash uses exact eight-decimal fixed point.
    const entryWeight = (Math.floor(weight * 1e8) / 1e8).toFixed(8);
    if (decimal(entryWeight) === 0n) {
      issue(signal.symbol, "SIGNAL_INVALID_CONFIRMATION", "CLOSE");
      continue;
    }
    pendingEntries.push({
      symbol: signal.symbol,
      originDate: s.originDate,
      confirmationDate: s.date,
      availableAt: signal.availableAt,
      sourceHash: signal.sourceHash,
      entryWeight,
      averageTradingValue20: s.averageTradingValue20,
    });
  }
  for (const position of positions) {
    if (!currentSignals.has(position.symbol))
      issue(position.symbol, "HELD_SIGNAL_MISSING", "CLOSE");
    const mark = prices.get(position.symbol)?.close;
    if (
      mark &&
      mark.price !== null &&
      mark.asOfDate <= input.sessionDate &&
      time(mark.availableAt) <= closeAt &&
      (!position.mark || mark.asOfDate >= position.mark.asOfDate)
    )
      position.mark = { ...mark, price: mark.price };
    if (!position.mark) issue(position.symbol, "MARK_MISSING", "CLOSE");
    else if (position.mark.asOfDate !== input.sessionDate)
      issue(position.symbol, "MARK_STALE", "CLOSE");
  }
  positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const valuation = valueAtClose(positions, format(cash), input.sessionDate);
  const state: EtfAdoptedShadowState = {
    ...previous,
    firstValidSessionDate: previous.firstValidSessionDate ?? input.sessionDate,
    lastSessionDate: input.sessionDate,
    lastCloseAt: input.closeAt,
    cash: format(cash),
    positions,
    pendingConfirmations,
    pendingEntries,
    pendingExits,
    valuation,
    cumulativeFees: format(decimal(previous.cumulativeFees) + fees),
    realizedPnl: format(decimal(previous.realizedPnl) + realizedPnl),
  };
  const record: EtfShadowDailyRecord = {
    receipt,
    calendarSourceHash: input.calendar.sourceHash,
    previousSessionDate: input.previousSessionDate,
    openAt: input.openAt,
    closeAt: input.closeAt,
    openingCash: previous.cash,
    priorCloseNav: previous.valuation.nav,
    priorCloseNavDate: previous.valuation.asOfDate,
    fills,
    issues,
    pendingConfirmations,
    pendingEntries,
    pendingExits,
    valuation,
    fees: format(fees),
    realizedPnl: format(realizedPnl),
  };
  return freeze({ state, record });
}

/**
 * Journal-ready boundary. Unlike the lower-level step, the receipt source hash binds
 * every supplied field and the prior run's full state/record hash. This is the API to
 * pair with append-only persistence. Hashes prove content consistency, not publisher
 * authenticity; persistence must still verify the authoritative stored predecessor.
 */
export async function stepAdoptedEtfSeries(
  series: FrozenModelSeries,
  input: EtfShadowSessionInput,
  previous: AdoptedEtfRun | null = null,
): Promise<{ status: "NEW" | "REUSE"; run: AdoptedEtfRun }> {
  await assertSeries(series);
  hash(input.sourceHash);
  if (previous) {
    assertModelSeriesIsolation(series, previous);
    const { stateHash, ...body } = previous;
    if (
      (await hashSeriesValue(body)) !== stateHash ||
      previous.receipt.contractHash !== series.contractHash ||
      previous.receipt.bookId !== series.bookId ||
      previous.receipt.codeHash !== series.codeHash ||
      previous.receipt.configHash !== series.configHash ||
      previous.receipt.date !== previous.result.state.lastSessionDate ||
      previous.receipt.date !== previous.result.record.valuation.asOfDate ||
      previous.calendar.sourceHash !== previous.result.record.calendarSourceHash ||
      canonicalSeriesJson(previous.receipt) !== canonicalSeriesJson(previous.result.record.receipt)
    )
      throw new Error("Prior ETF run/state/record provenance mismatch");
    assertState(series, previous.result.state);
    assertModelCalendarContinuation(series, previous.calendar, input.calendar);
  }
  const sameDate = previous?.receipt.date === input.sessionDate;
  const previousStateHash = sameDate ? previous.previousStateHash : (previous?.stateHash ?? null);
  const manifest = await hashSeriesValue({ input, previousStateHash });
  const guarded = await guardModelRun(
    series,
    {
      date: input.sessionDate,
      codeHash: input.codeHash,
      configHash: input.configHash,
      sourceHash: manifest,
    },
    sameDate ? previous.receipt : undefined,
  );
  if (guarded.status === "REUSE" && previous) return { status: "REUSE", run: previous };
  const state = previous?.result.state ?? (await initializeEtfAdoptedShadow(series));
  const result = await stepEtfAdoptedShadow(series, state, { ...input, sourceHash: manifest });
  const body = {
    book: "MODEL" as const,
    bookId: series.bookId,
    contractHash: series.contractHash,
    receipt: guarded.receipt,
    previousStateHash,
    calendar: { ...input.calendar, regularSessions: [...input.calendar.regularSessions] },
    result,
  };
  return { status: "NEW", run: freeze({ ...body, stateHash: await hashSeriesValue(body) }) };
}
