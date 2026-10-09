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

/** A later adjusted-price source cannot silently introduce a different price basis. */
export function verifyExtensionPriceContinuity(
  base: MarketDataset,
  overlap: MarketDataset,
  afterDate: string,
  pinnedCoverage?: { totalRows: number; minComparedRows: number; indexRows: number; maxNewRows: number; maxNewSymbols: number },
) {
  if (!validDate(afterDate)) throw new Error("Invalid extension continuity boundary");
  if (overlap.instruments.some((instrument) => instrument.instrumentType !== "STOCK"))
    throw new Error("Unexpected non-stock in extension continuity evidence");
  const series = (dataset: MarketDataset) =>
    new Map([
      ...Object.entries(dataset.observedBars ?? {}),
      ...dataset.indexSeries.map((index) => [index.indexCode, index.bars] as const),
    ]);
  const originals = series(base);
  let comparedRows = 0,
    unmatchedRows = 0,
    comparedIndexRows = 0;
  const matchedIndexSymbols = new Set<string>();
  const newSymbols = new Set<string>();
  for (const [symbol, rows] of series(overlap)) {
    const before = new Map((originals.get(symbol) ?? []).filter((bar) => bar.tradeDate <= afterDate).map((bar) => [bar.tradeDate, bar]));
    for (const observation of rows) {
      if (observation.tradeDate > afterDate)
        throw new Error("Extension continuity evidence crosses cutoff");
      const original = before.get(observation.tradeDate);
      if (!original) {
        if (before.size || symbol === "KOSPI" || symbol === "KOSDAQ")
          throw new Error("Missing existing-source extension continuity observation");
        newSymbols.add(symbol);
        unmatchedRows++;
        continue;
      }
      for (const key of ["open", "high", "low", "close"] as const)
        if (original[key] !== observation[key])
          throw new Error("Extension OHLC continuity mismatch");
      comparedRows++;
      if (symbol === "KOSPI" || symbol === "KOSDAQ") {
        comparedIndexRows++;
        matchedIndexSymbols.add(symbol);
      }
    }
  }
  if (matchedIndexSymbols.size !== 2 || comparedRows <= comparedIndexRows)
    throw new Error("Insufficient extension price continuity evidence");
  if (pinnedCoverage && (
    comparedRows + unmatchedRows !== pinnedCoverage.totalRows ||
    comparedRows < pinnedCoverage.minComparedRows ||
    comparedIndexRows !== pinnedCoverage.indexRows ||
    unmatchedRows > pinnedCoverage.maxNewRows || newSymbols.size > pinnedCoverage.maxNewSymbols
  )) throw new Error("Pinned extension continuity coverage mismatch");
  return {
    status: "PASS" as const,
    afterDate,
    comparedRows,
    unmatchedRows,
    comparedIndexRows,
    comparedFields: ["open", "high", "low", "close"],
    priceBasisAdjusted: false,
  };
}
