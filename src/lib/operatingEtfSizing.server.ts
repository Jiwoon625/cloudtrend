import { createHash } from "node:crypto";
import { canonicalJson } from "./ledger/migration";
import { decimal, format, multiply, representedLegacyNumber } from "./ledger/decimal";
import {
  octoberModelCalendar,
  regularOpenAt,
  regularCloseAt,
  OCTOBER_CALENDAR_EVIDENCE,
} from "./ledger/octoberShadowCalendar";
import {
  emptyNewActualMetadata,
  projectNewActualPool,
  validateNewActualMetadata,
} from "./newActualPortfolio";
import type { NewActualDocument } from "./newActualPortfolio.server";
import type { DashboardIndex } from "./dashboardOperations";
import {
  operatingCashHistorySchema,
  validateOperatingCashAuthority,
  type EtfSizingSnapshot,
} from "./operatingAllocation";

const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
/** Later dated fills/cash are excluded before quantities and cash are computed, not after valuation. */
export function datedOperatingSource(document: NewActualDocument, throughDate: string) {
  const metadata = document.newActualPortfolio ?? emptyNewActualMetadata();
  validateNewActualMetadata(metadata);
  const byId = new Map(document.executions.map((execution) => [execution.id, execution]));
  const assignments = Object.values(metadata.assignments).filter((assignment) => {
    const execution = byId.get(assignment.executionId);
    if (!execution) throw new Error("Orphan actual assignment");
    return execution.date <= throughDate;
  });
  const executions = assignments.map((assignment) => byId.get(assignment.executionId)!);
  const scoped = {
    version: metadata.version,
    seriesId: metadata.seriesId,
    assignments: Object.fromEntries(
      assignments.map((assignment) => [assignment.executionId, assignment]),
    ),
    cashEvents: metadata.cashEvents.filter((event) => event.date <= throughDate),
    audit: [],
  };
  const source = { executions, newActualPortfolio: scoped };
  return { source, economicSourceFingerprint: hash(source) };
}

/** Uses the completed D screening prices and matching historical cash claims only.
 * No current-position × historical-close fallback, annual ETF budget, stale mark or zero fill-in.
 */
export async function buildOperatingEtfSizingSnapshot(input: {
  document: NewActualDocument;
  index: DashboardIndex;
  decisionDate: string;
}): Promise<EtfSizingSnapshot> {
  const { document, index, decisionDate } = input;
  if (
    index.date !== decisionDate ||
    !index.screeningCreatedAt ||
    !Number.isFinite(Date.parse(index.screeningCreatedAt))
  )
    throw new Error("ETF dated completed screening evidence missing");
  const calendar = await octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
  if (!calendar.regularSessions.includes(decisionDate))
    throw new Error("ETF NAV date is not a verified market session");
  const next = calendar.regularSessions.find((day) => day > decisionDate);
  if (!next) throw new Error("ETF next-session evidence missing");
  const nextOpenAt = regularOpenAt("KR", next),
    closeAt = regularCloseAt("KR", decisionDate);
  if (
    Date.parse(index.screeningCreatedAt) < Date.parse(closeAt) ||
    Date.parse(index.screeningCreatedAt) >= Date.parse(nextOpenAt)
  )
    throw new Error("ETF D close was not published before its next executable open");
  const dated = datedOperatingSource(document, decisionDate);
  const history = operatingCashHistorySchema.parse(document["operatingCashHistory"] ?? []);
  const matching = history
    .filter(
      (entry) =>
        entry.authority.currency === "KRW" &&
        entry.economicSourceFingerprint === dated.economicSourceFingerprint &&
        Date.parse(entry.authority.reviewedAt) < Date.parse(nextOpenAt),
    )
    .sort((a, b) => a.authority.reviewedAt.localeCompare(b.authority.reviewedAt))
    .at(-1);
  if (!matching) throw new Error("ETF D cash ownership evidence missing");
  validateOperatingCashAuthority(matching.authority);
  const pool = projectNewActualPool({
    currency: "KRW",
    executions: dated.source.executions,
    metadata: dated.source.newActualPortfolio,
    quotes: {},
    valuationDate: decisionDate,
    today: decisionDate,
  });
  if (pool.cash === null || pool.cash !== matching.authority.cashAtReview)
    throw new Error("ETF historical cash claims do not reconcile to D cash");
  const positions = pool.positions.filter((position) => position.asset === "ETF");
  let holdingsValue = 0n;
  const priceEvidence = [];
  for (const position of positions) {
    const rows = index.rows.filter((row) => row.market === "ETF" && row.symbol === position.symbol);
    const quote = rows[0];
    if (
      rows.length !== 1 ||
      !quote ||
      quote.date !== decisionDate ||
      quote.price === null ||
      !Number.isFinite(quote.price) ||
      quote.price <= 0
    )
      throw new Error("ETF holding D close missing; no last-price substitution");
    const price = representedLegacyNumber(quote.price);
    holdingsValue += multiply(decimal(position.quantity), decimal(price));
    priceEvidence.push({
      symbol: position.symbol,
      quantity: position.quantity,
      price,
      date: quote.date,
    });
  }
  const cashClaim = matching.authority.claims.ETF;
  const availableAt =
    Date.parse(index.screeningCreatedAt) > Date.parse(matching.authority.reviewedAt)
      ? index.screeningCreatedAt
      : matching.authority.reviewedAt;
  const sourceFingerprint = hash({
    economicSourceFingerprint: dated.economicSourceFingerprint,
    cashClaim,
    priceEvidence,
    screeningCreatedAt: index.screeningCreatedAt,
  });
  return {
    id: `actual-etf-nav:${decisionDate}:${sourceFingerprint.slice(-16)}`,
    market: "ETF",
    currency: "KRW",
    valuationDate: decisionDate,
    nav: format(decimal(cashClaim) + holdingsValue),
    cashClaim,
    holdingsValue: format(holdingsValue),
    availableAt,
    nextOpenAt,
    sourceFingerprint,
    cashReviewFingerprint: hash(matching),
    calendarEvidence: calendar.sourceHash,
  };
}
