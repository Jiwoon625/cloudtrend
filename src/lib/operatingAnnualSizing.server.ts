import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { validDate } from "./ledger/date";
import { canonicalJson } from "./ledger/migration";
import { hashSeriesValue, type ModelCalendar } from "./ledger/modelSeries";
import { decimal, format, multiply, representedLegacyNumber } from "./ledger/decimal";
import {
  OCTOBER_CALENDAR_EVIDENCE,
  octoberModelCalendar,
  regularCloseAt,
  regularOpenAt,
} from "./ledger/octoberShadowCalendar";
import { projectNewActualPool } from "./newActualPortfolio";
import type { NewActualDocument } from "./newActualPortfolio.server";
import { datedOperatingSource } from "./operatingEtfSizing.server";
import {
  OPERATING_ALLOCATION_VERSION,
  freezeAnnualSizingSnapshot,
  operatingCashHistorySchema,
  readOperatingSizing,
  validateAnnualSizingSnapshot,
  validateOperatingCashAuthority,
  type AnnualSizingSnapshot,
  type OperatingSizing,
} from "./operatingAllocation";

type Market = "KR" | "US";
const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const date = z.string().refine(validDate);
const timestamp = z.string().datetime({ offset: true });
const ms = (value: string) => Date.parse(timestamp.parse(value));

/** Trusted server dependency, never a request field. Synthetic calendars belong in tests only. */
export interface OperatingAnnualCalendar {
  calendar: ModelCalendar;
  openAt: (market: Market, date: string) => string;
  closeAt: (market: Market, date: string) => string;
}
export interface OperatingAnnualWindow {
  market: Market;
  year: number;
  yearEndDate: string;
  valuationDate: string;
  closeAt: string;
  firstSessionAt: string;
  calendarEvidence: string;
}
export interface OperatingAnnualCloseEvidence {
  market: Market;
  date: string;
  availableAt: string;
  sourceFingerprint: string;
  prices: {
    market: "KOSPI" | "KOSDAQ" | "US";
    symbol: string;
    date: string;
    close: number | null;
  }[];
}

/** Both sides of the boundary must be covered by reviewed exchange evidence. */
export async function operatingAnnualWindow(
  market: Market,
  year: number,
  evidence?: OperatingAnnualCalendar,
): Promise<OperatingAnnualWindow> {
  if (!["KR", "US"].includes(market) || !Number.isInteger(year) || year < 2027 || year > 9999)
    throw new Error("Annual renewal requires a subsequent native-currency year");
  const source = evidence ?? {
    calendar: await octoberModelCalendar(market, OCTOBER_CALENDAR_EVIDENCE.coverageEnd),
    openAt: regularOpenAt,
    closeAt: regularCloseAt,
  };
  const { calendar } = source;
  const yearEndDate = `${year - 1}-12-31`;
  const january = `${year}-01-01`;
  const sessions = [...calendar.regularSessions].sort();
  if (
    calendar.market !== market ||
    !fingerprint.safeParse(calendar.sourceHash).success ||
    !validDate(calendar.coverageStart) ||
    !validDate(calendar.coverageEnd) ||
    calendar.coverageStart > `${year - 1}-12-01` ||
    calendar.coverageEnd < january ||
    new Set(sessions).size !== sessions.length ||
    sessions.some(
      (day) => !validDate(day) || day < calendar.coverageStart || day > calendar.coverageEnd,
    )
  )
    throw new Error("Verified annual calendar does not cover the year boundary");
  const valuationDate = sessions.filter((day) => day <= yearEndDate).at(-1);
  const firstSession = sessions.find((day) => day >= january);
  if (
    !valuationDate ||
    valuationDate < `${year - 1}-12-01` ||
    !firstSession ||
    firstSession.slice(0, 4) !== String(year)
  )
    throw new Error("Verified annual calendar lacks the last or first market session");
  const firstSessionAt = source.openAt(market, firstSession);
  const closeAt = source.closeAt(market, valuationDate);
  if (ms(closeAt) >= ms(firstSessionAt)) throw new Error("Invalid annual session boundary");
  return {
    market,
    year,
    yearEndDate,
    valuationDate,
    closeAt,
    firstSessionAt,
    calendarEvidence: calendar.sourceHash,
  };
}

const krInputSchema = z
  .object({
    version: z.literal("kr-daily-inputs-v1"),
    date,
    inputs: z
      .object({
        bars: z.record(
          z.array(z.object({ tradeDate: date, close: z.number().finite() }).passthrough()),
        ),
        markets: z.record(z.enum(["KOSPI", "KOSDAQ"])),
      })
      .passthrough(),
  })
  .passthrough();
const usResultSchema = z
  .object({
    dataHash: fingerprint,
    generatedAt: timestamp,
    source: z.object({ collectedAt: timestamp }).passthrough(),
    analysis: z
      .object({
        date,
        ruleVersion: z.string().min(1),
        rows: z.array(
          z
            .object({ symbol: z.string().min(1), date, close: z.number().finite().nullable() })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

/** Read-only, owner-scoped dated sources. Never consult latest, MODEL balances, FX or raw feeds.
 * KR reuses only immutable daily market bars and their actual database recording time.
 * The model's synthetic available/decision times are deliberately ignored.
 */
export async function loadOperatingAnnualCloseEvidence(
  client: SupabaseClient,
  uid: string,
  window: OperatingAnnualWindow,
): Promise<OperatingAnnualCloseEvidence> {
  if (!/^[a-f\d-]{36}$/i.test(uid)) throw new Error("Verified annual valuation owner required");
  if (window.market === "KR") {
    const { data, error } = await client
      .from("ledger_provenance_archive")
      .select("source_id,source_revision,source_hash,payload,recorded_at")
      .eq("user_id", uid)
      .eq("source_revision", "1")
      .like("source_id", `october-input:KR:${window.valuationDate}:%`)
      .lt("recorded_at", window.firstSessionAt)
      .order("recorded_at", { ascending: false })
      .limit(2);
    // Distinct immutable archives for the same close require an explicit resolution.
    if (error || !data || data.length !== 1)
      throw new Error("Unique immutable annual KR close evidence unavailable");
    const row = data[0]!;
    if (
      row.source_revision !== "1" ||
      !fingerprint.safeParse(row.source_hash).success ||
      row.source_id !==
        `october-input:KR:${window.valuationDate}:${String(row.source_hash).slice(7)}` ||
      (await hashSeriesValue(row.payload)) !== row.source_hash
    )
      throw new Error("Immutable annual KR close fingerprint mismatch");
    const payload = krInputSchema.parse(row.payload);
    if (
      payload.date !== window.valuationDate ||
      ms(row.recorded_at) < ms(window.closeAt) ||
      ms(row.recorded_at) >= ms(window.firstSessionAt)
    )
      throw new Error("Annual KR close was incomplete or arrived after the first session");
    const prices = Object.entries(payload.inputs.bars).flatMap(([symbol, bars]) => {
      const market = payload.inputs.markets[symbol];
      if (!market || bars.some((bar) => bar.tradeDate !== window.valuationDate))
        throw new Error("Immutable annual KR close date/market mismatch");
      return bars.map((bar) => ({ market, symbol, date: bar.tradeDate, close: bar.close }));
    });
    return {
      market: "KR",
      date: payload.date,
      prices,
      availableAt: row.recorded_at,
      sourceFingerprint: hash({
        sourceId: row.source_id,
        contentHash: row.source_hash,
        recordedAt: row.recorded_at,
      }),
    };
  }
  const { data: marker, error } = await client
    .from("us_screening_history")
    .select("date,rule_version,data_hash,created_at")
    .eq("user_id", uid)
    .eq("date", window.valuationDate)
    .maybeSingle();
  if (
    error ||
    !marker ||
    marker.date !== window.valuationDate ||
    !fingerprint.safeParse(marker.data_hash).success ||
    ms(marker.created_at) < ms(window.closeAt) ||
    ms(marker.created_at) >= ms(window.firstSessionAt)
  )
    throw new Error(
      "Completed immutable annual US close evidence unavailable before first session",
    );
  const path = `${uid}/results/us-screening/${window.valuationDate}.json`;
  const { data, error: downloadError } = await client.storage
    .from("cloudtrend-data")
    .download(path);
  if (downloadError || !data) throw new Error("Immutable annual US result unavailable");
  const raw: unknown = JSON.parse(await data.text());
  const result = usResultSchema.parse(raw);
  const availableAt = [marker.created_at, result.generatedAt, result.source.collectedAt]
    .sort((a, b) => ms(a) - ms(b))
    .at(-1)!;
  if (
    result.dataHash !== marker.data_hash ||
    result.analysis.ruleVersion !== marker.rule_version ||
    result.analysis.date !== window.valuationDate ||
    ms(result.generatedAt) < ms(window.closeAt) ||
    ms(availableAt) >= ms(window.firstSessionAt) ||
    result.analysis.rows.some((row) => row.date !== window.valuationDate)
  )
    throw new Error("Immutable annual US result identity/availability mismatch");
  return {
    market: "US",
    date: result.analysis.date,
    availableAt,
    sourceFingerprint: hash({ path, contentHash: hash(raw), marker }),
    prices: result.analysis.rows.map((row) => ({
      market: "US" as const,
      symbol: row.symbol,
      date: row.date,
      close: row.close,
    })),
  };
}

function buildSnapshot(input: {
  document: NewActualDocument;
  window: OperatingAnnualWindow;
  closeEvidence: OperatingAnnualCloseEvidence;
  now: string;
}): AnnualSizingSnapshot {
  const { document, window, closeEvidence, now } = input;
  const currency = window.market === "US" ? "USD" : "KRW";
  const observedYear = new Intl.DateTimeFormat("en-US", {
    timeZone: window.market === "US" ? "America/New_York" : "Asia/Seoul",
    year: "numeric",
  }).format(new Date(ms(now)));
  if (Number(observedYear) < window.year)
    throw new Error("Annual NAV cannot freeze before year end");
  if (
    closeEvidence.market !== window.market ||
    closeEvidence.date !== window.valuationDate ||
    !fingerprint.safeParse(closeEvidence.sourceFingerprint).success ||
    ms(closeEvidence.availableAt) < ms(window.closeAt) ||
    ms(closeEvidence.availableAt) >= ms(window.firstSessionAt) ||
    ms(closeEvidence.availableAt) > ms(now)
  )
    throw new Error("Annual NAV requires an available completed year-end close");
  const dated = datedOperatingSource(document, window.yearEndDate);
  const history = operatingCashHistorySchema.parse(document["operatingCashHistory"] ?? []);
  const matching = history
    .filter(
      (entry) =>
        entry.authority.currency === currency &&
        entry.economicSourceFingerprint === dated.economicSourceFingerprint &&
        ms(entry.authority.reviewedAt) >= ms(window.closeAt) &&
        ms(entry.authority.reviewedAt) < ms(window.firstSessionAt) &&
        ms(entry.authority.reviewedAt) <= ms(now),
    )
    .sort((a, b) => ms(a.authority.reviewedAt) - ms(b.authority.reviewedAt))
    .at(-1);
  if (!matching)
    throw new Error(
      "Annual NAV historical cash ownership evidence unavailable before first session",
    );
  validateOperatingCashAuthority(matching.authority);
  const pool = projectNewActualPool({
    currency,
    executions: dated.source.executions,
    metadata: dated.source.newActualPortfolio,
    quotes: {},
    valuationDate: window.valuationDate,
    today: window.yearEndDate,
  });
  if (pool.cash === null || pool.cash !== matching.authority.cashAtReview)
    throw new Error("Annual NAV historical cash does not reconcile");
  // Cash on a year-end holiday is valid; a purported fill after the last official close is not.
  if (pool.trades.some((trade) => trade.execution.date > window.valuationDate))
    throw new Error("Annual holdings contain a fill after the last market session");
  let holdings = 0n;
  const priceEvidence = [];
  for (const position of pool.positions.filter((position) => position.asset === window.market)) {
    const matches = closeEvidence.prices.filter(
      (row) => row.market === position.market && row.symbol === position.symbol,
    );
    const quote = matches[0];
    if (
      matches.length !== 1 ||
      !quote ||
      quote.date !== window.valuationDate ||
      quote.close === null ||
      !Number.isFinite(quote.close) ||
      quote.close <= 0
    )
      throw new Error(
        "Annual holding exact final-session close missing; no current/last-price fallback",
      );
    const price = representedLegacyNumber(quote.close);
    holdings += multiply(decimal(position.quantity), decimal(price));
    priceEvidence.push({
      market: position.market,
      symbol: position.symbol,
      quantity: position.quantity,
      price,
      date: quote.date,
    });
  }
  const cashClaim = matching.authority.claims[window.market];
  const snapshot: AnnualSizingSnapshot = {
    id: `${OPERATING_ALLOCATION_VERSION}:${window.market}:${window.year}`,
    market: window.market,
    currency,
    year: window.year,
    nav: format(decimal(cashClaim) + holdings),
    basis: "PRIOR_YEAR_MARKET_NAV",
    valuationDate: window.valuationDate,
    availableAt:
      ms(closeEvidence.availableAt) > ms(matching.authority.reviewedAt)
        ? closeEvidence.availableAt
        : matching.authority.reviewedAt,
    firstSessionAt: window.firstSessionAt,
    sourceFingerprint: hash({
      economicThrough: window.yearEndDate,
      economicSourceFingerprint: dated.economicSourceFingerprint,
      cashReview: matching,
      cashClaim,
      priceEvidence,
      closeSourceFingerprint: closeEvidence.sourceFingerprint,
    }),
    valuationComplete: true,
    calendarEvidence: window.calendarEvidence,
    nativeAllocationEvidence: null,
  };
  validateAnnualSizingSnapshot(snapshot);
  return snapshot;
}

export async function buildOperatingAnnualSizingSnapshot(input: {
  document: NewActualDocument;
  market: Market;
  year: number;
  closeEvidence: OperatingAnnualCloseEvidence;
  now: string;
  calendar?: OperatingAnnualCalendar;
}): Promise<AnnualSizingSnapshot> {
  const window = await operatingAnnualWindow(input.market, input.year, input.calendar);
  return buildSnapshot({ ...input, window });
}

/** Returns metadata for the caller's existing owner/revision CAS. This helper never writes.
 * Existing yearly snapshots and pending budgets are reused without repricing or rewriting history.
 */
export async function ensureOperatingAnnualSizing(
  input: {
    client: SupabaseClient;
    uid: string;
    document: NewActualDocument;
    sizing: OperatingSizing;
    market: Market;
    year: number;
    now: string;
  },
  dependencies: {
    calendar?: OperatingAnnualCalendar;
    loadCloseEvidence?: typeof loadOperatingAnnualCloseEvidence;
  } = {},
): Promise<OperatingSizing> {
  const sizing = readOperatingSizing(input.sizing);
  if (
    sizing.annualSnapshots.some(
      (snapshot) => snapshot.market === input.market && snapshot.year === input.year,
    )
  )
    return sizing;
  const window = await operatingAnnualWindow(input.market, input.year, dependencies.calendar);
  const closeEvidence = await (dependencies.loadCloseEvidence ?? loadOperatingAnnualCloseEvidence)(
    input.client,
    input.uid,
    window,
  );
  const snapshot = buildSnapshot({ ...input, window, closeEvidence });
  return readOperatingSizing({
    ...sizing,
    annualSnapshots: freezeAnnualSizingSnapshot(sizing.annualSnapshots, snapshot),
  });
}
