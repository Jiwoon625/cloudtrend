import type { ActualExecution } from "../portfolioLedgers";
import { decimal } from "./decimal";
import type { LedgerEvent, Security } from "./types";
import { currentEvents, validateSecurity, validateWebsiteExecution } from "./validation";

export type WebsiteSourceSystem = "portfolio_ledgers" | "us_actual_portfolio_ledgers";

export function validateWebsiteSource(sourceSystem: WebsiteSourceSystem): void {
  if (!["portfolio_ledgers", "us_actual_portfolio_ledgers"].includes(sourceSystem))
    throw new Error("Unsupported website ledger source");
}

/**
 * Project only complete ACTUAL chains with lossless source snapshots. Never invent a
 * website execution from rounded canonical decimals, or substitute stale legacy facts.
 */
export function projectWebsiteExecutions(
  events: readonly LedgerEvent[],
  sourceSystem: WebsiteSourceSystem,
  securities: readonly Security[],
): ActualExecution<string>[] {
  validateWebsiteSource(sourceSystem);
  const sourceIdentities = new Map<string, string>();
  const sourceSecurities = new Map<string, string>();
  for (const event of events) {
    if (
      event.book !== "ACTUAL" ||
      event.bookId !== "ACTUAL" ||
      event.source.system !== sourceSystem
    )
      throw new Error("Website journal scope mismatch");
    if (!["BUY", "SELL"].includes(event.kind))
      throw new Error("Website journal contains an unsupported event kind");
    const snapshot = event.appExecution ?? event.legacyExecution;
    if (!snapshot) throw new Error("Canonical website execution has no lossless snapshot");
    if (
      !event.securityId ||
      snapshot.id !== event.source.recordId ||
      typeof snapshot.symbol !== "string" ||
      !snapshot.symbol ||
      !["KOSPI", "KOSDAQ", "ETF", "US"].includes(snapshot.market) ||
      (sourceSystem === "us_actual_portfolio_ledgers") !== (snapshot.market === "US") ||
      event.currency !== (snapshot.market === "US" ? "USD" : "KRW")
    )
      throw new Error("Invalid website source security identity");
    const identity = JSON.stringify([
      event.securityId,
      event.currency,
      snapshot.symbol,
      snapshot.market,
    ]);
    const previousSecurity = sourceSecurities.get(event.id);
    if (previousSecurity !== undefined && previousSecurity !== identity)
      throw new Error("Website correction changed source security identity");
    sourceSecurities.set(event.id, identity);
    // A void does not release the immutable identity for reuse by a different event.
    const previous = sourceIdentities.get(event.source.recordId);
    if (previous !== undefined && previous !== event.id)
      throw new Error("Duplicate canonical website source identity");
    sourceIdentities.set(event.source.recordId, event.id);
  }
  const latest = currentEvents([...events]);
  const identities = new Map<string, Security>();
  for (const security of securities) {
    validateSecurity(security);
    if (identities.has(security.id)) throw new Error("Duplicate website security identity");
    identities.set(security.id, security);
  }
  return latest
    .map((event) => {
      const snapshot = event.appExecution ?? event.legacyExecution;
      if (!snapshot) throw new Error("Canonical website execution has no lossless snapshot");
      validateWebsiteExecution(event, snapshot);
      const security = identities.get(event.securityId!);
      if (
        !security ||
        security.symbol !== snapshot.symbol ||
        security.currency !== event.currency ||
        (snapshot.market === "ETF"
          ? security.assetType !== "ETF" || security.market === "US"
          : security.market !== snapshot.market ||
            (snapshot.market !== "US" && security.assetType === "ETF"))
      )
        throw new Error("Website projection security identity mismatch");
      // The compatibility execution format cannot express these additional economics.
      if (
        (event.tax !== null && decimal(event.tax) !== 0n) ||
        event.positionLegs.some((leg) => leg.basisAdjustment !== null)
      )
        throw new Error("Canonical execution economics are not projectable to the website");
      const netCash = event.cashLegs[0]!.amount;
      if (
        netCash !== null &&
        decimal(netCash) !==
          (event.kind === "BUY" ? -decimal(event.gross!) : decimal(event.gross!)) -
            decimal(event.fee!)
      )
        throw new Error("Canonical net cash is not projectable to the website");
      return structuredClone(snapshot);
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
