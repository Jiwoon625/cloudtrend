import type { UsProspectiveCache } from "./usProspectiveCloud";
export type UsProspectiveSummary = Omit<UsProspectiveCache, "analysis"> & {
  analysis: Omit<UsProspectiveCache["analysis"], "rows"> & { rowCount: number };
};
/** Project completed results only; never recompute signals or carry engine state to the UI. */
export function usBrowserViews(result: UsProspectiveCache) {
  const { generatedAt, dataHash, source } = result;
  const { date, ruleVersion, summary, rows } = result.analysis;
  const base = { generatedAt, dataHash, source };
  return {
    screening: { ...base, analysis: { date, ruleVersion, summary, rows } },
    summary: {
      ...base,
      analysis: { date, ruleVersion, summary, rowCount: rows.length },
    } satisfies UsProspectiveSummary,
  };
}
