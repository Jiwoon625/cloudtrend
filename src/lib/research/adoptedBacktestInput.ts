import type { MarketDataset } from "../engine/dataset";
import { shadowDatasetAsOf } from "../engine/kospiShadowDataset";
import { validDate } from "../ledger/date";

export function assertOrderedSessions(sessions: unknown): asserts sessions is string[] {
  if (
    !Array.isArray(sessions) ||
    !sessions.length ||
    sessions.some(
      (date, index) =>
        typeof date !== "string" || !validDate(date) || (index > 0 && date <= sessions[index - 1]),
    )
  )
    throw new Error("Manifest requires nonempty, unique, increasing actual sessions");
}

export function selectBacktestSessions(
  sessions: string[],
  start: string,
  through: string,
  smokeSessions?: number,
) {
  assertOrderedSessions(sessions);
  if (
    !validDate(start) ||
    !validDate(through) ||
    start > through ||
    !sessions.includes(start) ||
    !sessions.includes(through)
  )
    throw new Error("Selected boundaries must be covered actual market sessions");
  const selected = sessions.filter((date) => date >= start && date <= through);
  if (smokeSessions !== undefined) {
    if (!Number.isInteger(smokeSessions) || smokeSessions < 20 || smokeSessions > 60)
      throw new Error("Smoke requires 20 through 60 sessions");
    if (selected.length < smokeSessions) throw new Error("Not enough selected sessions for smoke");
    return selected.slice(0, smokeSessions);
  }
  return selected;
}

/** Keep the entire earlier price history, including recursive ATR seeds. No tail(252). */
export function adoptedDatasetAsOf(raw: MarketDataset, date: string): MarketDataset {
  const ds = shadowDatasetAsOf(raw, date);
  const dated = <T>(values: Record<string, T> | undefined) =>
    values ? Object.fromEntries(Object.entries(values).filter(([day]) => day <= date)) : undefined;
  const liquid = dated(raw.liquidSymbolCountsByDate);
  const defects = dated(raw.kospiPriceInputIssues);
  return {
    ...ds,
    // Product facts lack an observation date. They cannot be projected backwards.
    etfFacts: {},
    capabilities: { ...ds.capabilities, etfFacts: false },
    // The legacy gate may use this array: rebuild only from dated observations.
    vkospiSeries: (ds.vkospiObservations ?? []).flatMap((point) =>
      point.value !== null && Number.isFinite(point.value) ? [point.value] : [],
    ),
    ...(liquid ? { liquidSymbolCountsByDate: liquid } : {}),
    ...(defects ? { kospiPriceInputIssues: defects } : {}),
  };
}

export function assertResearchDataset(dataset: MarketDataset) {
  assertOrderedSessions(dataset.tradeDates);
  if (!validDate(dataset.asOfDate) || dataset.tradeDates.at(-1)! > dataset.asOfDate)
    throw new Error("Invalid dataset source range");
  if (!dataset.observedBars)
    throw new Error("Canonical observedBars are required; display bars are not execution evidence");
  if (new Set(dataset.instruments.map((row) => row.symbol)).size !== dataset.instruments.length)
    throw new Error("Duplicate dataset instruments");
  for (const rows of [
    ...Object.values(dataset.bars),
    ...Object.values(dataset.observedBars),
    ...dataset.indexSeries.map((series) => series.bars),
  ]) {
    if (
      rows.some(
        (row, i) => !validDate(row.tradeDate) || (i > 0 && row.tradeDate <= rows[i - 1]!.tradeDate),
      )
    )
      throw new Error("Canonical bars must be unique and chronological");
  }
}
