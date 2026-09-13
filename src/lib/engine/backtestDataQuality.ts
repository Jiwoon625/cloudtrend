import type { MarketDataset } from "./dataset";
import {
  CANONICAL_SOURCE_COLUMNS,
  visitDelimitedRows,
  type SourceValidationResult,
} from "../sourceData";

export const BACKTEST_DATA_QUALITY_VERSION = "backtest-data-quality-v1" as const;

type QualityInput = {
  id: string;
  fileName: string | null;
  text: string;
  validation: SourceValidationResult;
};

const SOURCE_COLUMNS = CANONICAL_SOURCE_COLUMNS.filter((column) =>
  column.toLowerCase().endsWith("source"),
);

const rate = (count: number, total: number) =>
  total ? Math.round((count / total) * 1_000_000) / 10_000 : 0;

const QA_HEADER_ALIASES: Record<string, string> = {
  code: "symbol",
  ticker: "symbol",
  종목코드: "symbol",
  단축코드: "symbol",
  tradedate: "date",
  기준일: "date",
  일자: "date",
  securitytype: "type",
  sectorcode: "sector",
  시장: "market",
  종목명: "name",
};
for (const column of CANONICAL_SOURCE_COLUMNS) {
  QA_HEADER_ALIASES[column.replace(/[\s_()\-/]/g, "").toLowerCase()] = column;
}

function qaHeader(value: string) {
  const raw = value.replace(/^\uFEFF/, "").trim();
  return QA_HEADER_ALIASES[raw.replace(/[\s_()\-/]/g, "").toLowerCase()] ?? null;
}

function hasActualValue(value: string | undefined) {
  const trimmed = (value ?? "").trim();
  return Boolean(trimmed) && trimmed !== "-" && !/^(null|none|nan|na)$/i.test(trimmed);
}

function scanFieldQuality(inputs: QualityInput[]) {
  const years = new Map<string, { rows: number; counts: Record<string, number> }>();
  const overall = Object.fromEntries(CANONICAL_SOURCE_COLUMNS.map((column) => [column, 0]));
  const sourceCounts = new Map<string, Map<string, number>>();
  const fileQuality: Array<Record<string, unknown>> = [];
  let totalRows = 0;
  for (const input of inputs) {
    if (/^\s*(?:\[|\{)/.test(input.text))
      throw new Error(
        `데이터 QA 순차 스캐너는 현재 CSV만 지원합니다: ${input.fileName ?? input.id}`,
      );
    let header: string[] = [];
    let suppliedColumnCount = 0;
    const fileCounts = Object.fromEntries(CANONICAL_SOURCE_COLUMNS.map((column) => [column, 0]));
    let fileRows = 0;
    visitDelimitedRows(input.text, (cells, rowIndex) => {
      if (rowIndex === 0) {
        suppliedColumnCount = cells.length;
        header = cells.map((cell) => qaHeader(cell) ?? "");
        return;
      }
      totalRows++;
      fileRows++;
      const dateIndex = header.indexOf("date");
      const year = (cells[dateIndex] ?? "").replace(/[^\d]/g, "").slice(0, 4);
      const bucket = years.get(year) ?? {
        rows: 0,
        counts: Object.fromEntries(CANONICAL_SOURCE_COLUMNS.map((column) => [column, 0])),
      };
      bucket.rows++;
      header.forEach((column, index) => {
        if (!column || !hasActualValue(cells[index])) return;
        overall[column] = (overall[column] ?? 0) + 1;
        fileCounts[column] = (fileCounts[column] ?? 0) + 1;
        bucket.counts[column] = (bucket.counts[column] ?? 0) + 1;
      });
      for (const column of SOURCE_COLUMNS) {
        const index = header.indexOf(column);
        const raw = index >= 0 && hasActualValue(cells[index]) ? cells[index]!.trim() : "MISSING";
        const counts = sourceCounts.get(column) ?? new Map<string, number>();
        counts.set(raw, (counts.get(raw) ?? 0) + 1);
        sourceCounts.set(column, counts);
      }
      years.set(year, bucket);
    });
    const supplied = new Set(header.filter(Boolean));
    fileQuality.push({
      sourceId: input.id,
      fileName: input.fileName,
      rows: fileRows,
      from: input.validation.stats.minDate,
      to: input.validation.stats.maxDate,
      suppliedColumns: suppliedColumnCount,
      populatedColumns: [...supplied].filter((column) => (fileCounts[column] ?? 0) > 0).length,
      completelyEmptySuppliedColumns: [...supplied].filter(
        (column) => (fileCounts[column] ?? 0) === 0,
      ),
      sectorUnmappedCount: input.validation.stats.sectorUnmappedCount,
    });
  }
  const summarize = (counts: Record<string, number>, rows: number) =>
    Object.fromEntries(
      CANONICAL_SOURCE_COLUMNS.map((column) => [
        column,
        {
          nonEmpty: counts[column] ?? 0,
          completenessPct: rate(counts[column] ?? 0, rows),
          missingPct: Math.round((100 - rate(counts[column] ?? 0, rows)) * 10_000) / 10_000,
        },
      ]),
    );
  const fields = {
    totalRows,
    overall: summarize(overall, totalRows),
    byYear: Object.fromEntries(
      [...years.entries()].sort().map(([year, bucket]) => [
        year,
        {
          rows: bucket.rows,
          fields: summarize(bucket.counts, bucket.rows),
        },
      ]),
    ),
  };
  const sourceDistribution = Object.fromEntries(
    [...sourceCounts.entries()].map(([column, bucket]) => {
      const total = [...bucket.values()].reduce((sum, value) => sum + value, 0);
      return [
        column,
        Object.fromEntries(
          [...bucket.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([value, count]) => [value, { rows: count, pct: rate(count, total) }]),
        ),
      ];
    }),
  );
  return { fields, sourceDistribution, fileQuality };
}

function indexContinuity(dataset: MarketDataset) {
  const stockDates = new Set(
    dataset.instruments
      .filter((instrument) => instrument.instrumentType === "STOCK")
      .flatMap((instrument) => (dataset.bars[instrument.symbol] ?? []).map((bar) => bar.tradeDate)),
  );
  const indexes = Object.fromEntries(
    ["KOSPI", "KOSDAQ"].map((code) => {
      const series = dataset.indexSeries.find((item) => item.indexCode === code);
      const dates = new Set(series?.bars.map((bar) => bar.tradeDate) ?? []);
      const expected = [...stockDates]
        .filter((date) => date >= (dataset.tradeDates[0] ?? "") && date <= dataset.asOfDate)
        .sort();
      const missingDates = expected.filter((date) => !dates.has(date));
      return [
        code,
        {
          present: Boolean(series),
          firstDate: series?.bars[0]?.tradeDate ?? null,
          lastDate: series?.bars.at(-1)?.tradeDate ?? null,
          observedTradingDays: dates.size,
          expectedTradingDays: expected.length,
          coveragePct: rate(expected.length - missingDates.length, expected.length),
          missingTradingDayCount: missingDates.length,
          missingTradingDates: missingDates.slice(0, 200),
          missingDatesTruncated: missingDates.length > 200,
        },
      ];
    }),
  );
  return { expectedCalendar: "union of observed STOCK dates", indexes };
}

function universeCoverage(dataset: MarketDataset, limit: number) {
  const instruments = dataset.instruments
    .filter((instrument) => instrument.instrumentType === "STOCK")
    .sort(
      (a, b) =>
        (dataset.bars[b.symbol]?.at(-1)?.tradingValue ?? 0) -
        (dataset.bars[a.symbol]?.at(-1)?.tradingValue ?? 0),
    )
    .slice(0, limit);
  const calendars = Object.fromEntries(
    ["KOSPI", "KOSDAQ"].map((code) => [
      code,
      dataset.indexSeries
        .find((item) => item.indexCode === code)
        ?.bars.map((bar) => bar.tradeDate) ?? [],
    ]),
  ) as Record<string, string[]>;
  const symbols = instruments.map((instrument) => {
    const dates = new Set((dataset.bars[instrument.symbol] ?? []).map((bar) => bar.tradeDate));
    const firstDate = [...dates].sort()[0] ?? null;
    const lastDate = [...dates].sort().at(-1) ?? null;
    const calendar = calendars[instrument.market] ?? calendars["KOSPI"] ?? [];
    const leading = firstDate
      ? calendar.filter((date) => date < firstDate).length
      : calendar.length;
    const trailing = lastDate ? calendar.filter((date) => date > lastDate).length : calendar.length;
    const span =
      firstDate && lastDate ? calendar.filter((date) => date >= firstDate && date <= lastDate) : [];
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
      classification:
        internalMissing.length > 0
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
    interpretation:
      "Leading gaps may be pre-listing but cannot be proven without official listing dates; internal gaps are collection-failure candidates; trailing gaps require delisting/suspension checks.",
    symbols,
  };
}

export function buildBacktestDataQuality(
  inputs: QualityInput[],
  dataset: MarketDataset,
  limit = 613,
) {
  const generatedAt = new Date().toISOString();
  const scan = scanFieldQuality(inputs);
  const fields = scan.fields;
  return {
    version: BACKTEST_DATA_QUALITY_VERSION,
    generatedAt,
    sourceFileCount: inputs.length,
    totalRows: fields.totalRows,
    from: dataset.tradeDates[0] ?? null,
    to: dataset.asOfDate,
    fieldCompleteness: fields,
    sourceDistribution: scan.sourceDistribution,
    indexContinuity: indexContinuity(dataset),
    universeCoverage: universeCoverage(dataset, limit),
    fileQuality: scan.fileQuality,
  };
}
