import { RESTART_ACCOUNTING_START, RESTART_SERIES_VERSION } from "./ledger/modelSeries";
import type { OctoberShadowSummary } from "./octoberShadowSummary.server";

export const WEBSITE_PERFORMANCE_START = RESTART_ACCOUNTING_START;
/** Display-only boundary. Historical contracts, sessions and source journals remain intact. */
export function websiteShadowSummary(
  input: OctoberShadowSummary | null,
): OctoberShadowSummary | null {
  if (!input || input.version !== RESTART_SERIES_VERSION) return null;
  return {
    ...input,
    replayStatus: input.replayStatus.filter((r) => r.signalDate >= WEBSITE_PERFORMANCE_START),
    books: input.books.filter(
      (book) =>
        book.bookId === `${RESTART_SERIES_VERSION}:${book.kind}` &&
        book.scheduledStart === WEBSITE_PERFORMANCE_START &&
        [book.firstSessionDate, book.latestSessionDate].every(
          (date) => date === null || date >= WEBSITE_PERFORMANCE_START,
        ) &&
        (book.history ?? []).every((point) => point.date >= WEBSITE_PERFORMANCE_START) &&
        (book.trades ?? []).every((trade) => trade.date >= WEBSITE_PERFORMANCE_START) &&
        book.holdings.every((holding) => holding.entryDate >= WEBSITE_PERFORMANCE_START),
    ),
  };
}

/** Display copy only: keep archived baseline evidence intact for validation and saving. */
export function visiblePerformanceEvidence(input: unknown): string {
  return JSON.stringify(input, (key, value) => (key === "betaArchive" ? undefined : value), 2);
}
