import type { ActualExecution } from "../portfolioLedgers";
import type { Security, LedgerEvent, SourceRef } from "./types";
import { decimal, format, fromLegacyNumber, representedLegacyNumber } from "./decimal";
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
/** No account inference. An explicitly UNASSIGNED bucket is allowed but never a verified account. */
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
  if (!Number.isFinite(e.price) || e.price <= 0 || e.price > Number.MAX_SAFE_INTEGER)
    throw new Error("Legacy price is not safely representable");
  const quantity = fromLegacyNumber(e.shares),
    price = representedLegacyNumber(e.price),
    fee = fromLegacyNumber(e.fee);
  // An aggregate average price can be repeating. Preserve the original app gross,
  // not quantity multiplied by an already rounded journal display price.
  const gross = representedLegacyNumber(e.price * e.shares);
  const result: LedgerEvent = {
    legacyExecution: { ...e },
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
      ...(input.accountId.startsWith("UNASSIGNED:") ? ["account_mapping_unverified"] : []),
      ...(Number(price) !== e.price ? ["legacy_average_price_precision_preserved_in_source"] : []),
      "legacy_settlement_unknown",
      "legacy_tax_unverified",
      "broker_net_cash_unverified",
      "opening_balance_unverified",
    ],
  };
  validateEvent(result);
  return result;
}
/** Lossless compatibility read for a source-only migration. No canonical record is invented. */
export function projectLegacyExecutions(
  events: LedgerEvent[],
  verifiedSource: {
    system: SourceRef["system"];
    revision: string;
    executions: ActualExecution<string>[];
  },
  securities: Security[],
): ActualExecution<string>[] {
  if (
    events.length !== verifiedSource.executions.length ||
    new Set(events.map((e) => e.source.recordId)).size !== events.length
  )
    throw new Error("Legacy projection requires complete unique source coverage");
  return events.map((event) => {
    validateEvent(event);
    if (event.book !== "ACTUAL" || event.revision !== 1 || event.voided || !event.legacyExecution)
      throw new Error(
        "Only unchanged migrated actual source records can use the legacy projection",
      );
    const originals = verifiedSource.executions.filter((e) => e.id === event.source.recordId);
    const identities = securities.filter((s) => s.id === event.securityId);
    if (
      event.source.system !== verifiedSource.system ||
      event.source.revision !== verifiedSource.revision ||
      originals.length !== 1 ||
      canonicalJson(originals[0]) !== canonicalJson(event.legacyExecution) ||
      identities.length !== 1 ||
      identities[0]!.symbol !== event.legacyExecution.symbol ||
      identities[0]!.currency !== event.currency ||
      (event.legacyExecution.market === "ETF"
        ? identities[0]!.assetType !== "ETF" || identities[0]!.market === "US"
        : identities[0]!.market !== event.legacyExecution.market)
    )
      throw new Error("Legacy projection requires matching verified source and security identity");
    return { ...event.legacyExecution };
  });
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
    legacyExecution: e.legacyExecution ?? null,
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
  if (
    canonicalJson(previous.legacyExecution ?? null) !==
    canonicalJson(corrected.legacyExecution ?? null)
  )
    throw new Error("Correction must preserve original legacy execution metadata");
  const next = {
    ...corrected,
    revision: previous.revision + 1,
    previousRevision: previous.revision,
    correctionReason: reason.trim(),
  };
  validateEvent(next);
  return next;
}
