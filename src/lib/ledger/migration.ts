import type { ActualExecution } from "../portfolioLedgers";
import type { Security, LedgerEvent, SourceRef } from "./types";
import { decimal, format, fromLegacyNumber, multiply } from "./decimal";
import { validateEvent, validateSecurity } from "./validation";
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value)))
    throw new Error("Non-JSON source content");
  return JSON.stringify(value);
}
/** No account inference from symbol/market. One confirmed map is required for every source record. */
export function normalizeLegacyExecution(input: {
  execution: ActualExecution<string>;
  accountId: string;
  security: Security;
  source: SourceRef;
  recordedAt: string;
}): LedgerEvent {
  const { execution: e, security, source } = input;
  validateSecurity(security);
  if (
    !input.accountId ||
    !e.id ||
    source.recordId !== e.id ||
    e.symbol !== security.symbol ||
    (e.market === "US") !== (security.market === "US") ||
    (e.market === "ETF" && security.assetType !== "ETF") ||
    (["KOSPI", "KOSDAQ"].includes(e.market) && e.market !== security.market)
  )
    throw new Error("Explicit account/security mapping does not match source fill");
  const quantity = fromLegacyNumber(e.shares),
    price = fromLegacyNumber(e.price),
    fee = fromLegacyNumber(e.fee);
  const gross = format(multiply(decimal(quantity), decimal(price)));
  const result: LedgerEvent = {
    id: `${source.system}:${e.id}`,
    revision: 1,
    previousRevision: null,
    correctionReason: null,
    recordedAt: input.recordedAt,
    recordedBy: "migration:read-only-planner",
    effectiveDate: e.date,
    effectiveSequence: e.order,
    settlementDate: null,
    book: "ACTUAL",
    bookId: "ACTUAL",
    kind: e.side,
    voided: false,
    securityId: security.id,
    quantity,
    price,
    currency: security.currency,
    gross,
    fee,
    tax: null,
    // Legacy fee fields do not establish broker net settlement or whether taxes are included.
    cashLegs: [{ accountId: input.accountId, currency: security.currency, amount: null }],
    positionLegs: [
      {
        accountId: input.accountId,
        securityId: security.id,
        quantity: e.side === "BUY" ? quantity : format(-decimal(quantity)),
        basisAdjustment: null,
      },
    ],
    source,
    evidence: [],
    brokerEventId: null,
    strategyId: null,
    signalId: e.signalKey,
    orderId: null,
    issues: [
      "legacy_settlement_unknown",
      "legacy_tax_unverified",
      "broker_net_cash_unverified",
      "opening_balance_unverified",
    ],
  };
  validateEvent(result);
  return result;
}
export interface ImportDecision {
  event: LedgerEvent;
  status: "INSERT" | "NOOP" | "QUARANTINE";
  reason: string;
  matches: string[];
}
const sourceKey = (e: LedgerEvent) =>
  `${e.book}:${e.bookId}:${e.source.system}:${e.source.recordId}`;
const normalizedFacts = (e: LedgerEvent) =>
  canonicalJson({
    book: e.book,
    bookId: e.bookId,
    kind: e.kind,
    effectiveDate: e.effectiveDate,
    effectiveSequence: e.effectiveSequence,
    settlementDate: e.settlementDate,
    securityId: e.securityId,
    quantity: e.quantity === null ? null : format(decimal(e.quantity)),
    price: e.price === null ? null : format(decimal(e.price)),
    currency: e.currency,
    gross: e.gross === null ? null : format(decimal(e.gross)),
    fee: e.fee === null ? null : format(decimal(e.fee)),
    tax: e.tax === null ? null : format(decimal(e.tax)),
    cashLegs: e.cashLegs.map((l) => ({
      ...l,
      amount: l.amount === null ? null : format(decimal(l.amount)),
    })),
    positionLegs: e.positionLegs.map((l) => ({
      ...l,
      quantity: format(decimal(l.quantity)),
      basisAdjustment: l.basisAdjustment === null ? null : format(decimal(l.basisAdjustment)),
    })),
    voided: e.voided,
    brokerEventId: e.brokerEventId,
    strategyId: e.strategyId,
    signalId: e.signalId,
    orderId: e.orderId,
    evidence: e.evidence,
    issues: [...e.issues].sort(),
  });
const economicKey = (e: LedgerEvent) =>
  canonicalJson({
    book: e.book,
    bookId: e.bookId,
    date: e.effectiveDate,
    kind: e.kind,
    security: e.securityId,
    quantity: e.quantity === null ? null : format(decimal(e.quantity)),
    price: e.price === null ? null : format(decimal(e.price)),
    currency: e.currency,
    accounts: [...new Set([...e.cashLegs, ...e.positionLegs].map((l) => l.accountId))].sort(),
  });
/** A dry-run staging plan only. Similarity never grants permission to merge source identities. */
export function planImport(existing: LedgerEvent[], incoming: LedgerEvent[]): ImportDecision[] {
  const known = [...existing];
  const decisions: ImportDecision[] = [];
  for (const event of incoming) {
    validateEvent(event);
    if (event.revision !== 1)
      throw new Error("Migration accepts initial versions only; use audited correction flow");
    const sameSource = known.filter((e) => sourceKey(e) === sourceKey(event));
    if (sameSource.length) {
      const latest = sameSource.reduce((a, b) => (a.revision > b.revision ? a : b));
      const identical =
        latest.source.contentHash === event.source.contentHash &&
        normalizedFacts(latest) === normalizedFacts(event);
      if (!identical)
        for (const previous of decisions) {
          if (sourceKey(previous.event) === sourceKey(event)) {
            previous.status = "QUARANTINE";
            previous.reason = "conflicting_incoming_source_revisions";
            previous.matches.push(event.id);
          }
        }
      decisions.push({
        event,
        status: identical ? "NOOP" : "QUARANTINE",
        reason: identical ? "source_already_recorded" : "source_changed_requires_correction",
        matches: [latest.id],
      });
      continue;
    }
    const possible = known.filter(
      (e) =>
        (event.brokerEventId !== null &&
          e.brokerEventId === event.brokerEventId &&
          e.book === event.book &&
          e.bookId === event.bookId) ||
        economicKey(e) === economicKey(event),
    );
    if (possible.length) {
      decisions.push({
        event,
        status: "QUARANTINE",
        reason: "cross_source_or_same_economic_event_requires_reconciliation",
        matches: possible.map((e) => e.id),
      });
      // When both are new candidates, neither wins by input ordering.
      for (const previous of decisions)
        if (possible.some((e) => e.id === previous.event.id) && previous.status === "INSERT") {
          previous.status = "QUARANTINE";
          previous.reason = "ambiguous_incoming_pair";
          previous.matches.push(event.id);
        }
    } else
      decisions.push({
        event,
        status: "INSERT",
        reason: "new_source_record_pending_review",
        matches: [],
      });
    known.push(event);
  }
  return decisions;
}
export function correctEvent(
  previous: LedgerEvent,
  corrected: LedgerEvent,
  reason: string,
): LedgerEvent {
  if (
    !reason.trim() ||
    corrected.id !== previous.id ||
    sourceKey(corrected) !== sourceKey(previous)
  )
    throw new Error("Correction must preserve identity and explain the change");
  const next = {
    ...corrected,
    revision: previous.revision + 1,
    previousRevision: previous.revision,
    correctionReason: reason.trim(),
  };
  validateEvent(next);
  return next;
}
