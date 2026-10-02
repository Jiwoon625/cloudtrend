import { decimal, divide, format, integerBudgetQuantity, multiply } from "./decimal";
import type { Currency, OpeningBalance } from "./types";
import { validDate } from "./validation";
import { ETF_POLICY, etfEntryWeight, type EtfStrategySnapshot } from "../engine/etfStrategy";
import { KOSPI_ENTRY_POLICY } from "../engine/kospiEntryConfirmation";
import { STRATEGY_CONFIG } from "../engine/operationalStrategy";
import {
  US_PROSPECTIVE_STRATEGIES,
  stepUsProspectivePortfolio,
  type UsModelExecutionPolicy,
  type UsPortfolioStepResult,
  type UsStrategyConfig,
} from "../engine/usProspectivePortfolio";
import type { UsProspectiveAnalysis } from "../engine/usProspective";

/** Additive comparison contracts only. No existing engine or historical book is migrated. */
export const ADOPTED_SERIES_VERSION = "adopted-shadow-2026-10-05-v1";
export const MODEL_ACCOUNTING_START = "2026-10-05";
export const MODEL_INITIAL_KRW = "100000000";
export const MODEL_ROUND_TRIP_COST = "0.003";
export const MODEL_ONE_WAY_COST = "0.0015";
export const KR_FIXED_BUDGET_END_EXCLUSIVE = "2027-10-05";
export const ADOPTED_SERIES_KINDS = [
  "KR_MIXED",
  "KR_KOSPI",
  "KR_KOSDAQ",
  "US_A0",
  "ETF_V02",
] as const;
export type AdoptedSeriesKind = (typeof ADOPTED_SERIES_KINDS)[number];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SeriesHash = `sha256:${string}`;

export interface InitialFxEvidence {
  base: "USD";
  quote: "KRW";
  rate: string;
  publishedDate: string;
  /** Unknown publication time stays null; verifiedAt is not a rate publication timestamp. */
  publishedAt: string | null;
  rateType: string;
  sourceUrl: string;
  evidenceId: string;
  verifiedAt: string;
  verified: boolean;
}
/** Official screenshot verified by the user; this is deliberately a dated baseline, not today's quote. */
export const VERIFIED_INITIAL_FX: InitialFxEvidence = Object.freeze({
  base: "USD",
  quote: "KRW",
  rate: "1359.60",
  publishedDate: "2026-10-02",
  publishedAt: null,
  rateType: "매매기준율",
  sourceUrl: "https://www.smbs.biz/ExRate/TodayExRate.jsp",
  evidenceId: "smbs-usdkrw-mar-2026-10-02-owner-verified",
  verifiedAt: "2026-10-02T15:36:09Z",
  verified: true,
});
export interface FxOpeningConversion {
  evidence: InitialFxEvidence;
  rounding: "FLOOR_USD_CENTS_KEEP_KRW_RESIDUAL";
  usdCash: string;
  convertedKrw: string;
  residualKrw: string;
}
export interface AdoptedSeriesPolicy {
  kind: AdoptedSeriesKind;
  market: "KR" | "US";
  currency: Currency;
  maxPositions: number;
  allocation:
    | "KR_INITIAL_CAPITAL_DIV_30_FIRST_YEAR"
    | "US_A0_QUARTERLY_UNCHANGED"
    | "ETF_V02_VOLATILITY_UNCHANGED";
  /** Mixed book counts all positions in a sector against the candidate market's cap. */
  sectorCapByCandidateMarket: { KOSPI: number; KOSDAQ: number } | null;
  allowedMarkets: string[];
  enginePolicy: Json;
}
export interface FrozenModelSeries {
  book: "MODEL";
  bookId: string;
  version: typeof ADOPTED_SERIES_VERSION;
  accountingStartDate: typeof MODEL_ACCOUNTING_START;
  initialKrw: typeof MODEL_INITIAL_KRW;
  roundTripCost: typeof MODEL_ROUND_TRIP_COST;
  oneWayCost: typeof MODEL_ONE_WAY_COST;
  policy: AdoptedSeriesPolicy;
  frozenAt: string;
  codeHash: SeriesHash;
  /** Initial source manifest; subsequent dated input manifests live on run receipts. */
  sourceHash: SeriesHash;
  configHash: SeriesHash;
  fx: FxOpeningConversion | null;
  contractHash: SeriesHash;
}

function assertHash(hash: string): asserts hash is SeriesHash {
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error("SHA-256 provenance hash required");
}
function assertDate(date: string) {
  if (!validDate(date)) throw new Error("Invalid series date");
}
function timestamp(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !validDate(value.slice(0, 10)) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Explicit timestamp with timezone required");
  return Date.parse(value);
}
/** Canonical JSON rejects lossy inputs; object insertion order never changes reuse identity. */
export function canonicalSeriesJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalSeriesJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSeriesJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  throw new Error("Series provenance must contain plain finite JSON values");
}
export async function hashSeriesValue(value: unknown): Promise<SeriesHash> {
  const bytes = new TextEncoder().encode(canonicalSeriesJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function policyFor(kind: AdoptedSeriesKind): AdoptedSeriesPolicy {
  if (!(ADOPTED_SERIES_KINDS as readonly string[]).includes(kind))
    throw new Error(
      "Only newly adopted series may be initialized; alternative and historical series are immutable",
    );
  if (kind === "US_A0") {
    const a0 = US_PROSPECTIVE_STRATEGIES.find((strategy) => strategy.id === "A0_QUARTER_PRIMARY");
    if (!a0 || !a0.quarterlyRebalance) throw new Error("Adopted A0 quarterly policy unavailable");
    return {
      kind,
      market: "US",
      currency: "USD",
      maxPositions: 20,
      allocation: "US_A0_QUARTERLY_UNCHANGED",
      sectorCapByCandidateMarket: null,
      allowedMarkets: ["US"],
      enginePolicy: JSON.parse(JSON.stringify(a0)) as Json,
    };
  }
  if (kind === "ETF_V02")
    return {
      kind,
      market: "KR",
      currency: "KRW",
      maxPositions: ETF_POLICY.maxPositions,
      allocation: "ETF_V02_VOLATILITY_UNCHANGED",
      sectorCapByCandidateMarket: null,
      allowedMarkets: ["ETF"],
      enginePolicy: JSON.parse(JSON.stringify(ETF_POLICY)) as Json,
    };
  return {
    kind,
    market: "KR",
    currency: "KRW",
    maxPositions: 30,
    allocation: "KR_INITIAL_CAPITAL_DIV_30_FIRST_YEAR",
    sectorCapByCandidateMarket: { KOSPI: 3, KOSDAQ: 6 },
    allowedMarkets:
      kind === "KR_MIXED" ? ["KOSPI", "KOSDAQ"] : [kind === "KR_KOSPI" ? "KOSPI" : "KOSDAQ"],
    enginePolicy: JSON.parse(
      JSON.stringify({ operational: STRATEGY_CONFIG, kospiEntry: KOSPI_ENTRY_POLICY }),
    ) as Json,
  };
}

export function convertOfficialInitialFx(evidence: InitialFxEvidence): FxOpeningConversion {
  // This dated first-series baseline is a verified fact, not a live-rate fallback.
  if (
    !evidence ||
    !evidence.verified ||
    evidence.base !== "USD" ||
    evidence.quote !== "KRW" ||
    evidence.publishedDate !== "2026-10-02" ||
    decimal(evidence.rate) !== decimal("1359.60") ||
    evidence.sourceUrl !== "https://www.smbs.biz/ExRate/TodayExRate.jsp" ||
    evidence.rateType !== "매매기준율" ||
    !evidence.evidenceId.trim()
  )
    throw new Error("Verified official 2026-10-02 SMBS initial FX is required");
  const verified = timestamp(evidence.verifiedAt);
  if (
    verified < Date.parse("2026-10-02T00:00:00Z") ||
    verified >= Date.parse(`${MODEL_ACCOUNTING_START}T00:00:00Z`)
  )
    throw new Error("Initial FX verification must precede series start");
  if (
    evidence.publishedAt !== null &&
    (timestamp(evidence.publishedAt) > verified ||
      evidence.publishedAt.slice(0, 10) !== evidence.publishedDate)
  )
    throw new Error("FX publication timestamp conflicts with evidence");
  const usdEightDecimals = divide(decimal(MODEL_INITIAL_KRW), decimal(evidence.rate));
  const usd = (usdEightDecimals / decimal("0.01")) * decimal("0.01");
  const converted = multiply(usd, decimal(evidence.rate));
  return freeze({
    evidence: { ...evidence },
    rounding: "FLOOR_USD_CENTS_KEEP_KRW_RESIDUAL" as const,
    usdCash: format(usd),
    convertedKrw: format(converted),
    residualKrw: format(decimal(MODEL_INITIAL_KRW) - converted),
  });
}

export async function freezeAdoptedSeries(input: {
  kind: AdoptedSeriesKind;
  frozenAt: string;
  codeHash: string;
  sourceHash: string;
  initialFx?: InitialFxEvidence;
  existing?: FrozenModelSeries;
}): Promise<FrozenModelSeries> {
  assertHash(input.codeHash);
  assertHash(input.sourceHash);
  if (timestamp(input.frozenAt) >= Date.parse(`${MODEL_ACCOUNTING_START}T00:00:00Z`))
    throw new Error("New series contract must be frozen before accounting start");
  const policy = policyFor(input.kind);
  if (input.kind === "US_A0" && !input.initialFx)
    throw new Error("US initial FX missing; fail closed");
  if (input.kind !== "US_A0" && input.initialFx)
    throw new Error("FX baseline only belongs to the US series");
  const fx = input.initialFx ? convertOfficialInitialFx(input.initialFx) : null;
  if (fx && timestamp(fx.evidence.verifiedAt) > timestamp(input.frozenAt))
    throw new Error("FX evidence was not known when this contract was frozen");
  const configHash = await hashSeriesValue({
    policy,
    accountingStartDate: MODEL_ACCOUNTING_START,
    initialKrw: MODEL_INITIAL_KRW,
    roundTripCost: MODEL_ROUND_TRIP_COST,
    oneWayCost: MODEL_ONE_WAY_COST,
    krFixedBudgetEndExclusive: KR_FIXED_BUDGET_END_EXCLUSIVE,
    fx,
  });
  const body = {
    book: "MODEL" as const,
    bookId: `${ADOPTED_SERIES_VERSION}:${input.kind}`,
    version: ADOPTED_SERIES_VERSION as typeof ADOPTED_SERIES_VERSION,
    accountingStartDate: MODEL_ACCOUNTING_START as typeof MODEL_ACCOUNTING_START,
    initialKrw: MODEL_INITIAL_KRW as typeof MODEL_INITIAL_KRW,
    roundTripCost: MODEL_ROUND_TRIP_COST as typeof MODEL_ROUND_TRIP_COST,
    oneWayCost: MODEL_ONE_WAY_COST as typeof MODEL_ONE_WAY_COST,
    policy,
    frozenAt: input.frozenAt,
    codeHash: input.codeHash,
    sourceHash: input.sourceHash,
    configHash,
    fx,
  };
  const series = freeze({ ...body, contractHash: await hashSeriesValue(body) });
  if (input.existing) {
    await verifyFrozenSeries(input.existing);
    if (
      input.existing.bookId !== series.bookId ||
      input.existing.contractHash !== series.contractHash
    )
      throw new Error(
        "Existing series is immutable; changed source, code or config requires a separately authorized version",
      );
    return input.existing;
  }
  return series;
}
export async function verifyFrozenSeries(series: FrozenModelSeries): Promise<void> {
  const { contractHash, ...body } = series;
  assertHash(contractHash);
  assertHash(series.codeHash);
  assertHash(series.sourceHash);
  assertHash(series.configHash);
  if (
    series.book !== "MODEL" ||
    series.version !== ADOPTED_SERIES_VERSION ||
    series.bookId !== `${ADOPTED_SERIES_VERSION}:${series.policy.kind}` ||
    !(ADOPTED_SERIES_KINDS as readonly string[]).includes(series.policy.kind) ||
    series.accountingStartDate !== MODEL_ACCOUNTING_START ||
    series.initialKrw !== MODEL_INITIAL_KRW ||
    series.roundTripCost !== MODEL_ROUND_TRIP_COST ||
    series.oneWayCost !== MODEL_ONE_WAY_COST ||
    contractHash !== (await hashSeriesValue(body))
  )
    throw new Error("Frozen model contract mismatch");
}

export interface ModelOpeningState {
  book: "MODEL";
  bookId: string;
  contractHash: SeriesHash;
  accountingStartDate: string;
  firstValidSessionDate: null;
  cash: { KRW: string; USD: string };
  positions: Record<string, never>;
  pendingSignals: never[];
  openingBalances: OpeningBalance[];
}
export function initializeModelSeries(series: FrozenModelSeries): ModelOpeningState {
  const cash = series.fx
    ? { KRW: series.fx.residualKrw, USD: series.fx.usdCash }
    : { KRW: series.initialKrw, USD: "0" };
  const currencies: Currency[] = series.fx ? ["USD", "KRW"] : ["KRW"];
  return freeze({
    book: "MODEL",
    bookId: series.bookId,
    contractHash: series.contractHash,
    accountingStartDate: series.accountingStartDate,
    firstValidSessionDate: null,
    cash,
    positions: {},
    pendingSignals: [],
    openingBalances: currencies.map((currency) => ({
      book: "MODEL" as const,
      bookId: series.bookId,
      accountId: `${series.bookId}:${currency}`,
      currency,
      date: series.accountingStartDate,
      cash: cash[currency],
      positions: [],
      complete: true,
      source: {
        system: "model" as const,
        recordId: `${series.bookId}:opening:${currency}`,
        revision: "1",
        contentHash: series.contractHash,
      },
    })),
  });
}
export function assertModelSeriesIsolation(
  series: FrozenModelSeries,
  state: { book: string; bookId: string; contractHash: string },
) {
  if (
    state.book !== "MODEL" ||
    state.bookId !== series.bookId ||
    state.contractHash !== series.contractHash
  )
    throw new Error("Actual, alternative, and other model state cannot enter this series");
}

export interface ModelCalendar {
  market: "KR" | "US";
  sourceHash: SeriesHash;
  coverageStart: string;
  coverageEnd: string;
  /** Complete regular-session calendar for the declared coverage, not per-symbol bars. */
  regularSessions: string[];
}
function calendarSessions(series: FrozenModelSeries, calendar: ModelCalendar) {
  assertHash(calendar.sourceHash);
  assertDate(calendar.coverageStart);
  assertDate(calendar.coverageEnd);
  if (
    calendar.market !== series.policy.market ||
    calendar.coverageStart > series.accountingStartDate ||
    calendar.coverageEnd < series.accountingStartDate ||
    calendar.coverageStart > calendar.coverageEnd
  )
    throw new Error("Market calendar must cover accounting start");
  if (new Set(calendar.regularSessions).size !== calendar.regularSessions.length)
    throw new Error("Duplicate market session");
  for (const date of calendar.regularSessions) {
    assertDate(date);
    if (date < calendar.coverageStart || date > calendar.coverageEnd)
      throw new Error("Session outside calendar coverage");
  }
  return [...calendar.regularSessions].sort();
}
/** Calendar extensions are allowed; previously frozen coverage cannot shrink or be rewritten. */
export function assertModelCalendarContinuation(
  series: FrozenModelSeries,
  previous: ModelCalendar,
  next: ModelCalendar,
) {
  const before = calendarSessions(series, previous),
    after = calendarSessions(series, next);
  if (
    next.coverageStart > previous.coverageStart ||
    next.coverageEnd < previous.coverageEnd ||
    canonicalSeriesJson(before) !==
      canonicalSeriesJson(
        after.filter((d) => d >= previous.coverageStart && d <= previous.coverageEnd),
      )
  )
    throw new Error(
      "Frozen calendar coverage changed; regular sessions cannot be removed or inserted retrospectively",
    );
}
export function firstModelSession(
  series: FrozenModelSeries,
  calendar: ModelCalendar,
): string | null {
  return (
    calendarSessions(series, calendar).find((date) => date >= series.accountingStartDate) ?? null
  );
}
export interface DatedModelObservation {
  date: string;
  availableAt: string;
  sourceHash: SeriesHash;
}
/** Pre-start records remain indicator warmup only; this function never carries engine pending state. */
export function partitionModelObservations<T extends DatedModelObservation>(
  series: FrozenModelSeries,
  observations: readonly T[],
  asOfDate: string,
  decisionAt: string,
): { warmup: T[]; active: T[]; excludedFuture: T[] } {
  assertDate(asOfDate);
  const cutoff = timestamp(decisionAt);
  const warmup: T[] = [],
    active: T[] = [],
    excludedFuture: T[] = [];
  for (const observation of observations) {
    assertDate(observation.date);
    assertHash(observation.sourceHash);
    if (observation.date > asOfDate || timestamp(observation.availableAt) > cutoff)
      excludedFuture.push(observation);
    else if (observation.date < series.accountingStartDate) warmup.push(observation);
    else active.push(observation);
  }
  return { warmup, active, excludedFuture };
}
function marketDateAt(series: FrozenModelSeries, at: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: series.policy.market === "KR" ? "Asia/Seoul" : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp(at)));
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export interface ModelSignal {
  originDate: string;
  signalDate: string;
  availableAt: string;
}
export function isActionableModelSignal(
  series: FrozenModelSeries,
  signal: ModelSignal,
  asOfDate: string,
  decisionAt: string,
): boolean {
  assertDate(signal.originDate);
  assertDate(signal.signalDate);
  assertDate(asOfDate);
  return (
    signal.originDate >= series.accountingStartDate &&
    signal.signalDate >= signal.originDate &&
    signal.signalDate === asOfDate &&
    marketDateAt(series, decisionAt) === signal.signalDate &&
    marketDateAt(series, signal.availableAt) === signal.signalDate &&
    timestamp(signal.availableAt) <= timestamp(decisionAt)
  );
}
export function nextModelExecutionSession(
  series: FrozenModelSeries,
  signal: ModelSignal,
  calendar: ModelCalendar,
  asOfDate: string,
  decisionAt: string,
): string | null {
  if (!isActionableModelSignal(series, signal, asOfDate, decisionAt)) return null;
  const sessions = calendarSessions(series, calendar);
  if (!sessions.includes(signal.signalDate) || !sessions.includes(signal.originDate))
    throw new Error("Signal origin and confirmation require regular market sessions");
  return sessions.find((date) => date > signal.signalDate) ?? null;
}

export interface ModelRunReceipt {
  book: "MODEL";
  bookId: string;
  date: string;
  contractHash: SeriesHash;
  codeHash: SeriesHash;
  configHash: SeriesHash;
  sourceHash: SeriesHash;
  runHash: SeriesHash;
}
/** A persistence adapter must enforce unique(bookId,date) atomically; this pure guard cannot lock a DB. */
export async function guardModelRun(
  series: FrozenModelSeries,
  input: { date: string; codeHash: string; configHash: string; sourceHash: string },
  existing?: ModelRunReceipt,
): Promise<{ status: "NEW" | "REUSE"; receipt: ModelRunReceipt }> {
  await verifyFrozenSeries(series);
  assertDate(input.date);
  assertHash(input.codeHash);
  assertHash(input.configHash);
  assertHash(input.sourceHash);
  if (input.date < series.accountingStartDate)
    throw new Error("Pre-start history is warmup, never a model run");
  if (input.codeHash !== series.codeHash || input.configHash !== series.configHash)
    throw new Error("Frozen code/config changed; stop this series");
  const body = {
    book: "MODEL" as const,
    bookId: series.bookId,
    date: input.date,
    contractHash: series.contractHash,
    codeHash: input.codeHash,
    configHash: input.configHash,
    sourceHash: input.sourceHash,
  };
  const receipt = freeze({ ...body, runHash: await hashSeriesValue(body) });
  if (existing) {
    if (canonicalSeriesJson(existing) !== canonicalSeriesJson(receipt))
      throw new Error(
        "Same-date model run has changed provenance; no overwrite or implicit replay",
      );
    return { status: "REUSE", receipt: existing };
  }
  return { status: "NEW", receipt };
}

export function krInitialSlotBudget(series: FrozenModelSeries, date: string): string {
  assertDate(date);
  if (series.policy.allocation !== "KR_INITIAL_CAPITAL_DIV_30_FIRST_YEAR")
    throw new Error("KR first-year sizing must not replace US quarterly or ETF volatility sizing");
  if (date < series.accountingStartDate || date >= KR_FIXED_BUDGET_END_EXCLUSIVE)
    throw new Error("KR fixed-capital first-year boundary; later sizing is not specified");
  return format(divide(decimal(series.initialKrw), decimal("30")));
}
export function krSlotCapacity(
  series: FrozenModelSeries,
  candidateMarket: "KOSPI" | "KOSDAQ",
  sectorCode: string,
  holdings: ReadonlyArray<{ market: "KOSPI" | "KOSDAQ"; sectorCode: string }>,
): boolean {
  if (
    series.policy.allocation !== "KR_INITIAL_CAPITAL_DIV_30_FIRST_YEAR" ||
    !series.policy.allowedMarkets.includes(candidateMarket) ||
    !sectorCode.trim()
  )
    throw new Error("Candidate does not belong to this KR series");
  if (
    holdings.some(
      (holding) =>
        !series.policy.allowedMarkets.includes(holding.market) || !holding.sectorCode.trim(),
    )
  )
    throw new Error("Holdings do not belong to this KR series");
  return (
    holdings.length < series.policy.maxPositions &&
    holdings.filter((holding) => holding.sectorCode === sectorCode).length <
      series.policy.sectorCapByCandidateMarket![candidateMarket]
  );
}
export interface ModelBudgetQuote {
  budget: string;
  quantity: string;
  gross: string;
  fee: string;
  debit: string;
  remainingCash: string;
}
/** Eight-decimal fee ledger with ceiling at the final fee digit prevents fractional-fee overspend. */
export function quoteModelBudget(budget: string, cash: string, price: string): ModelBudgetQuote {
  const quantity = integerBudgetQuantity(budget, cash, price, MODEL_ONE_WAY_COST);
  const gross = decimal(price) * BigInt(quantity);
  const scale = decimal("1");
  const fee = (gross * decimal(MODEL_ONE_WAY_COST) + scale - 1n) / scale;
  const debit = gross + fee;
  return {
    budget,
    quantity,
    gross: format(gross),
    fee: format(fee),
    debit: format(debit),
    remainingCash: format(decimal(cash) - debit),
  };
}
export function quoteKrModelEntry(
  series: FrozenModelSeries,
  input: { date: string; cash: string; price: string },
): ModelBudgetQuote {
  return quoteModelBudget(krInitialSlotBudget(series, input.date), input.cash, input.price);
}
/** Reuses the adopted v0.2 volatility formula. It is a single-candidate sizing adapter, not an executor. */
export function quoteEtfModelEntry(
  series: FrozenModelSeries,
  input: {
    asOfDate: string;
    decisionAt: string;
    availableAt: string;
    equity: string;
    cash: string;
    price: string;
    strategy: EtfStrategySnapshot;
  },
): ModelBudgetQuote | null {
  if (series.policy.kind !== "ETF_V02")
    throw new Error("ETF sizing requires its isolated adopted series");
  const s = input.strategy;
  if (canonicalSeriesJson(series.policy.enginePolicy) !== canonicalSeriesJson(ETF_POLICY))
    throw new Error("ETF engine policy changed since freeze");
  if (
    !s.originDate ||
    !isActionableModelSignal(
      series,
      { originDate: s.originDate, signalDate: s.date, availableAt: input.availableAt },
      input.asOfDate,
      input.decisionAt,
    ) ||
    s.date !== input.asOfDate ||
    s.version !== ETF_POLICY.version ||
    !s.eligible ||
    !s.onset ||
    s.entryState !== "confirmed" ||
    s.confirmationDate !== s.date ||
    s.dataStatus === "krx_batch_pending" ||
    s.averageTradingValue20 === null ||
    !Number.isFinite(s.averageTradingValue20) ||
    s.averageTradingValue20 < 0
  )
    return null;
  const weight = etfEntryWeight(s.annualVolatility);
  if (weight === null) return null;
  const equity = decimal(input.equity),
    cash = decimal(input.cash);
  if (equity <= 0n || cash < 0n || cash > equity) throw new Error("Invalid ETF account value");
  // Preserve the engine's formula; truncate only at the exact-money boundary, never round shares up.
  const fixedWeight = decimal((Math.floor(weight * 1e8) / 1e8).toFixed(8));
  const target = multiply(equity, fixedWeight);
  return quoteModelBudget(format(target < cash ? target : cash), input.cash, input.price);
}
export function modelEngineAdapterStatus(series: FrozenModelSeries): {
  status: "BLOCKED" | "SIZING_ONLY" | "PURE_EXECUTOR";
  reasons: string[];
} {
  if (series.policy.kind === "US_A0")
    return {
      status: "PURE_EXECUTOR",
      reasons: [
        "Opt-in A0 executor uses frozen cash/costs, exact cash/fees and provenance guards; legacy defaults are unchanged",
        "Persistence, production scheduling and journal projection are not wired",
      ],
    };
  if (series.policy.kind === "ETF_V02")
    return {
      status: "PURE_EXECUTOR",
      reasons: [
        "Isolated ETF v0.2 confirm1 executor, exact cash/fees, dated marks and pending state are implemented; production scheduling is not enabled",
      ],
    };
  return {
    status: "PURE_EXECUTOR",
    reasons: [
      "Opt-in KR replay uses frozen immutable input prefixes, initial-capital/30 fee-inclusive sizing and start boundaries",
      "Production data ingestion, migration and scheduling require separate verification and rollout",
    ],
  };
}

export interface AdoptedUsRun {
  book: "MODEL";
  bookId: string;
  contractHash: SeriesHash;
  receipt: ModelRunReceipt;
  previousStateHash: SeriesHash | null;
  calendar: ModelCalendar;
  result: UsPortfolioStepResult;
  stateHash: SeriesHash;
}
/** Reusable pure A0 executor. The caller supplies point-in-time analysis and a complete US calendar.
 * No network, database writes, scheduler, historical replay rewrite, or execution venue is involved.
 */
export async function stepAdoptedUsSeries(
  series: FrozenModelSeries,
  input: {
    analysis: UsProspectiveAnalysis;
    sourceHash: string;
    codeHash: string;
    configHash: string;
    availableAt: string;
    decisionAt: string;
    calendar: ModelCalendar;
  },
  previous: AdoptedUsRun | null = null,
): Promise<{ status: "NEW" | "REUSE"; run: AdoptedUsRun }> {
  await verifyFrozenSeries(series);
  if (series.policy.kind !== "US_A0" || !series.fx)
    throw new Error("Only the isolated adopted US A0 series may use this executor");
  assertHash(input.sourceHash);
  const date = input.analysis.date;
  assertDate(date);
  if (timestamp(input.availableAt) > timestamp(input.decisionAt))
    throw new Error("US analysis was not yet available at this decision");
  if (
    marketDateAt(series, input.availableAt) !== date ||
    marketDateAt(series, input.decisionAt) !== date
  )
    throw new Error(
      "US analysis and decision must belong to the same market session; late data cannot create retrospective trades",
    );
  if (
    date < series.accountingStartDate ||
    input.analysis.rows.length === 0 ||
    input.analysis.rows.some((row) => row.date !== date) ||
    new Set(input.analysis.rows.map((row) => row.symbol)).size !== input.analysis.rows.length
  )
    throw new Error("US analysis must contain unique symbols at one post-start date");
  const sessions = calendarSessions(series, input.calendar);
  if (!sessions.includes(date))
    throw new Error("US analysis requires a verified regular market session");
  if (previous) {
    assertModelSeriesIsolation(series, previous);
    assertModelCalendarContinuation(series, previous.calendar, input.calendar);
    const { stateHash, ...body } = previous;
    if (
      stateHash !== (await hashSeriesValue(body)) ||
      previous.receipt.contractHash !== series.contractHash ||
      previous.receipt.date !== previous.result.state.lastDate
    )
      throw new Error("Prior US run/state provenance mismatch");
  }
  const sameDate = previous?.receipt.date === date;
  const priorStateHash = sameDate ? previous.previousStateHash : (previous?.stateHash ?? null);
  // Bind the actual payload, calendar and predecessor, not just a caller's declared source hash.
  const inputManifestHash = await hashSeriesValue({
    upstreamSourceHash: input.sourceHash,
    analysis: input.analysis,
    calendar: input.calendar,
    availableAt: input.availableAt,
    priorStateHash,
  });
  const guarded = await guardModelRun(
    series,
    { date, codeHash: input.codeHash, configHash: input.configHash, sourceHash: inputManifestHash },
    sameDate ? previous.receipt : undefined,
  );
  if (guarded.status === "REUSE" && previous) return { status: "REUSE", run: previous };
  const expected = previous
    ? sessions.find((session) => session > previous.receipt.date)
    : firstModelSession(series, input.calendar);
  if (date !== expected)
    throw new Error(
      "US model requires the next regular session; missing sessions cannot be silently skipped",
    );
  const policy: UsModelExecutionPolicy = {
    version: "isolated-us-model-v1",
    bookId: series.bookId,
    contractHash: series.contractHash,
    accountingStartDate: series.accountingStartDate,
    initialCapital: series.fx.usdCash,
    oneWayCost: series.oneWayCost,
  };
  const config = series.policy.enginePolicy as unknown as UsStrategyConfig;
  const result = stepUsProspectivePortfolio(
    config,
    input.analysis,
    previous?.result.state ?? null,
    previous?.result.nav ?? null,
    policy,
  );
  const body = {
    book: "MODEL" as const,
    bookId: series.bookId,
    contractHash: series.contractHash,
    receipt: guarded.receipt,
    previousStateHash: priorStateHash,
    calendar: structuredClone(input.calendar),
    result,
  };
  return { status: "NEW", run: freeze({ ...body, stateHash: await hashSeriesValue(body) }) };
}
