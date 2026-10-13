import { validDate } from "./ledger/date";
import { OPERATIONAL_SIGNAL_START } from "./operationalSignalStart";

/** The September operating books are frozen research history, never current books. */
export function usesLegacyUsOperatingLedger(date: string): boolean {
  if (!validDate(date)) throw new Error("Invalid US ledger session date");
  return date < OPERATIONAL_SIGNAL_START;
}

/** Old recovery plans contain October 5 book IDs and must never cross the restart. */
export function assertLegacyUsRecoveryDate(date: string): void {
  if (!usesLegacyUsOperatingLedger(date))
    throw new Error(
      "Legacy US recovery is historical-only before 2026-10-12; use a reviewed restart-series recovery plan",
    );
}
