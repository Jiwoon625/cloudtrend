import { validDate } from "./date";
export { validDate } from "./date";
import { validateExecutionSourceLinks } from "./executionMemo";
import { decimal, fromLegacyNumber, multiply, representedLegacyNumber } from "./decimal";
import type { ActualExecution } from "../portfolioLedgers";
import type { LedgerEvent, Security, SourceRef } from "./types";

export function validateSource(source: SourceRef) {
  if (
    !["portfolio_ledgers", "us_actual_portfolio_ledgers", "notion", "broker", "model"].includes(
      source.system,
    )
  )
    throw new Error("Unsupported source system");
  if (!source.recordId || !source.revision || !/^sha256:[a-f0-9]{64}$/.test(source.contentHash))
    throw new Error("Source identity/hash is required");
}
export function validateSecurity(s: Security) {
  if (
    !["KOSPI", "KOSDAQ", "US"].includes(s.market) ||
    !["STOCK", "ETF", "UNKNOWN"].includes(s.assetType)
  )
    throw new Error("Unsupported security market/type");
  if (!s.id || !s.symbol || !s.name) throw new Error("Security identity is required");
  if (s.market === "US" ? s.currency !== "USD" : s.currency !== "KRW")
    throw new Error("Listing currency mismatch");
  if (s.market !== "US" && !/^[A-Z0-9]{6}$/.test(s.symbol))
    throw new Error("Preserve six-character Korean security code");
}
/** A website snapshot must represent this revision, including the original binary average price. */
export function validateWebsiteExecution(e: LedgerEvent, execution: ActualExecution<string>) {
  validateExecutionSourceLinks(execution.sourceLinks);
  if (
    e.book !== "ACTUAL" ||
    e.bookId !== "ACTUAL" ||
    !["BUY", "SELL"].includes(e.kind) ||
    !["portfolio_ledgers", "us_actual_portfolio_ledgers"].includes(e.source.system) ||
    typeof execution.id !== "string" ||
    !execution.id ||
    execution.id !== e.source.recordId ||
    typeof execution.symbol !== "string" ||
    !execution.symbol ||
    typeof execution.name !== "string" ||
    !execution.name ||
    typeof execution.note !== "string" ||
    (execution.signalKey !== null && typeof execution.signalKey !== "string") ||
    !["KOSPI", "KOSDAQ", "ETF", "US"].includes(execution.market) ||
    (e.source.system === "us_actual_portfolio_ledgers") !== (execution.market === "US") ||
    e.currency !== (execution.market === "US" ? "USD" : "KRW") ||
    !Number.isFinite(execution.price) ||
    execution.price <= 0 ||
    !Number.isFinite(execution.shares) ||
    execution.shares <= 0 ||
    !Number.isFinite(execution.fee) ||
    execution.fee < 0
  )
    throw new Error("Invalid website source execution snapshot");
  if (
    e.quantity === null ||
    e.price === null ||
    e.gross === null ||
    e.fee === null ||
    decimal(fromLegacyNumber(execution.shares)) !== decimal(e.quantity) ||
    decimal(representedLegacyNumber(execution.price)) !== decimal(e.price) ||
    decimal(representedLegacyNumber(execution.price * execution.shares)) !== decimal(e.gross) ||
    decimal(fromLegacyNumber(execution.fee)) !== decimal(e.fee) ||
    execution.side !== e.kind ||
    execution.date !== e.effectiveDate ||
    execution.order !== e.effectiveSequence ||
    execution.signalKey !== e.signalId
  )
    throw new Error("Website snapshot disagrees with canonical execution");
}
export function validateEvent(e: LedgerEvent) {
  validateExecutionSourceLinks(e.sourceLinks);
  if (
    !["ACTUAL", "MODEL"].includes(e.book) ||
    !["KRW", "USD"].includes(e.currency) ||
    ![
      "BUY",
      "SELL",
      "DIVIDEND",
      "INTEREST",
      "FEE",
      "TAX",
      "DEPOSIT",
      "WITHDRAWAL",
      "FX",
      "TRANSFER",
      "CORPORATE_ACTION",
    ].includes(e.kind)
  )
    throw new Error("Unsupported journal book/currency/event type");
  if (!e.id || !e.bookId || typeof e.voided !== "boolean")
    throw new Error("Event identity and void status are required");
  validateSource(e.source);
  if (e.legacyExecution && (e.book !== "ACTUAL" || !["BUY", "SELL"].includes(e.kind)))
    throw new Error("Legacy execution metadata is only valid on source fills");
  if (e.appExecution !== undefined) {
    if (!e.appExecution || typeof e.appExecution !== "object" || Array.isArray(e.appExecution))
      throw new Error("Invalid website source execution snapshot");
    validateWebsiteExecution(e, e.appExecution);
  }
  if (e.book === "ACTUAL" && e.bookId !== "ACTUAL")
    throw new Error("Actual events use one logical book");
  if (e.book === "MODEL" && e.bookId === "ACTUAL")
    throw new Error("Models cannot enter the actual book");
  if (
    !validDate(e.effectiveDate) ||
    (e.settlementDate !== null &&
      (!validDate(e.settlementDate) || e.settlementDate < e.effectiveDate))
  )
    throw new Error("Invalid event/settlement date");
  if (!Number.isSafeInteger(e.effectiveSequence) || e.effectiveSequence < 0)
    throw new Error("Event sequence is required");
  if (!e.recordedBy.trim()) throw new Error("Recording actor is required");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(e.recordedAt) ||
    !Number.isFinite(Date.parse(e.recordedAt))
  )
    throw new Error("Recorded timestamp is required");
  if (
    !Number.isInteger(e.revision) ||
    e.revision < 1 ||
    (e.revision === 1
      ? e.previousRevision !== null
      : e.previousRevision !== e.revision - 1 || !e.correctionReason?.trim())
  )
    throw new Error("Correction must reference its predecessor and reason");
  for (const field of [e.quantity, e.price, e.gross, e.fee, e.tax])
    if (field !== null && decimal(field) < 0n)
      throw new Error("Trade quantities and amounts cannot be negative");
  if (
    [...e.cashLegs, ...e.positionLegs].some((leg) => leg.accountId.startsWith("UNASSIGNED:")) &&
    !e.issues.includes("account_mapping_unverified")
  )
    throw new Error("Unassigned account attribution must remain explicit");
  for (const leg of e.cashLegs) {
    if (!leg.accountId || !["KRW", "USD"].includes(leg.currency))
      throw new Error("Cash account/currency required");
    if (leg.amount !== null) decimal(leg.amount);
  }
  for (const leg of e.positionLegs) {
    if (!leg.accountId || !leg.securityId) throw new Error("Position identity required");
    decimal(leg.quantity);
    if (leg.basisAdjustment !== null) decimal(leg.basisAdjustment);
  }
  if (["BUY", "SELL"].includes(e.kind)) {
    if (
      !e.securityId ||
      e.gross === null ||
      e.quantity === null ||
      e.price === null ||
      decimal(e.quantity) <= 0n ||
      decimal(e.price) <= 0n ||
      e.cashLegs.length !== 1 ||
      e.positionLegs.length !== 1
    )
      throw new Error("Fill requires security, positive quantity/price and one cash/position leg");
    const cash = e.cashLegs[0]!.amount;
    if (cash !== null && (e.kind === "BUY" ? decimal(cash) >= 0n : decimal(cash) <= 0n))
      throw new Error("Fill cash has wrong direction");
    const leg = e.positionLegs[0]!;
    if (
      leg.securityId !== e.securityId ||
      leg.accountId !== e.cashLegs[0]!.accountId ||
      e.cashLegs[0]!.currency !== e.currency ||
      decimal(leg.quantity) !== decimal(e.quantity) * (e.kind === "BUY" ? 1n : -1n)
    )
      throw new Error("Fill legs disagree with execution");
  }
  if (["BUY", "SELL"].includes(e.kind) && e.gross !== null) {
    const legacy = e.legacyExecution;
    if (
      legacy &&
      (!["portfolio_ledgers", "us_actual_portfolio_ledgers"].includes(e.source.system) ||
        legacy.id !== e.source.recordId ||
        !Number.isFinite(legacy.price) ||
        legacy.price <= 0 ||
        !Number.isFinite(legacy.shares) ||
        legacy.shares <= 0 ||
        !Number.isFinite(legacy.fee) ||
        legacy.fee < 0)
    )
      throw new Error("Invalid retained legacy source execution");
    const legacyEconomicValuesMatch =
      legacy !== undefined &&
      fromLegacyNumber(legacy.shares) === e.quantity &&
      representedLegacyNumber(legacy.price) === e.price &&
      representedLegacyNumber(legacy.price * legacy.shares) === e.gross;
    if (
      legacy &&
      e.revision === 1 &&
      (!legacyEconomicValuesMatch ||
        legacy.side !== e.kind ||
        legacy.date !== e.effectiveDate ||
        legacy.order !== e.effectiveSequence ||
        fromLegacyNumber(legacy.fee) !== e.fee ||
        legacy.signalKey !== e.signalId)
    )
      throw new Error("Legacy projection disagrees with source execution");
    if (
      !legacyEconomicValuesMatch &&
      !e.appExecution &&
      decimal(e.gross) !== multiply(decimal(e.quantity!), decimal(e.price!))
    )
      throw new Error("Fill gross disagrees with quantity/price");
    const net = e.cashLegs[0]!.amount;
    if (net !== null) {
      const knownCosts =
        (e.fee === null ? 0n : decimal(e.fee)) + (e.tax === null ? 0n : decimal(e.tax));
      const maximumNet = (e.kind === "BUY" ? -decimal(e.gross) : decimal(e.gross)) - knownCosts;
      if (decimal(net) > maximumNet)
        throw new Error("Net cash contradicts nonnegative unknown costs");
    }
    if (e.fee !== null && e.tax !== null && e.cashLegs[0]!.amount !== null) {
      const expected =
        (e.kind === "BUY" ? -decimal(e.gross) : decimal(e.gross)) - decimal(e.fee) - decimal(e.tax);
      if (decimal(e.cashLegs[0]!.amount!) !== expected)
        throw new Error("Net cash disagrees with gross/fee/tax");
    }
  }
  if (!["BUY", "SELL", "CORPORATE_ACTION"].includes(e.kind) && e.positionLegs.length)
    throw new Error("Cash events cannot change security quantity");
  if (["DIVIDEND", "INTEREST", "FEE", "TAX", "DEPOSIT", "WITHDRAWAL"].includes(e.kind)) {
    if (e.cashLegs.length !== 1 || e.cashLegs[0]!.currency !== e.currency)
      throw new Error("Cash event requires one currency leg");
    const amount = e.cashLegs[0]!.amount;
    if (
      amount !== null &&
      (["FEE", "TAX", "WITHDRAWAL"].includes(e.kind)
        ? decimal(amount) >= 0n
        : decimal(amount) <= 0n)
    )
      throw new Error("Cash event has wrong sign");
  }
  if (
    e.kind === "FX" &&
    (e.cashLegs.length !== 2 || new Set(e.cashLegs.map((l) => l.currency)).size !== 2)
  )
    throw new Error("FX requires both currency legs");
  if (
    e.kind === "TRANSFER" &&
    (e.cashLegs.length !== 2 ||
      new Set(e.cashLegs.map((l) => l.accountId)).size !== 2 ||
      new Set(e.cashLegs.map((l) => l.currency)).size !== 1)
  )
    throw new Error("Transfer requires two accounts in one currency");
  if (["FX", "TRANSFER"].includes(e.kind) && e.cashLegs.every((l) => l.amount !== null)) {
    const a = decimal(e.cashLegs[0]!.amount!),
      b = decimal(e.cashLegs[1]!.amount!);
    if (a === 0n || b === 0n || a > 0n === b > 0n)
      throw new Error("Transfer/FX must contain opposite signed legs");
    if (e.kind === "TRANSFER" && a + b !== 0n)
      throw new Error("Transfer must balance; record fees separately");
  }
  for (const ref of e.evidence)
    if (!ref.id || !ref.locator || /[?&](token|signature|x-amz-|expires)/i.test(ref.locator))
      throw new Error("Use stable evidence identity, not signed URLs");
}
/** Resolve a complete immutable revision chain, then replay corrected facts from the beginning. */
export function currentEvents(events: LedgerEvent[]): LedgerEvent[] {
  const grouped = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    validateEvent(event);
    const key = `${event.book}:${event.bookId}:${event.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  const resolved = [...grouped.values()]
    .map((versions) => {
      versions.sort((a, b) => a.revision - b.revision);
      const first = versions[0]!;
      versions.forEach((e, i) => {
        if (e.revision !== i + 1) throw new Error("Missing or duplicate event revision");
        if (e.source.system !== first.source.system || e.source.recordId !== first.source.recordId)
          throw new Error("Correction changed original source identity");
        const sortedLegacy = (value: LedgerEvent["legacyExecution"]) =>
          value
            ? JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : "null";
        if (sortedLegacy(e.legacyExecution) !== sortedLegacy(first.legacyExecution))
          throw new Error("Correction changed retained legacy source metadata");
      });
      return versions.at(-1)!;
    })
    .filter((e) => !e.voided);
  const sources = new Set<string>();
  for (const e of resolved) {
    const key = `${e.book}:${e.bookId}:${e.source.system}:${e.source.recordId}`;
    if (sources.has(key))
      throw new Error("Duplicate canonical source event; reconcile before valuation");
    sources.add(key);
  }
  return resolved.sort(
    (a, b) =>
      a.effectiveDate.localeCompare(b.effectiveDate) ||
      a.effectiveSequence - b.effectiveSequence ||
      a.id.localeCompare(b.id),
  );
}
