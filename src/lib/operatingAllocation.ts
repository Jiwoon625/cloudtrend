import { z } from "zod";
import {
  decimal,
  divide,
  exactNotionalFee,
  format,
  integerBudgetQuantity,
  multiply,
} from "./ledger/decimal";
import { validDate } from "./ledger/date";

/** Approved allocation is a sizing policy. It cannot create cash, fills or FX. */
export const OPERATING_ALLOCATION_VERSION = "actual-s06-20261012-v1" as const;
export const OPERATING_ALLOCATION_START = "2026-10-12" as const;
export const OPERATING_ALLOCATION_ERRORS = {
  input: "배정·예약 입력을 확인하세요.",
  auth: "로그인 세션을 확인하세요.",
  missing: "기존 실제 원장이 필요합니다. 배정계획으로 원장을 만들지 않습니다.",
  conflict: "원장이 변경되었습니다. 실제 현금과 예약을 다시 대조해 주세요.",
  invalid: "저장된 배정·예약 계약을 검증하지 못했습니다.",
  funding: "실제 배정 현금이 미확정입니다. 계획금액을 현금으로 사용할 수 없습니다.",
  reconcile: "실제 체결·현금이 변경되었습니다. 시장별 현금 귀속을 다시 확인해 주세요.",
  uncertain: "저장 결과를 확인하지 못했습니다. 재저장 전에 최신 원장을 확인하세요.",
  generic: "배정·예약을 처리하지 못했습니다. 최신 원장을 확인해 주세요.",
} as const;
export function operatingAllocationErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return (
    Object.values(OPERATING_ALLOCATION_ERRORS).find((value) => value === message) ??
    OPERATING_ALLOCATION_ERRORS.generic
  );
}
const amountPattern = /^\d{1,18}(?:\.\d{1,8})?$/;
export const allocationAmountSchema = z
  .string()
  .regex(amountPattern)
  .refine((value) => amountPattern.test(value) && format(decimal(value)) === value);
const positiveAmount = allocationAmountSchema.refine(
  (value) => amountPattern.test(value) && decimal(value) > 0n,
);
const date = z.string().refine(validDate);
const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) => validDate(value.slice(0, 10)));
const reference = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine((value) => !/https?:\/\/|[\r\n]/i.test(value));
const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const currency = z.enum(["KRW", "USD"]);
const market = z.enum(["KR", "ETF", "US"]);
export type OperatingMarket = z.infer<typeof market>;
export type OperatingCurrency = z.infer<typeof currency>;
export const operatingAllocationSchema = z
  .object({
    version: z.literal(OPERATING_ALLOCATION_VERSION),
    startDate: z.literal(OPERATING_ALLOCATION_START),
    candidateId: z.literal("S06"),
    totalKrw: z.literal("30000000"),
    weights: z
      .object({ KR: z.literal("0.4"), ETF: z.literal("0.2"), US: z.literal("0.4") })
      .strict(),
    plannedKrw: z
      .object({ KR: z.literal("12000000"), ETF: z.literal("6000000"), US: z.literal("12000000") })
      .strict(),
    actualFunding: z.null(),
    usdSizingBasis: z.null(),
    rebalanceHoldings: z.literal(false),
    monthlyOptimization: z.literal(false),
    recordedAt: timestamp,
  })
  .strict();
export type OperatingAllocation = z.infer<typeof operatingAllocationSchema>;
export function prepareOperatingAllocation(recordedAt: string): OperatingAllocation {
  return operatingAllocationSchema.parse({
    version: OPERATING_ALLOCATION_VERSION,
    startDate: OPERATING_ALLOCATION_START,
    candidateId: "S06",
    totalKrw: "30000000",
    weights: { KR: "0.4", ETF: "0.2", US: "0.4" },
    plannedKrw: { KR: "12000000", ETF: "6000000", US: "12000000" },
    actualFunding: null,
    usdSizingBasis: null,
    rebalanceHoldings: false,
    monthlyOptimization: false,
    recordedAt: new Date(recordedAt).toISOString(),
  });
}
export function readOperatingAllocation(value: unknown): OperatingAllocation | null {
  if (value === undefined) return null;
  const result = operatingAllocationSchema.safeParse(value);
  if (!result.success) throw new Error(OPERATING_ALLOCATION_ERRORS.invalid);
  return result.data;
}
export const operatingClaimsSchema = z
  .object({
    KR: allocationAmountSchema,
    ETF: allocationAmountSchema,
    US: allocationAmountSchema,
    UNASSIGNED: allocationAmountSchema,
  })
  .strict();
export const spendableCashSchema = z
  .object({ amount: allocationAmountSchema, availableAt: timestamp, reference })
  .strict();
export const operatingSecuritySchema = z
  .object({
    symbol: z.string().min(1).max(64),
    venue: z.enum(["KOSPI", "KOSDAQ", "ETF", "US"]),
    sector: z.string().max(200),
    sectorCode: z.string().max(100).nullable(),
    originDate: date,
    decisionDate: date,
    sourceDate: date,
    sourceFingerprint: fingerprint,
  })
  .strict()
  .refine(
    (security) =>
      security.originDate <= security.decisionDate && security.decisionDate <= security.sourceDate,
    "Signal provenance dates must be causal",
  );
export type OperatingSecurity = z.infer<typeof operatingSecuritySchema>;
export const operatingReservationSchema = z
  .object({
    id: reference,
    signalId: reference,
    market,
    currency,
    amount: positiveAmount,
    signalBudgetId: reference,
    security: operatingSecuritySchema.optional(),
  })
  .strict();
export type OperatingReservation = z.infer<typeof operatingReservationSchema>;
export const operatingCashAuthoritySchema = z
  .object({
    version: z.literal(1),
    currency,
    sourceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sourceFingerprint: fingerprint,
    cashAtReview: allocationAmountSchema,
    claims: operatingClaimsSchema,
    spendableCash: spendableCashSchema.nullable(),
    reservations: z.array(operatingReservationSchema).max(1000),
    reviewedAt: timestamp,
  })
  .strict();
export type OperatingCashAuthority = z.infer<typeof operatingCashAuthoritySchema>;
export const operatingCashHistorySchema = z.array(
  z
    .object({ authority: operatingCashAuthoritySchema, economicSourceFingerprint: fingerprint })
    .strict(),
);
export type OperatingCashHistory = z.infer<typeof operatingCashHistorySchema>;
export function readOperatingCashAuthority(value: unknown): OperatingCashAuthority | null {
  if (value === undefined) return null;
  const result = operatingCashAuthoritySchema.safeParse(value);
  if (!result.success) throw new Error(OPERATING_ALLOCATION_ERRORS.invalid);
  validateOperatingCashAuthority(result.data);
  return result.data;
}
const marketsFor = (value: OperatingCurrency): OperatingMarket[] =>
  value === "KRW" ? ["KR", "ETF"] : ["US"];
/** Claims partition physical cash. Reservations encumber claims; they are not a second cash debit. */
export function validateOperatingCashAuthority(value: OperatingCashAuthority): void {
  const state = operatingCashAuthoritySchema.parse(value);
  const markets = marketsFor(state.currency);
  const total = Object.values(state.claims).reduce((sum, value) => sum + decimal(value), 0n);
  if (total !== decimal(state.cashAtReview))
    throw new Error("Cash claims must equal physical currency cash exactly");
  for (const asset of ["KR", "ETF", "US"] as const)
    if (!markets.includes(asset) && decimal(state.claims[asset]) !== 0n)
      throw new Error("Cash claim crosses currencies");
  if (
    state.spendableCash &&
    (decimal(state.spendableCash.amount) > total ||
      Date.parse(state.spendableCash.availableAt) > Date.parse(state.reviewedAt))
  )
    throw new Error("Invalid or future spendable cash evidence");
  const ids = new Set<string>(),
    signals = new Set<string>();
  const reserved = { KR: 0n, ETF: 0n, US: 0n };
  for (const reservation of state.reservations) {
    if (reservation.currency !== state.currency || !markets.includes(reservation.market))
      throw new Error("Reservation crosses currencies");
    if (
      reservation.security &&
      (reservation.security.venue === "US"
        ? "US"
        : reservation.security.venue === "ETF"
          ? "ETF"
          : "KR") !== reservation.market
    )
      throw new Error("Reservation security differs from its market");
    if (ids.has(reservation.id) || signals.has(reservation.signalId))
      throw new Error("Duplicate cash reservation or signal");
    ids.add(reservation.id);
    signals.add(reservation.signalId);
    reserved[reservation.market] += decimal(reservation.amount);
  }
  for (const asset of markets)
    if (reserved[asset] > decimal(state.claims[asset]))
      throw new Error("Reservation exceeds market cash claim");
  const totalReserved = Object.values(reserved).reduce((sum, value) => sum + value, 0n);
  if (state.spendableCash && totalReserved > decimal(state.spendableCash.amount))
    throw new Error("Reservations exceed confirmed spendable cash");
}
export function projectOperatingAvailability(input: {
  currency: OperatingCurrency;
  cash: string | null;
  sourceFingerprint: string;
  authority: OperatingCashAuthority | null;
}) {
  const blank = { KR: null, ETF: null, US: null } as Record<OperatingMarket, string | null>;
  if (input.cash === null)
    return { status: "FUNDING_PENDING" as const, available: blank, spendableAvailable: null };
  allocationAmountSchema.parse(input.cash);
  if (!input.authority)
    return { status: "CLAIMS_PENDING" as const, available: blank, spendableAvailable: null };
  const state = input.authority;
  validateOperatingCashAuthority(state);
  if (
    state.currency !== input.currency ||
    state.cashAtReview !== input.cash ||
    state.sourceFingerprint !== input.sourceFingerprint
  )
    return {
      status: "RECONCILIATION_REQUIRED" as const,
      available: blank,
      spendableAvailable: null,
    };
  let totalReserved = 0n;
  for (const asset of marketsFor(input.currency)) {
    const reserved = state.reservations
      .filter((r) => r.market === asset)
      .reduce((sum, r) => sum + decimal(r.amount), 0n);
    totalReserved += reserved;
    blank[asset] = format(decimal(state.claims[asset]) - reserved);
  }
  return {
    status: state.spendableCash ? ("CONFIRMED_CASH" as const) : ("ESTIMATED_CASH" as const),
    available: blank,
    spendableAvailable: state.spendableCash
      ? format(decimal(state.spendableCash.amount) - totalReserved)
      : null,
  };
}
/** Existing reservation identity is stable, including after a partial fill or year boundary. */
export function reserveOperatingCash(
  authority: OperatingCashAuthority,
  reservation: OperatingReservation,
): OperatingCashAuthority {
  validateOperatingCashAuthority(authority);
  operatingReservationSchema.parse(reservation);
  const previous = authority.reservations.find((r) => r.id === reservation.id);
  if (previous) {
    if (
      JSON.stringify(operatingReservationSchema.parse(previous)) !==
      JSON.stringify(operatingReservationSchema.parse(reservation))
    )
      throw new Error("Confirmed reservation is immutable");
    return structuredClone(authority);
  }
  const next = {
    ...structuredClone(authority),
    reservations: [...authority.reservations, structuredClone(reservation)],
  };
  validateOperatingCashAuthority(next);
  return next;
}

export const annualSizingSnapshotSchema = z
  .object({
    id: reference,
    market,
    currency,
    year: z.number().int().min(2026).max(9999),
    nav: positiveAmount,
    basis: z.enum(["APPROVED_INITIAL_NATIVE_ALLOCATION", "PRIOR_YEAR_MARKET_NAV"]),
    valuationDate: date,
    availableAt: timestamp,
    firstSessionAt: timestamp,
    sourceFingerprint: fingerprint,
    valuationComplete: z.literal(true),
    calendarEvidence: reference,
    nativeAllocationEvidence: reference.nullable(),
  })
  .strict();
export type AnnualSizingSnapshot = z.infer<typeof annualSizingSnapshotSchema>;
export const etfSizingSnapshotSchema = z
  .object({
    id: reference,
    market: z.literal("ETF"),
    currency: z.literal("KRW"),
    valuationDate: date,
    nav: allocationAmountSchema,
    cashClaim: allocationAmountSchema,
    holdingsValue: allocationAmountSchema,
    availableAt: timestamp,
    nextOpenAt: timestamp,
    sourceFingerprint: fingerprint,
    cashReviewFingerprint: fingerprint,
    calendarEvidence: reference,
  })
  .strict();
export type EtfSizingSnapshot = z.infer<typeof etfSizingSnapshotSchema>;
export function validateAnnualSizingSnapshot(snapshot: AnnualSizingSnapshot): void {
  annualSizingSnapshotSchema.parse(snapshot);
  if ((snapshot.market === "US" ? "USD" : "KRW") !== snapshot.currency)
    throw new Error("Annual NAV must use the market's native currency");
  if (Date.parse(snapshot.availableAt) >= Date.parse(snapshot.firstSessionAt))
    throw new Error("Annual NAV was not available before the first session");
  if (snapshot.firstSessionAt.slice(0, 4) !== String(snapshot.year))
    throw new Error("Annual sizing year mismatch");
  if (
    snapshot.basis === "PRIOR_YEAR_MARKET_NAV" &&
    snapshot.valuationDate.slice(0, 4) !== String(snapshot.year - 1)
  )
    throw new Error("Annual NAV must belong to the prior year");
  if (snapshot.basis === "APPROVED_INITIAL_NATIVE_ALLOCATION" && snapshot.year !== 2026)
    throw new Error("Initial allocation is only the first partial year");
  if (
    snapshot.basis === "APPROVED_INITIAL_NATIVE_ALLOCATION" &&
    snapshot.market === "US" &&
    snapshot.nativeAllocationEvidence === null
  )
    throw new Error(
      "Explicit native USD allocation evidence required; KRW plan or Shadow FX is not funding",
    );
  const availableLocalDate = new Date(snapshot.availableAt).toLocaleDateString("en-CA", {
    timeZone: snapshot.currency === "USD" ? "America/New_York" : "Asia/Seoul",
  });
  if (snapshot.valuationDate > availableLocalDate) throw new Error("Future annual NAV valuation");
}
export function freezeAnnualSizingSnapshot(
  existing: AnnualSizingSnapshot[],
  next: AnnualSizingSnapshot,
): AnnualSizingSnapshot[] {
  validateAnnualSizingSnapshot(next);
  existing.forEach(validateAnnualSizingSnapshot);
  const previous = existing.find((s) => s.market === next.market && s.year === next.year);
  if (previous) {
    if (
      Object.keys(previous).some(
        (key) =>
          previous[key as keyof AnnualSizingSnapshot] !== next[key as keyof AnnualSizingSnapshot],
      )
    )
      throw new Error("Annual sizing snapshot is immutable");
    return structuredClone(existing);
  }
  if (existing.some((s) => s.id === next.id)) throw new Error("Duplicate annual snapshot identity");
  return [...structuredClone(existing), structuredClone(next)];
}
export interface OperatingSignalBudget {
  id: string;
  annualSnapshotId: string;
  market: OperatingMarket;
  currency: OperatingCurrency;
  /** Original signal identity; the confirmation/decision date selects the annual basis. */
  signalDate: string;
  decisionDate?: string;
  amount: string;
  feeTreatment: "INCLUSIVE" | "GROSS_PLUS_FEE";
  etfWeight?: string | null;
  sourceFingerprint?: string;
  sizingBasis?: "ANNUAL" | "ETF_PRIOR_CLOSE_NAV";
  security?: OperatingSecurity | undefined;
}
/** O1 monthly cash movement never changes this signal-year snapshot or an existing budget. */
export function prepareOperatingSignalBudget(input: {
  id: string;
  snapshot: AnnualSizingSnapshot;
  signalDate: string;
  decisionDate?: string;
  etfWeight?: string;
  sourceFingerprint?: string;
}): OperatingSignalBudget {
  reference.parse(input.id);
  validateAnnualSizingSnapshot(input.snapshot);
  date.parse(input.signalDate);
  const { snapshot } = input;
  if (snapshot.market === "ETF")
    throw new Error("ETF requires its dated prior-close sleeve NAV, not an annual snapshot");
  const decisionDate = input.decisionDate ?? input.signalDate;
  date.parse(decisionDate);
  if (
    input.signalDate < OPERATING_ALLOCATION_START ||
    decisionDate < input.signalDate ||
    decisionDate < snapshot.firstSessionAt.slice(0, 10) ||
    decisionDate.slice(0, 4) !== String(snapshot.year)
  )
    throw new Error("Signal requires its own annual sizing snapshot");
  if (input.sourceFingerprint !== undefined) fingerprint.parse(input.sourceFingerprint);
  if (input.etfWeight !== undefined) throw new Error("Only ETF budgets accept a volatility weight");
  const amount = divide(decimal(snapshot.nav), decimal(snapshot.market === "KR" ? "30" : "20"));
  return {
    id: input.id,
    annualSnapshotId: snapshot.id,
    market: snapshot.market,
    currency: snapshot.currency,
    signalDate: input.signalDate,
    decisionDate,
    amount: format(amount),
    feeTreatment: snapshot.market === "US" ? "GROSS_PLUS_FEE" : "INCLUSIVE",
    etfWeight: input.etfWeight ?? null,
    sourceFingerprint: input.sourceFingerprint ?? snapshot.sourceFingerprint,
    sizingBasis: "ANNUAL",
  };
}

export function prepareEtfSignalBudget(input: {
  id: string;
  snapshot: EtfSizingSnapshot;
  signalDate: string;
  decisionDate: string;
  etfWeight: string;
  sourceFingerprint: string;
}): OperatingSignalBudget {
  const snapshot = etfSizingSnapshotSchema.parse(input.snapshot);
  reference.parse(input.id);
  date.parse(input.signalDate);
  date.parse(input.decisionDate);
  fingerprint.parse(input.sourceFingerprint);
  const weight = decimal(allocationAmountSchema.parse(input.etfWeight));
  if (weight <= 0n || weight > decimal("0.1")) throw new Error("Invalid ETF volatility weight");
  if (
    input.signalDate < OPERATING_ALLOCATION_START ||
    input.signalDate > input.decisionDate ||
    input.decisionDate !== snapshot.valuationDate ||
    Date.parse(snapshot.availableAt) >= Date.parse(snapshot.nextOpenAt) ||
    decimal(snapshot.nav) !== decimal(snapshot.cashClaim) + decimal(snapshot.holdingsValue)
  )
    throw new Error("Invalid causal ETF prior-close NAV");
  return {
    id: input.id,
    annualSnapshotId: snapshot.id,
    market: "ETF",
    currency: "KRW",
    signalDate: input.signalDate,
    decisionDate: input.decisionDate,
    amount: format(multiply(decimal(snapshot.nav), weight)),
    feeTreatment: "INCLUSIVE",
    etfWeight: input.etfWeight,
    sourceFingerprint: input.sourceFingerprint,
    sizingBasis: "ETF_PRIOR_CLOSE_NAV",
  };
}

const signalBudgetSchema = z
  .object({
    id: reference,
    annualSnapshotId: reference,
    market,
    currency,
    signalDate: date,
    decisionDate: date,
    amount: allocationAmountSchema,
    feeTreatment: z.enum(["INCLUSIVE", "GROSS_PLUS_FEE"]),
    etfWeight: allocationAmountSchema.nullable(),
    sourceFingerprint: fingerprint,
    sizingBasis: z.enum(["ANNUAL", "ETF_PRIOR_CLOSE_NAV"]).default("ANNUAL"),
    security: operatingSecuritySchema.optional(),
  })
  .strict();
const sizingSchema = z
  .object({
    version: z.literal(1),
    annualSnapshots: z.array(annualSizingSnapshotSchema).max(1000),
    signalBudgets: z.array(signalBudgetSchema).max(100_000),
    etfSnapshots: z.array(etfSizingSnapshotSchema).max(100_000).default([]),
  })
  .strict();
export type OperatingSizing = z.infer<typeof sizingSchema>;
export const operatingUsdSizingEvidenceSchema = z
  .object({
    amountUsd: positiveAmount,
    fundingEventIds: z
      .array(reference)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    confirmedAt: timestamp,
    reference,
    recordedAt: timestamp,
    fundingFingerprint: fingerprint,
    effectiveSessionDate: date,
    annualSnapshotId: reference,
  })
  .strict();
export type OperatingUsdSizingEvidence = z.infer<typeof operatingUsdSizingEvidenceSchema>;
export function readOperatingSizing(value: unknown): OperatingSizing {
  if (value === undefined)
    return { version: 1, annualSnapshots: [], signalBudgets: [], etfSnapshots: [] };
  const sizing = sizingSchema.parse(value);
  const years = new Set<string>(),
    snapshots = new Set<string>(),
    budgets = new Set<string>();
  for (const snapshot of sizing.annualSnapshots) {
    validateAnnualSizingSnapshot(snapshot);
    const key = `${snapshot.market}:${snapshot.year}`;
    if (years.has(key) || snapshots.has(snapshot.id))
      throw new Error("Duplicate annual sizing snapshot");
    years.add(key);
    snapshots.add(snapshot.id);
  }
  for (const snapshot of sizing.etfSnapshots) {
    if (
      snapshots.has(snapshot.id) ||
      decimal(snapshot.nav) !== decimal(snapshot.cashClaim) + decimal(snapshot.holdingsValue) ||
      Date.parse(snapshot.availableAt) >= Date.parse(snapshot.nextOpenAt)
    )
      throw new Error("Invalid or duplicate ETF NAV snapshot");
    snapshots.add(snapshot.id);
  }
  for (const budget of sizing.signalBudgets) {
    if (budgets.has(budget.id)) throw new Error("Duplicate signal budget");
    budgets.add(budget.id);
    if (
      budget.security &&
      (budget.security.originDate !== budget.signalDate ||
        budget.security.decisionDate !== budget.decisionDate ||
        budget.security.sourceFingerprint !== budget.sourceFingerprint ||
        (budget.security.venue === "US" ? "US" : budget.security.venue === "ETF" ? "ETF" : "KR") !==
          budget.market)
    )
      throw new Error("Stored signal security identity diverges from its budget");
    const snapshot = sizing.annualSnapshots.find(
      (snapshot) => snapshot.id === budget.annualSnapshotId,
    );
    const etfSnapshot = sizing.etfSnapshots.find(
      (snapshot) => snapshot.id === budget.annualSnapshotId,
    );
    if (
      budget.market === "ETF"
        ? !etfSnapshot || budget.sizingBasis !== "ETF_PRIOR_CLOSE_NAV"
        : !snapshot || snapshot.market !== budget.market || budget.sizingBasis !== "ANNUAL"
    )
      throw new Error("Signal budget annual snapshot missing");
    const expected =
      budget.market === "ETF"
        ? prepareEtfSignalBudget({
            id: budget.id,
            snapshot: etfSnapshot!,
            signalDate: budget.signalDate,
            decisionDate: budget.decisionDate,
            etfWeight: budget.etfWeight ?? "0",
            sourceFingerprint: budget.sourceFingerprint,
          })
        : prepareOperatingSignalBudget({
            id: budget.id,
            snapshot: snapshot!,
            signalDate: budget.signalDate,
            decisionDate: budget.decisionDate,
            ...(budget.etfWeight !== null ? { etfWeight: budget.etfWeight } : {}),
            sourceFingerprint: budget.sourceFingerprint,
          });
    if (
      Object.keys(budget).some(
        (key) =>
          key !== "security" &&
          budget[key as keyof typeof budget] !== expected[key as keyof OperatingSignalBudget],
      )
    )
      throw new Error("Stored signal budget diverges from its frozen annual basis");
  }
  return sizing;
}
export function pinOperatingSignalBudget(
  sizing: OperatingSizing,
  budget: OperatingSignalBudget,
): OperatingSizing {
  const previous = sizing.signalBudgets.find((b) => b.id === budget.id);
  if (previous) {
    if (
      JSON.stringify(signalBudgetSchema.parse(previous)) !==
      JSON.stringify(signalBudgetSchema.parse(budget))
    )
      throw new Error("Confirmed signal budget is immutable");
    return readOperatingSizing(sizing);
  }
  return readOperatingSizing({ ...sizing, signalBudgets: [...sizing.signalBudgets, budget] });
}
/** A close-price preview is always estimated. It does not create a reservation or broker order. */
export function operatingBudgetQuantity(input: {
  budget: OperatingSignalBudget;
  price: string;
  marketCash: string | null;
  currencyCash: string | null;
  oneWayCost?: string;
}) {
  if (input.marketCash === null || input.currencyCash === null)
    return {
      status: "BLOCKED" as const,
      quantity: null,
      gross: null,
      fee: null,
      cashRequired: null,
    };
  const budget = decimal(allocationAmountSchema.parse(input.budget.amount));
  const cash = [input.marketCash, input.currencyCash]
    .map((value) => decimal(allocationAmountSchema.parse(value)))
    .reduce((a, b) => (a < b ? a : b));
  const price = decimal(positiveAmount.parse(input.price)),
    cost = input.oneWayCost ?? "0.0015";
  const affordable = BigInt(integerBudgetQuantity(format(cash), format(cash), input.price, cost));
  const target =
    input.budget.feeTreatment === "INCLUSIVE"
      ? BigInt(integerBudgetQuantity(format(budget), format(cash), input.price, cost))
      : budget / price;
  const quantity = target < affordable ? target : affordable;
  const gross = quantity * price,
    fee = exactNotionalFee(gross, cost);
  return {
    status: "ESTIMATED" as const,
    quantity: quantity.toString(),
    gross: format(gross),
    fee: format(fee),
    cashRequired: format(gross + fee),
  };
}

const changeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CONFIRM_PLAN") }).strict(),
  z
    .object({
      kind: z.literal("REVIEW_CLAIMS"),
      claims: operatingClaimsSchema,
      // Legacy clients may send their clock; the server ignores it and stamps its own review
      // time. Persisted evidence still requires availableAt; this is not a cash event date.
      // Omitted by the cash-attribution-only UI; preserve existing private evidence.
      spendableCash: spendableCashSchema.partial({ availableAt: true }).nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("RESERVE"),
      reservation: operatingReservationSchema.omit({ security: true }),
    })
    .strict(),
  z.object({ kind: z.literal("RELEASE"), reservationId: reference }).strict(),
  z
    .object({
      kind: z.literal("CONFIRM_USD_SIZING"),
      amountUsd: positiveAmount,
      fundingEventIds: z
        .array(reference)
        .min(1)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length),
      confirmedAt: timestamp,
      reference,
    })
    .strict(),
  z
    .object({
      kind: z.literal("PIN_SIGNAL_BUDGET"),
      market: z.enum(["KOSPI", "KOSDAQ", "ETF", "US"]),
      symbol: z.string().min(1).max(64),
      signalOriginDate: date,
      sourceDate: date,
      reviewFingerprint: fingerprint.optional(),
    })
    .strict(),
]);
const common = { accessToken: z.string().min(1).max(16_000), currency };
const mutation = {
  ...common,
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().uuid(),
  change: changeSchema,
};
export const operatingAllocationRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("load") }).strict(),
  z.object({ ...mutation, action: z.literal("preview") }).strict(),
  z.object({ ...mutation, action: z.literal("save"), reviewConfirmed: z.literal(true) }).strict(),
]);
export type OperatingAllocationRequest = z.infer<typeof operatingAllocationRequestSchema>;
export function parseOperatingAllocationRequest(value: unknown): OperatingAllocationRequest {
  const result = operatingAllocationRequestSchema.safeParse(value);
  if (!result.success) throw new Error(OPERATING_ALLOCATION_ERRORS.input);
  return result.data;
}
