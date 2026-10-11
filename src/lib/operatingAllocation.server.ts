import { newActualCashDay } from "./newActualCashDate";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalJson } from "./ledger/migration";
import { readWebsiteDocument } from "./ledger/websiteRepository.server";
import { projectNewActualPool } from "./newActualPortfolio";
import {
  decimal,
  exactNotionalFee,
  fromLegacyNumber,
  representedLegacyNumber,
} from "./ledger/decimal";
import {
  OCTOBER_CALENDAR_EVIDENCE,
  octoberModelCalendar,
  regularOpenAt,
} from "./ledger/octoberShadowCalendar";
import { DASHBOARD_MARKETS, marketSignals } from "./dashboardOperations";
import type { NewActualDocument } from "./newActualPortfolio.server";
import { buildOperatingEtfSizingSnapshot, datedOperatingSource } from "./operatingEtfSizing.server";
import {
  OPERATING_ALLOCATION_ERRORS as errors,
  prepareOperatingAllocation,
  projectOperatingAvailability,
  readOperatingAllocation,
  readOperatingCashAuthority,
  reserveOperatingCash,
  readOperatingSizing,
  prepareOperatingSignalBudget,
  pinOperatingSignalBudget,
  validateOperatingCashAuthority,
  parseOperatingAllocationRequest,
  operatingUsdSizingEvidenceSchema,
  freezeAnnualSizingSnapshot,
  operatingCashHistorySchema,
  prepareEtfSignalBudget,
  type OperatingAllocation,
  type OperatingAllocationRequest,
  type OperatingCashAuthority,
  type OperatingCurrency,
  type OperatingSizing,
  type OperatingUsdSizingEvidence,
  type OperatingCashHistory,
} from "./operatingAllocation";

type Document = NewActualDocument & {
  operatingAllocation?: OperatingAllocation;
  operatingCashAuthority?: OperatingCashAuthority;
  operatingSizing?: OperatingSizing;
  operatingUsdSizingEvidence?: OperatingUsdSizingEvidence;
  operatingCashHistory?: OperatingCashHistory;
  operatingAllocationAudit?: Audit[];
};
type Row = { revision: number; payload: Document };
const auditSchema = z
  .object({
    requestId: z.string().uuid(),
    fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    recordedAt: z.string().datetime({ offset: true }),
    kind: z.enum([
      "CONFIRM_PLAN",
      "REVIEW_CLAIMS",
      "RESERVE",
      "RELEASE",
      "PIN_SIGNAL_BUDGET",
      "CONFIRM_USD_SIZING",
    ]),
  })
  .strict();
type Audit = z.infer<typeof auditSchema>;
const tableFor = (currency: OperatingCurrency) =>
  currency === "KRW" ? ("portfolio_ledgers" as const) : ("us_actual_portfolio_ledgers" as const);
const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
/** Includes cash source identities, corrections and voids. Metadata-only updates cannot fake a cash change. */
export function operatingCashSourceFingerprint(document: NewActualDocument) {
  return hash({
    executions: document.executions,
    newActualPortfolio: document.newActualPortfolio ?? null,
  });
}
function localDay(currency: OperatingCurrency, now: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: currency === "USD" ? "America/New_York" : "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  return ["year", "month", "day"]
    .map((part) => parts.find((p) => p.type === part)?.value)
    .join("-");
}
function sourceCash(row: Row, currency: OperatingCurrency, now: string) {
  const today = localDay(currency, now);
  return projectNewActualPool({
    currency,
    executions: row.payload.executions,
    metadata: row.payload.newActualPortfolio ?? null,
    quotes: {},
    valuationDate: today,
    today,
    cashToday: newActualCashDay(now),
  }).cash;
}
function auditOf(document: Document) {
  const result = z.array(auditSchema).safeParse(document.operatingAllocationAudit ?? []);
  if (!result.success || new Set(result.data.map((a) => a.requestId)).size !== result.data.length)
    throw new Error(errors.invalid);
  return result.data;
}
export interface OperatingAllocationResponse {
  revision: number | null;
  plan: OperatingAllocation | null;
  authority: OperatingCashAuthority | null;
  cash: string | null;
  sourceFingerprint: string;
  sizing: OperatingSizing;
  usdSizingEvidence: OperatingUsdSizingEvidence | null;
  sizingIssues: string[];
  fundingSources: { id: string; date: string; amount: string; reference: string }[];
  availability: ReturnType<typeof projectOperatingAvailability>;
  reused?: boolean;
  reviewFingerprint?: string;
}
async function context(client: SupabaseClient, uid: string, currency: OperatingCurrency) {
  const row = await readWebsiteDocument<Document>(client, uid, tableFor(currency));
  const domestic =
    currency === "KRW"
      ? row
      : await readWebsiteDocument<Document>(client, uid, "portfolio_ledgers");
  return { row, domestic, plan: readOperatingAllocation(domestic?.payload.operatingAllocation) };
}
/** Re-project from the exact currency document protected by the subsequent CAS. */
async function verifyReservationCandidate(
  client: SupabaseClient,
  uid: string,
  row: Row,
  domestic: Row | null,
  currency: OperatingCurrency,
  reservation: Extract<
    Exclude<OperatingAllocationRequest, { action: "load" }>["change"],
    { kind: "RESERVE" }
  >["reservation"],
  security: import("./operatingAllocation").OperatingSecurity,
  now: string,
) {
  const { projection } = await import("./dashboardOperations.server");
  const { projectActualPositionContext } = await import("./websitePositionContext.server");
  const { projectDashboardActualAllocation } = await import("./dashboardActualAllocation.server");
  const index = await projection(client, uid, currency === "USD" ? "us" : "kr");
  if (!index || index.date > localDay(currency, now)) throw new Error(errors.conflict);
  const securityNow = index.rows.find(
    (r) => r.symbol === security.symbol && r.market === security.venue && r.date === index.date,
  );
  if (
    !securityNow ||
    (securityNow.sectorCode ?? null) !== security.sectorCode ||
    securityNow.sector !== security.sector
  )
    throw new Error(errors.conflict);
  const actual = {
    domestic: currency === "KRW" ? row : domestic,
    us: currency === "USD" ? row : null,
    context: projectActualPositionContext(
      (currency === "KRW" ? row : domestic)?.payload ?? null,
      currency === "USD" ? row.payload : null,
      new Date(now),
    ),
  };
  const markets = DASHBOARD_MARKETS.filter(
    (market) => (market === "US") === (currency === "USD"),
  ).map((market) =>
    marketSignals(
      index,
      market,
      actual.context.positions.filter((position) => position.market === market),
      actual.context.actualExecutions,
      { counts: null, maxPositions: null, asOfDate: null, issue: "예약 검증에서 실제 한도 재계산" },
    ),
  );
  const fresh = await projectDashboardActualAllocation({
    actual,
    kr: currency === "KRW" ? index : null,
    us: currency === "USD" ? index : null,
    markets,
    now,
  });
  const candidate = fresh.previews.find(
    (preview) =>
      preview.market === security.venue &&
      preview.symbol === security.symbol &&
      preview.signalOriginDate === security.originDate,
  );
  if (
    !candidate ||
    candidate.status !== "ESTIMATED" ||
    candidate.cashRequired !== reservation.amount
  )
    throw new Error(errors.conflict);
}
function response(
  row: Row | null,
  plan: OperatingAllocation | null,
  currency: OperatingCurrency,
  now: string,
): OperatingAllocationResponse {
  const cash = row ? sourceCash(row, currency, now) : null;
  const sourceFingerprint = operatingCashSourceFingerprint(row?.payload ?? { executions: [] });
  const authority = readOperatingCashAuthority(row?.payload.operatingCashAuthority);
  if (row && authority && authority.sourceRevision > row.revision) throw new Error(errors.invalid);
  if (row) auditOf(row.payload);
  const fundingSources =
    currency === "USD"
      ? (row?.payload.newActualPortfolio?.cashEvents ?? [])
          .filter((event) => !event.voided && event.kind === "DEPOSIT")
          .map((event) => ({
            id: event.id,
            date: event.date,
            amount: fromLegacyNumber(event.amount),
            reference: event.reference,
          }))
      : [];
  const usdSizingEvidence =
    row?.payload.operatingUsdSizingEvidence === undefined
      ? null
      : operatingUsdSizingEvidenceSchema.parse(row.payload.operatingUsdSizingEvidence);
  const sizingIssues: string[] = [];
  if (usdSizingEvidence) {
    const selected = fundingSources
      .filter((source) => usdSizingEvidence.fundingEventIds.includes(source.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (
      currency !== "USD" ||
      selected.length !== usdSizingEvidence.fundingEventIds.length ||
      hash(selected) !== usdSizingEvidence.fundingFingerprint
    )
      sizingIssues.push("USD_FUNDING_EVIDENCE_CHANGED");
  }
  const sizing = readOperatingSizing(row?.payload.operatingSizing);
  return {
    revision: row?.revision ?? null,
    plan,
    authority,
    cash,
    sourceFingerprint,
    sizing: sizingIssues.length ? readOperatingSizing(undefined) : sizing,
    usdSizingEvidence,
    sizingIssues,
    fundingSources,
    availability: projectOperatingAvailability({ currency, cash, sourceFingerprint, authority }),
  };
}

async function nextVerifiedOpening(market: "KR" | "US", availableAt: string) {
  const calendar = await octoberModelCalendar(market, OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
  const effectiveSessionDate = calendar.regularSessions.find(
    (day) =>
      day >= "2026-10-12" && Date.parse(regularOpenAt(market, day)) > Date.parse(availableAt),
  );
  if (!effectiveSessionDate) throw new Error(errors.funding);
  return {
    calendar,
    effectiveSessionDate,
    firstSessionAt: regularOpenAt(market, effectiveSessionDate),
  };
}
/** Feed the exact canonical rows used for actual holdings, avoiding a second cash read in dashboards. */
export { response as projectOperatingAllocationResponse };
export type OperatingAllocationSourceRow = Row;

async function initialSizing(plan: OperatingAllocation): Promise<OperatingSizing> {
  // Registration after the launch opening is prospective, never a backdated sizing basis.
  const { calendar, firstSessionAt } = await nextVerifiedOpening("KR", plan.recordedAt);
  return readOperatingSizing({
    version: 1,
    signalBudgets: [],
    annualSnapshots: (["KR"] as const).map((market) => ({
      id: `${plan.version}:${market}:2026`,
      market,
      currency: "KRW",
      year: 2026,
      nav: plan.plannedKrw[market],
      basis: "APPROVED_INITIAL_NATIVE_ALLOCATION",
      valuationDate: localDay("KRW", plan.recordedAt),
      availableAt: plan.recordedAt,
      firstSessionAt,
      sourceFingerprint: hash(plan),
      valuationComplete: true,
      calendarEvidence: calendar.sourceHash,
      nativeAllocationEvidence: null,
    })),
  });
}

async function verifiedSignalBudget(
  client: SupabaseClient,
  uid: string,
  change: Extract<
    Exclude<OperatingAllocationRequest, { action: "load" }>["change"],
    { kind: "PIN_SIGNAL_BUDGET" }
  >,
  sizing: OperatingSizing,
  document: Document,
  now: string,
) {
  const isUs = change.market === "US";
  if (change.sourceDate > localDay(isUs ? "USD" : "KRW", now)) throw new Error(errors.input);
  const { projection } = await import("./dashboardOperations.server");
  const { loadActualPositionContextForOwner } = await import("./websitePositionContext.server");
  const [index, actual] = await Promise.all([
    projection(client, uid, isUs ? "us" : "kr"),
    loadActualPositionContextForOwner(client, uid),
  ]);
  if (!index || index.date !== change.sourceDate) throw new Error(errors.conflict);
  const row = index.rows.find(
    (r) => r.market === change.market && r.symbol === change.symbol && r.date === index.date,
  );
  const signals = marketSignals(
    index,
    change.market,
    actual.positions.filter((p) => p.market === change.market),
    actual.actualExecutions,
    {
      counts: null,
      maxPositions: null,
      asOfDate: null,
      issue: "실제 한도는 수량 미리보기에서 별도 확인",
    },
  );
  if (
    !row ||
    !signals.conditions?.some(
      (signal) =>
        signal.symbol === change.symbol &&
        signal.actualState === "READY" &&
        signal.signalOriginDate === change.signalOriginDate,
    )
  )
    throw new Error(errors.input);
  const market = isUs ? "US" : change.market === "ETF" ? "ETF" : "KR";
  const id = `actual-s06-20261012-v1:${change.market}:${change.symbol}:${change.signalOriginDate}`;
  const previous = sizing.signalBudgets.find((budget) => budget.id === id);
  if (previous) return { budget: previous, sizing };
  const decisionDate =
    change.market === "KOSPI"
      ? row.kospiEntry?.confirmationDate
      : change.market === "ETF"
        ? row.etfEntry?.confirmationDate
        : change.signalOriginDate;
  if (!decisionDate || decisionDate > index.date) throw new Error(errors.input);
  const sourceFingerprint = hash({ sourceDate: index.date, row });
  const security = {
    symbol: row.symbol,
    venue: row.market,
    sector: row.sector,
    sectorCode: row.sectorCode ?? null,
    originDate: change.signalOriginDate,
    decisionDate,
    sourceDate: index.date,
    sourceFingerprint,
  };
  const etfWeight = change.market === "ETF" ? row.etfEntry?.entryWeight : undefined;
  if (change.market === "ETF" && (etfWeight === undefined || etfWeight === null))
    throw new Error(errors.input);
  if (change.market === "ETF") {
    const snapshot = await buildOperatingEtfSizingSnapshot({ document, index, decisionDate });
    const nextSizing = readOperatingSizing({
      ...sizing,
      etfSnapshots: [
        ...sizing.etfSnapshots.filter((stored) => stored.id !== snapshot.id),
        snapshot,
      ],
    });
    return {
      sizing: nextSizing,
      budget: {
        ...prepareEtfSignalBudget({
          id,
          snapshot,
          signalDate: change.signalOriginDate,
          decisionDate,
          etfWeight: representedLegacyNumber(etfWeight!),
          sourceFingerprint,
        }),
        security,
      },
    };
  }
  const { ensureOperatingAnnualSizing } = await import("./operatingAnnualSizing.server");
  const nextSizing = await ensureOperatingAnnualSizing({
    client,
    uid,
    document,
    sizing,
    market: isUs ? "US" : "KR",
    year: Number(decisionDate.slice(0, 4)),
    now,
  });
  const snapshot = nextSizing.annualSnapshots.find(
    (snapshot) => snapshot.market === market && snapshot.year === Number(decisionDate.slice(0, 4)),
  );
  if (!snapshot) throw new Error(errors.funding);
  return {
    sizing: nextSizing,
    budget: {
      ...prepareOperatingSignalBudget({
        id,
        snapshot,
        signalDate: change.signalOriginDate,
        decisionDate,
        ...(typeof etfWeight === "number" ? { etfWeight: representedLegacyNumber(etfWeight) } : {}),
        sourceFingerprint,
      }),
      security,
    },
  };
}
/** No ledger initialization, FX, market-data collection or implicit funding on reads. */
export async function loadOperatingAllocation(
  client: SupabaseClient,
  uid: string,
  currency: OperatingCurrency,
  now = new Date().toISOString(),
) {
  const loaded = await context(client, uid, currency);
  return response(loaded.row, loaded.plan, currency, now);
}
/** The currency journal, claims and reservations share one owner/revision CAS. No cross-currency mutation. */
export async function writeOperatingAllocation(
  client: SupabaseClient,
  uid: string,
  rawInput: Exclude<OperatingAllocationRequest, { action: "load" }>,
  now = new Date().toISOString(),
): Promise<OperatingAllocationResponse> {
  const input = parseOperatingAllocationRequest(rawInput);
  if (input.action === "load") throw new Error(errors.input);
  if (!Number.isFinite(Date.parse(now))) throw new Error(errors.input);
  const { row, domestic, plan } = await context(client, uid, input.currency);
  if (!row) throw new Error(errors.missing);
  const current = response(row, plan, input.currency, now);
  const audit = auditOf(row.payload);
  const fingerprint = hash({ currency: input.currency, change: input.change });
  const prior = audit.find((entry) => entry.requestId === input.requestId);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error(errors.conflict);
    return { ...current, reused: true };
  }
  if (row.revision !== input.expectedRevision) throw new Error(errors.conflict);
  const payload = structuredClone(row.payload);
  let nextPlan = plan;
  let reviewFingerprint: string | undefined;
  if (input.change.kind === "CONFIRM_PLAN") {
    if (input.currency !== "KRW") throw new Error(errors.input);
    if (plan) return { ...current, reused: true };
    nextPlan = prepareOperatingAllocation(now);
    payload.operatingAllocation = nextPlan;
    if (payload.operatingSizing !== undefined) throw new Error(errors.invalid);
    payload.operatingSizing = await initialSizing(nextPlan);
  } else if (input.change.kind === "PIN_SIGNAL_BUDGET") {
    if (!plan || (input.change.market === "US" ? "USD" : "KRW") !== input.currency)
      throw new Error(errors.input);
    const verified = await verifiedSignalBudget(
      client,
      uid,
      input.change,
      current.sizing,
      row.payload,
      now,
    );
    payload.operatingSizing = pinOperatingSignalBudget(verified.sizing, verified.budget);
    reviewFingerprint = hash(payload.operatingSizing);
    if (input.action === "save" && input.change.reviewFingerprint !== reviewFingerprint)
      throw new Error(errors.conflict);
  } else if (input.change.kind === "CONFIRM_USD_SIZING") {
    const change = input.change;
    if (input.currency !== "USD" || !plan || current.cash === null || current.sizingIssues.length)
      throw new Error(errors.funding);
    if (Date.parse(change.confirmedAt) > Date.parse(now)) throw new Error(errors.input);
    const selected = current.fundingSources
      .filter((source) => change.fundingEventIds.includes(source.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (
      selected.length !== change.fundingEventIds.length ||
      selected.some((source) => source.date > newActualCashDay(change.confirmedAt)) ||
      decimal(change.amountUsd) > selected.reduce((sum, source) => sum + decimal(source.amount), 0n)
    )
      throw new Error(errors.input);
    if (current.usdSizingEvidence) {
      const old = current.usdSizingEvidence;
      if (
        old.amountUsd !== change.amountUsd ||
        old.confirmedAt !== change.confirmedAt ||
        old.reference !== change.reference ||
        canonicalJson([...old.fundingEventIds].sort()) !==
          canonicalJson([...change.fundingEventIds].sort())
      )
        throw new Error(errors.conflict);
      return { ...current, reused: true };
    }
    const { calendar, effectiveSessionDate, firstSessionAt } = await nextVerifiedOpening("US", now);
    const annualSnapshotId = `${plan.version}:US:2026`;
    const fundingFingerprint = hash(selected);
    const evidence = operatingUsdSizingEvidenceSchema.parse({
      amountUsd: change.amountUsd,
      fundingEventIds: [...change.fundingEventIds].sort(),
      confirmedAt: change.confirmedAt,
      reference: change.reference,
      recordedAt: new Date(now).toISOString(),
      fundingFingerprint,
      effectiveSessionDate,
      annualSnapshotId,
    });
    const annualSnapshots = freezeAnnualSizingSnapshot(current.sizing.annualSnapshots, {
      id: annualSnapshotId,
      market: "US",
      currency: "USD",
      year: 2026,
      nav: evidence.amountUsd,
      basis: "APPROVED_INITIAL_NATIVE_ALLOCATION",
      valuationDate: localDay("USD", evidence.confirmedAt),
      availableAt: evidence.recordedAt,
      firstSessionAt,
      sourceFingerprint: hash(evidence),
      valuationComplete: true,
      calendarEvidence: calendar.sourceHash,
      nativeAllocationEvidence: evidence.reference,
    });
    payload.operatingUsdSizingEvidence = evidence;
    payload.operatingSizing = readOperatingSizing({ ...current.sizing, annualSnapshots });
  } else if (input.change.kind === "RELEASE") {
    const authority = current.authority;
    const reservationId = input.change.reservationId;
    if (
      !authority ||
      !authority.reservations.some((reservation) => reservation.id === reservationId)
    )
      throw new Error(errors.input);
    // A completed fill can stale the old claim. Releasing its encumbrance must remain possible
    // before a new cash review; this never promotes the old claim to current spendability.
    payload.operatingCashAuthority = {
      ...authority,
      reservations: authority.reservations.filter(
        (reservation) => reservation.id !== reservationId,
      ),
    };
    validateOperatingCashAuthority(payload.operatingCashAuthority);
  } else {
    if (!plan) throw new Error(errors.missing);
    if (current.cash === null) throw new Error(errors.funding);
    let authority = current.authority;
    if (input.change.kind === "REVIEW_CLAIMS") {
      authority = {
        version: 1,
        currency: input.currency,
        sourceRevision: row.revision,
        sourceFingerprint: current.sourceFingerprint,
        cashAtReview: current.cash,
        claims: structuredClone(input.change.claims),
        // availableAt records this submitted review on the server, not a broker settlement/event date.
        // Ignore legacy browser timestamps so clock skew cannot reject or backdate a review.
        spendableCash: input.change.spendableCash
          ? {
              amount: input.change.spendableCash.amount,
              reference: input.change.spendableCash.reference,
              availableAt: new Date(now).toISOString(),
            }
          : null,
        reservations: structuredClone(authority?.reservations ?? []),
        reviewedAt: new Date(now).toISOString(),
      };
      validateOperatingCashAuthority(authority);
      payload.operatingCashHistory = [
        ...operatingCashHistorySchema.parse(row.payload.operatingCashHistory ?? []),
        {
          authority: structuredClone(authority),
          economicSourceFingerprint: datedOperatingSource(
            row.payload,
            localDay(input.currency, now),
          ).economicSourceFingerprint,
        },
      ];
    } else {
      if (
        !authority ||
        ["CLAIMS_PENDING", "RECONCILIATION_REQUIRED"].includes(current.availability.status)
      )
        throw new Error(errors.reconcile);
      const reservation = input.change.reservation;
      const budget = current.sizing.signalBudgets.find(
        (budget) => budget.id === reservation.signalBudgetId,
      );
      if (
        !budget ||
        !budget.security ||
        budget.id !== reservation.signalId ||
        budget.market !== reservation.market ||
        budget.currency !== reservation.currency
      )
        throw new Error(errors.input);
      const maximum =
        decimal(budget.amount) +
        (budget.feeTreatment === "GROSS_PLUS_FEE"
          ? exactNotionalFee(decimal(budget.amount), "0.0015")
          : 0n);
      if (decimal(reservation.amount) > maximum) throw new Error(errors.input);
      await verifyReservationCandidate(
        client,
        uid,
        row,
        domestic,
        input.currency,
        reservation,
        budget.security,
        now,
      );
      authority = reserveOperatingCash(authority, { ...reservation, security: budget.security });
      validateOperatingCashAuthority(authority);
    }
    payload.operatingCashAuthority = authority;
  }
  if (input.action === "preview")
    return {
      ...response({ revision: row.revision, payload }, nextPlan, input.currency, now),
      reused: false,
      ...(reviewFingerprint ? { reviewFingerprint } : {}),
    };
  payload.operatingAllocationAudit = [
    ...audit,
    {
      requestId: input.requestId,
      fingerprint,
      recordedAt: new Date(now).toISOString(),
      kind: input.change.kind,
    },
  ];
  const result = await client
    .from(tableFor(input.currency))
    .update({ payload, revision: row.revision + 1, updated_at: new Date(now).toISOString() })
    .eq("user_id", uid)
    .eq("revision", row.revision)
    .select("revision")
    .maybeSingle();
  if (result.error) throw new Error(errors.generic);
  if (!result.data) throw new Error(errors.conflict);
  const checked = await readWebsiteDocument<Document>(client, uid, tableFor(input.currency));
  if (
    !checked ||
    checked.revision !== row.revision + 1 ||
    canonicalJson(checked.payload) !== canonicalJson(payload)
  )
    throw new Error(errors.uncertain);
  return { ...response(checked, nextPlan, input.currency, now), reused: false };
}
