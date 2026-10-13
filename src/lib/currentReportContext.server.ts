import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTUAL_PERFORMANCE_SERIES, ACTUAL_PERFORMANCE_START } from "./ledger/actualPerformance";
import { ADOPTED_SERIES_KINDS, RESTART_SERIES_VERSION } from "./ledger/modelSeries";
import { readWebsiteDocument } from "./ledger/websiteRepository.server";
import type { NewActualDocument } from "./newActualPortfolio.server";
import {
  projectActualPositionContext,
  projectWebsitePositionContext,
} from "./websitePositionContext.server";
import { loadOctoberShadowSummaryForOwner } from "./octoberShadowSummary.server";
import { websiteShadowSummary } from "./websitePerformanceBoundary";
import { readIntegratedAllocationBook } from "./integratedAllocationStore.server";
import {
  ALLOCATION_MARKETS,
  INTEGRATED_ALLOCATION_VERSION,
  allocationTotalNav,
} from "./integratedAllocationShadow";

/** Reporting boundary only. Historical journals, research and Notion history stay intact. */
export const CURRENT_REPORT_SOURCE_CONTRACT = Object.freeze({
  version: "current-report-context-2026-10-12-v1",
  startsOn: ACTUAL_PERFORMANCE_START,
  actualSeriesId: ACTUAL_PERFORMANCE_SERIES,
  actualMembership: "EXPLICIT_REVIEWED_ASSIGNMENTS_ONLY",
  actualSourceSystems: ["portfolio_ledgers", "us_actual_portfolio_ledgers"],
  adoptedBookIds: ADOPTED_SERIES_KINDS.map((kind) => `${RESTART_SERIES_VERSION}:${kind}`),
  integratedBookIds: ["O1", "S07"].map((kind) => `${INTEGRATED_ALLOCATION_VERSION}:${kind}`),
  marketSignalsAreHoldings: false,
  legacyFallbackAllowed: false,
  forbiddenCurrentHoldingsSources: [
    "us_portfolio_snapshots",
    "us_portfolio_trades",
    "raw_unfiltered_actual_documents",
  ],
} as const);

const SIGNAL_FIELDS = [
  "symbol",
  "name",
  "sector",
  "coreRank",
  "betaRank",
  "tkRank",
  "relvolRank",
  "a0Entry",
  "a0Exit",
  "a0BetaExit",
  "a2Entry",
  "a2Exit",
  "b3Entry",
  "b3Exit",
  "b3BetaExit",
] as const;
function signalRows(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Invalid current market signal rows");
  return value.map((row: unknown) => {
    if (
      !row ||
      typeof row !== "object" ||
      typeof (row as Record<string, unknown>)["symbol"] !== "string"
    )
      throw new Error("Invalid current market signal row");
    const record = row as Record<string, unknown>;
    return Object.fromEntries(SIGNAL_FIELDS.map((key) => [key, record[key] ?? null]));
  });
}

/** Read-only, owner-scoped source for connector/CLI reports. Errors propagate; no legacy fallback. */
export async function loadCurrentReportContextForOwner(
  client: SupabaseClient,
  uid: string,
  now = new Date(),
) {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uid))
    throw new Error("Verified owner ID required");
  const usToday = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [domestic, us, inputShadow, integrated, market] = await Promise.all([
    readWebsiteDocument<NewActualDocument>(client, uid, "portfolio_ledgers"),
    readWebsiteDocument<NewActualDocument>(client, uid, "us_actual_portfolio_ledgers"),
    loadOctoberShadowSummaryForOwner(client, uid, RESTART_SERIES_VERSION),
    Promise.all(
      (["O1", "S07"] as const).map((kind) => readIntegratedAllocationBook(client, uid, kind)),
    ),
    client
      .from("us_screening_history")
      .select("date,rule_version,signals")
      .eq("user_id", uid)
      .gte("date", ACTUAL_PERFORMANCE_START)
      .lte("date", usToday)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (market.error) throw new Error(`Current market signal read failed: ${market.error.message}`);
  const docs = { KRW: domestic, USD: us };
  const actual = projectActualPositionContext(domestic?.payload ?? null, us?.payload ?? null, now);
  // Reuse website's strict exact-book, completeness, date and holding validation,
  // but never expose its combined actual+Shadow compatibility holdings to reports.
  projectWebsitePositionContext(domestic?.payload ?? null, us?.payload ?? null, inputShadow, now);
  const shadow = websiteShadowSummary(inputShadow)!;
  if (
    shadow.books.some(
      (book) => !CURRENT_REPORT_SOURCE_CONTRACT.adoptedBookIds.includes(book.bookId),
    )
  )
    throw new Error("Unexpected adopted current reporting series");
  const integratedBooks = integrated.map((book) => {
    const ledger = book.ledger;
    const bookId = `${INTEGRATED_ALLOCATION_VERSION}:${book.kind}`;
    if (
      ledger &&
      (ledger.bookId !== bookId || ledger.contract.version !== INTEGRATED_ALLOCATION_VERSION)
    )
      throw new Error("Unexpected integrated current reporting series");
    const sleeves = ledger
      ? ALLOCATION_MARKETS.map((market) => {
          const sleeve = ledger.markets[market];
          const today = now.toLocaleDateString("en-CA", {
            timeZone: market === "U" ? "America/New_York" : "Asia/Seoul",
          });
          if (
            sleeve.sessions.some((date) => date < ACTUAL_PERFORMANCE_START || date > today) ||
            sleeve.positions.some(
              (p) => p.entryDate < ACTUAL_PERFORMANCE_START || p.entryDate > today,
            )
          )
            throw new Error("Integrated report contains out-of-bound sessions or positions");
          return {
            market,
            latestSessionDate: sleeve.lastSessionDate,
            cashKrw: sleeve.cashKrw,
            navKrw: sleeve.navKrw,
            positions: sleeve.positions,
            pendingBuys: sleeve.pendingBuys.length,
            pendingExits: sleeve.pendingExits.length,
          };
        })
      : [];
    return {
      bookId,
      kind: book.kind,
      status: book.status,
      centralCashKrw: ledger?.centralCashKrw ?? null,
      navKrw: ledger ? allocationTotalNav(ledger) : null,
      sleeves,
    };
  });
  return {
    contract: CURRENT_REPORT_SOURCE_CONTRACT,
    checkedAt: now.toISOString(),
    marketSignals: {
      US: {
        role: "MARKET_SIGNALS_ONLY",
        source: "us_screening_history",
        status: market.data ? "RECORDED" : "UNAVAILABLE",
        sessionDate: market.data?.date ?? null,
        ruleVersion: market.data?.rule_version ?? null,
        signals: market.data ? signalRows(market.data.signals) : [],
      },
    },
    actual: {
      seriesId: ACTUAL_PERFORMANCE_SERIES,
      valuationStatus: "NOT_REQUESTED_NO_PRICE_OR_RETURN_INFERENCE",
      pools: Object.entries(actual.actualPools).map(([currency, pool]) => ({
        currency,
        status: docs[currency as keyof typeof docs]?.payload.newActualPortfolio
          ? "PROJECTED"
          : "NOT_INITIALIZED",
        sourceRevision: docs[currency as keyof typeof docs]?.revision ?? null,
        fundingStatus: pool.fundingStatus,
        cash: pool.cash,
        issues: pool.issues,
        positions: pool.positions,
        allocatedTradeCount: pool.trades.length,
      })),
    },
    shadow: {
      version: RESTART_SERIES_VERSION,
      checkedAt: shadow.checkedAt,
      books: shadow.books.map(
        ({
          bookId,
          kind,
          role,
          currency,
          status,
          latestSessionDate,
          initialCapital,
          cash,
          nav,
          holdings,
          returnPercent,
          valuationStatus,
          warnings,
        }) => ({
          bookId,
          kind,
          role,
          currency,
          status,
          latestSessionDate,
          initialCapital,
          cash,
          nav,
          holdings,
          returnPercent,
          valuationStatus,
          warnings,
        }),
      ),
    },
    integratedShadow: { version: INTEGRATED_ALLOCATION_VERSION, books: integratedBooks },
  };
}
