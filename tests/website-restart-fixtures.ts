import {
  freezeRestartSeries,
  hashSeriesValue,
  type AdoptedSeriesKind,
} from "../src/lib/ledger/modelSeries";
import {
  summarizeOctoberShadowBook,
  type OctoberShadowSummary,
} from "../src/lib/octoberShadowSummary.server";
import { hash, registry, sessionRow, usRun } from "./october-shadow-fixtures";
export const restartCheckedAt = "2026-10-12T21:00:00Z";
export const restartSeries = (kind: AdoptedSeriesKind = "US_A0") =>
  freezeRestartSeries({
    kind,
    frozenAt: "2026-10-09T12:00:00Z",
    codeHash: hash("a"),
    sourceHash: hash("b"),
  });
export async function restartBook(kind: AdoptedSeriesKind = "US_A0", recorded = false) {
  const series = await restartSeries(kind);
  if (!recorded)
    return summarizeOctoberShadowBook(kind, registry(series), [], true, restartCheckedAt);
  const { stateHash: _oldHash, ...run } = await usRun(series, "2026-10-12");
  run.calendar.coverageEnd = "2026-10-12";
  run.calendar.regularSessions.push("2026-10-12");
  return summarizeOctoberShadowBook(
    kind,
    registry(series),
    [sessionRow({ ...run, stateHash: await hashSeriesValue(run) })],
    true,
    restartCheckedAt,
  );
}
export async function restartSummary(recorded = false): Promise<OctoberShadowSummary> {
  return {
    version: "adopted-shadow-2026-10-12-v1",
    viewVersion: "october-shadow-holdings-tax-v2",
    checkedAt: restartCheckedAt,
    readyForPortfolioConsolidation: true,
    replayStatus: [],
    books: [await restartBook("US_A0", recorded)],
  };
}
