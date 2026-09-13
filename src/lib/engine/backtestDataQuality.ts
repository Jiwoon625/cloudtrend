import type { MarketDataset } from "./dataset";
import { CANONICAL_SOURCE_COLUMNS, type SourceValidationResult } from "../sourceData";

export const BACKTEST_DATA_QUALITY_VERSION = "backtest-data-quality-v1" as const;

type QualityInput = {
  id: string;
  fileName: string | null;
  validation: SourceValidationResult;
};

const SOURCE_COLUMNS = CANONICAL_SOURCE_COLUMNS.filter((column) =>
  column.toLowerCase().endsWith("source"),
);

const rate = (count: number, total: number) => total ? Math.round(count / total * 1_000_000) / 10_000 : 0;

function fieldCoverage(inputs: QualityInput[]) {
  const years = new Map<string, { rows: number; counts: Record<string, number> }>();
  const overall = Object.fromEntries(CANONICAL_SOURCE_COLUMNS.map((column) => [column, 0]));
  let totalRows = 0;
  for (const input of inputs) {
    for (const row of input.validation.rows) {
      totalRows++;
      const year = row.date.slice(0, 4);
      const bucket = years.get(year) ?? {
        rows: 0,
        counts: Object.fromEntries(CANONICAL_SOURCE_COLUMNS.map((column) => [column, 0])),
      };
      bucket.rows++;
      for (const column of CANONICAL_SOURCE_COLUMNS) {
        if (!(row[column] ?? "").trim()) continue;
        overall[column] = (overall[column] ?? 0) + 1;
        bucket.counts[column] = (bucket.counts[column] ?? 0) + 1;
      }
      years.set(year, bucket);
    }
  }
  const summarize = (counts: Record<string, number>, rows: number) => Object.fromEntries(
    CANONICAL_SOURCE_COLUMNS.map((column) => [column, {
      nonEmpty: counts[column] ?? 0,
      completenessPct: rate(counts[column] ?? 0, rows),
      missingPct: Math.round((100 - rate(counts[column] ?? 0, rows)) * 10_000) / 10_000,
    }]),
  );
  return {
    totalRows,
    overall: summarize(overall, totalRows),
    byYear: Object.fromEntries([...years.entries()].sort().map(([year, bucket]) => [year, {
      rows: bucket.rows,
      fields: summarize(bucket.counts, bucket.rows),
    }])),
  };
}

function sourceDistribution(inputs: QualityInput[]) {
  const counts = new Map<string, Map<string, number>>();
  for (const input of inputs) for (const row of input.validation.rows) for (const column of SOURCE_COLUMNS) {
    const value = (row[column] ?? "").trim() || "MISSING";
    const bucket = counts.get(column) ?? new Map<string, number>();
    bucket.set(value, (bucket.get(value) ?? 0) + 1);
    counts.set(column, bucket);
  }
  return Object.fromEntries([...counts.entries()].map(([column, bucket]) => {
    const total = [...bucket.values()].reduce((sum, value) => sum + value, 0);
    return [column, Object.fromEntries([...bucket.entries()].sort((a, b) => b[1] - a[1]).map(
      ([value, count]) => [value, { rows: count, pct: rate(count, total) }],
    ))];
  }));
}

function indexContinuity(dataset: MarketDataset) {
  const stockDates = new Set(dataset.instruments
    .filter((instrument) => instrument.instrumentType === "STOCK")
    .flatMap((instrument) => (dataset.bars[instrument.symbol] ?? []).map((bar) => bar.tradeDate)));
  const indexes = Object.fromEntries(["KOSPI", "KOSDAQ"].map((code) => {
    const series = dataset.indexSeries.find((item) => item.indexCode === code);
    const dates = new Set(series?.bars.map((bar) => bar.tradeDate) ?? []);
    const expected = [...stockDates].filter((date) => date >= (dataset.tradeDates[0] ?? "") && date <= dataset.asOfDate).sort();
    const missingDates = expected.filter((date) => !dates.has(date));
    return [code, {
      present: Boolean(series),
      firstDate: series?.bars[0]?.tradeDate ?? null,
      lastDate: series?.bars.at(-1)?.tradeDate ?? null,
      observedTradingDays: dates.size,
      expectedTradingDays: expected.length,
      coveragePct: rate(expected.length - missingDates.length, expected.length),
      missingTradingDayCount: missingDates.length,
      missingTradingDates: missingDates.slice(0, 200),
      missingDatesTruncated: missingDates.length > 200,
    }];
  }));
  return { expectedCalendar: "union of observed STOCK dates", indexes };
}

function universeCoverage(dataset: MarketDataset, limit: number) {
  const instruments = dataset.instruments
    .filter((instrument) => instrument.instrumentType === "STOCK")
    .sort((a, b) => (dataset.bars[b.symbol]?.at(-1)?.tradingValue ?? 0) - (dataset.bars[a.symbol]?.at(-1)?.tradingValue ?? 0))
    .slice(0, limit);
  const calendars = Object.fromEntries(["KOSPI", "KOSDAQ"].map((code) => [code,
    dataset.indexSeries.find((item) => item.indexCode === code)?.bars.map((bar) => bar.tradeDate) ?? [],
  ])) as Record<string, string[]>;
  const symbols = instruments.map((instrument) => {
    const dates = new Set((dataset.bars[instrument.symbol] ?? []).map((bar) => bar.tradeDate));
    const firstDate = [...dates].sort()[0] ?? null;
    const lastDate = [...dates].sort().at(-1) ?? null;
    const calendar = calendars[instrument.market] ?? calendars.KOSPI ?? [];
    const leading = firstDate ? calendar.filter((date) => date < firstDate).length : calendar.length;
    const trailing = lastDate ? calendar.filter((date) => date > lastDate).length : calendar.length;
    const span = firstDate && lastDate ? calendar.filter((date) => date >= firstDate && date <= lastDate) : [];
    const internalMissing = span.filter((date) => !dates.has(date));
    return {
      symbol: instrument.symbol,
      name: instrument.name,
      market: instrument.market,
      sectorCode: instrument.sectorCode,
      firstDate,
      lastDate,
      observedDays: dates.size,
      expectedDaysWithinObservedSpan: span.length,
      coverageWithinObservedSpanPct: rate(span.length - internalMissing.length, span.length),
      leadingUnobservedDays: leading,
      internalMissingDays: internalMissing.length,
      trailingUnobservedDays: trailing,
      classification: internalMissing.length > 0
        ? "INTERNAL_COLLECTION_GAP"
        : trailing > 0
          ? "POST_OBSERVATION_UNRESOLVED"
          : leading > 0
            ? "PRE_OBSERVATION_POSSIBLE_PRELISTING"
            : "COMPLETE",
    };
  });
  return {
    requestedUniverseSize: limit,
    actualUniverseSize: symbols.length,
    completeCount: symbols.filter((item) => item.classification === "COMPLETE").length,
    internalGapCount: symbols.filter((item) => item.internalMissingDays > 0).length,
    leadingUnobservedCount: symbols.filter((item) => item.leadingUnobservedDays > 0).length,
    trailingUnobservedCount: symbols.filter((item) => item.trailingUnobservedDays > 0).length,
    interpretation: "Leading gaps may be pre-listing but cannot be proven without official listing dates; internal gaps are collection-failure candidates; trailing gaps require delisting/suspension checks.",
    symbols,
  };
}

export function buildBacktestDataQuality(inputs: QualityInput[], dataset: MarketDataset, limit = 613) {
  const generatedAt = new Date().toISOString();
  const fields = fieldCoverage(inputs);
  return {
    version: BACKTEST_DATA_QUALITY_VERSION,
    generatedAt,
    sourceFileCount: inputs.length,
    totalRows: fields.totalRows,
    from: dataset.tradeDates[0] ?? null,
    to: dataset.asOfDate,
    fieldCompleteness: fields,
    sourceDistribution: sourceDistribution(inputs),
    indexContinuity: indexContinuity(dataset),
    universeCoverage: universeCoverage(dataset, limit),
    fileQuality: inputs.map((input) => ({
      sourceId: input.id,
      fileName: input.fileName,
      rows: input.validation.stats.rowCount,
      from: input.validation.stats.minDate,
      to: input.validation.stats.maxDate,
      suppliedColumns: input.validation.columns.length,
      populatedColumns: input.validation.stats.populatedColumnCount,
      completelyEmptySuppliedColumns: input.validation.stats.completelyEmptyColumns.filter(
        (column) => input.validation.columns.includes(column),
      ),
      sectorUnmappedCount: input.validation.stats.sectorUnmappedCount,
    })),
  };
}

