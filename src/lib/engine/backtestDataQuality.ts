import type { MarketDataset } from "./dataset";
import {
  CANONICAL_SOURCE_COLUMNS,
  visitDelimitedRows,
  type SourceValidationResult,
} from "../sourceData";

export const BACKTEST_DATA_QUALITY_VERSION = "backtest-data-quality-v2" as const;

type QualityInput = {
  id: string;
  fileName: string | null;
  text: string;
  validation: SourceValidationResult;
};

const SOURCE_COLUMNS = CANONICAL_SOURCE_COLUMNS.filter((column) =>
  column.toLowerCase().endsWith("source"),
);
const INDEX_CODES = ["KOSPI", "KOSDAQ"] as const;
type IndexCode = (typeof INDEX_CODES)[number];

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

function qaDate(value: string | undefined) {
  const digits = (value ?? "").replace(/[^\d]/g, "");
  if (digits.length < 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function hasPositiveNumber(value: string | undefined) {
  if (!hasActualValue(value)) return false;
  const parsed = Number((value ?? "").replace(/[, ₩원%]/g, "").trim());
  return Number.isFinite(parsed) && parsed > 0;
}

type FileIndexBucket = {
  rawRows: number;
  validCloseRows: number;
  rawDates: Set<string>;
  validDates: Set<string>;
};

function emptyIndexBucket(): FileIndexBucket {
  return { rawRows: 0, validCloseRows: 0, rawDates: new Set(), validDates: new Set() };
}

function scanFieldQuality(inputs: QualityInput[]) {
  const years = new Map<string, { rows: number; counts: Record<string, number> }>();
  const overall = Object.fromEntries(CANONICAL_SOURCE_COLUMNS.map((column) => [column, 0]));
  const sourceCounts = new Map<string, Map<string, number>>();
  const fileQuality: Array<Record<string, unknown>> = [];
  const fileIndexDiagnostics: Array<Record<string, unknown>> = [];
  const stockDates = new Set<string>();
  const stockFieldStats = Object.fromEntries(
    CANONICAL_SOURCE_COLUMNS.map((column) => [
      column,
      {
        nonEmpty: 0,
        firstObservedDate: null as string | null,
        lastMissingDate: null as string | null,
      },
    ]),
  ) as Record<
    string,
    { nonEmpty: number; firstObservedDate: string | null; lastMissingDate: string | null }
  >;
  let stockRowsWithDate = 0;
  let totalRows = 0;

  for (const input of inputs) {
    if (/^\s*(?:\[|\{)/.test(input.text))
      throw new Error(
        `데이터 QA 순차 스캐너는 현재 CSV만 지원합니다: ${input.fileName ?? input.id}`,
      );
    let header: string[] = [];
    let suppliedColumnCount = 0;
    let dateIndex = -1;
    let symbolIndex = -1;
    let typeIndex = -1;
    let marketIndex = -1;
    let closeIndex = -1;
    const fileCounts = Object.fromEntries(CANONICAL_SOURCE_COLUMNS.map((column) => [column, 0]));
    const fileIndexes: Record<IndexCode, FileIndexBucket> = {
      KOSPI: emptyIndexBucket(),
      KOSDAQ: emptyIndexBucket(),
    };
    let fileRows = 0;

    visitDelimitedRows(input.text, (cells, rowIndex) => {
      if (rowIndex === 0) {
        suppliedColumnCount = cells.length;
        header = cells.map((cell) => qaHeader(cell) ?? "");
        dateIndex = header.indexOf("date");
        symbolIndex = header.indexOf("symbol");
        typeIndex = header.indexOf("type");
        marketIndex = header.indexOf("market");
        closeIndex = header.indexOf("close");
        return;
      }
      totalRows++;
      fileRows++;
      const date = dateIndex >= 0 ? qaDate(cells[dateIndex]) : null;
      const year = date?.slice(0, 4) ?? "UNKNOWN";
      const symbol = (symbolIndex >= 0 ? cells[symbolIndex] ?? "" : "").trim().toUpperCase();
      const rawType = (typeIndex >= 0 ? cells[typeIndex] ?? "" : "").trim().toUpperCase();
      const rawMarket = (marketIndex >= 0 ? cells[marketIndex] ?? "" : "").trim().toUpperCase();
      const isIndex =
        symbol === "KOSPI" ||
        symbol === "KOSDAQ" ||
        symbol === "VKOSPI" ||
        rawType === "INDEX" ||
        rawMarket === "INDEX" ||
        rawMarket === "지수";
      const isEtf = !isIndex && (rawType === "ETF" || rawMarket === "ETF");
      const isStock = !isIndex && !isEtf;

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

      if ((symbol === "KOSPI" || symbol === "KOSDAQ") && date) {
        const indexBucket = fileIndexes[symbol];
        indexBucket.rawRows++;
        indexBucket.rawDates.add(date);
        if (closeIndex >= 0 && hasPositiveNumber(cells[closeIndex])) {
          indexBucket.validCloseRows++;
          indexBucket.validDates.add(date);
        }
      } else if (symbol === "KOSPI" || symbol === "KOSDAQ") {
        fileIndexes[symbol].rawRows++;
      }

      if (isStock && date) {
        stockRowsWithDate++;
        stockDates.add(date);
        for (const column of CANONICAL_SOURCE_COLUMNS) {
          const index = header.indexOf(column);
          const present = index >= 0 && hasActualValue(cells[index]);
          const stats = stockFieldStats[column]!;
          if (present) {
            stats.nonEmpty++;
            if (!stats.firstObservedDate || date < stats.firstObservedDate) stats.firstObservedDate = date;
          } else if (!stats.lastMissingDate || date > stats.lastMissingDate) {
            stats.lastMissingDate = date;
          }
        }
      }
    });

    const supplied = new Set(header.filter(Boolean));
    const summarizeIndex = (code: IndexCode) => {
      const rawDates = [...fileIndexes[code].rawDates].sort();
      const validDates = [...fileIndexes[code].validDates].sort();
      return {
        rawRows: fileIndexes[code].rawRows,
        validCloseRows: fileIndexes[code].validCloseRows,
        uniqueRawDates: rawDates.length,
        uniqueValidDates: validDates.length,
        firstRawDate: rawDates[0] ?? null,
        lastRawDate: rawDates.at(-1) ?? null,
        firstValidDate: validDates[0] ?? null,
        lastValidDate: validDates.at(-1) ?? null,
      };
    };
    const kospiRawDates = fileIndexes.KOSPI.rawDates;
    const kospiValidDates = fileIndexes.KOSPI.validDates;
    const kosdaqValidDates = [...fileIndexes.KOSDAQ.validDates].sort();
    const kospiMissingWhereKosdaqValid = kosdaqValidDates.filter((date) => !kospiValidDates.has(date));
    const kospiRawRowAbsentWhereKosdaqValid = kosdaqValidDates.filter((date) => !kospiRawDates.has(date));
    const kospiRawPresentButInvalidCloseWhereKosdaqValid = kosdaqValidDates.filter(
      (date) => kospiRawDates.has(date) && !kospiValidDates.has(date),
    );

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
      registeredIndexCount: input.validation.stats.indexCount,
      indexRows: {
        KOSPI: summarizeIndex("KOSPI"),
        KOSDAQ: summarizeIndex("KOSDAQ"),
      },
    });
    fileIndexDiagnostics.push({
      sourceId: input.id,
      fileName: input.fileName,
      from: input.validation.stats.minDate,
      to: input.validation.stats.maxDate,
      KOSPI: summarizeIndex("KOSPI"),
      KOSDAQ: summarizeIndex("KOSDAQ"),
      kospiMissingWhereKosdaqValidCount: kospiMissingWhereKosdaqValid.length,
      kospiMissingWhereKosdaqValid,
      kospiRawRowAbsentWhereKosdaqValidCount: kospiRawRowAbsentWhereKosdaqValid.length,
      kospiRawRowAbsentWhereKosdaqValid,
      kospiRawPresentButInvalidCloseWhereKosdaqValidCount:
        kospiRawPresentButInvalidCloseWhereKosdaqValid.length,
      kospiRawPresentButInvalidCloseWhereKosdaqValid,
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

  const orderedStockDates = [...stockDates].sort();
  const firstStockDate = orderedStockDates[0] ?? null;
  const lastStockDate = orderedStockDates.at(-1) ?? null;
  const fieldAvailability = Object.fromEntries(
    CANONICAL_SOURCE_COLUMNS.map((column) => {
      const stats = stockFieldStats[column]!;
      let completeFromDate: string | null = null;
      if (stats.nonEmpty > 0) {
        if (!stats.lastMissingDate) completeFromDate = firstStockDate;
        else completeFromDate = orderedStockDates.find((date) => date > stats.lastMissingDate!) ?? null;
      }
      return [
        column,
        {
          nonEmpty: stats.nonEmpty,
          completenessPct: rate(stats.nonEmpty, stockRowsWithDate),
          firstObservedDate: stats.firstObservedDate,
          lastMissingDate: stats.lastMissingDate,
          completeFromDate,
          excludedFromAllFieldsGate: column === "sector",
        },
      ];
    }),
  ) as Record<
    string,
    {
      nonEmpty: number;
      completenessPct: number;
      firstObservedDate: string | null;
      lastMissingDate: string | null;
      completeFromDate: string | null;
      excludedFromAllFieldsGate: boolean;
    }
  >;
  const gatedColumns = CANONICAL_SOURCE_COLUMNS.filter((column) => column !== "sector");
  const allFieldsComplete = gatedColumns.every((column) => Boolean(fieldAvailability[column]?.completeFromDate));
  const allFieldsCompleteFromDate = allFieldsComplete
    ? gatedColumns
        .map((column) => fieldAvailability[column]!.completeFromDate!)
        .sort()
        .at(-1) ?? null
    : null;

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
    stockRows: {
      basis: "STOCK rows with valid dates; sector excluded from all-fields gate because sector mapping is external",
      rows: stockRowsWithDate,
      from: firstStockDate,
      to: lastStockDate,
      allFieldsCompleteFromDate,
      fields: fieldAvailability,
    },
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
  return { fields, sourceDistribution, fileQuality, fileIndexDiagnostics };
}

function groupMissingTradingDates(expected: string[], missingDates: string[]) {
  const missing = new Set(missingDates);
  const runs: Array<{ from: string; to: string; tradingDays: number }> = [];
  let current: { from: string; to: string; tradingDays: number } | null = null;
  for (const date of expected) {
    if (!missing.has(date)) {
      if (current) runs.push(current);
      current = null;
      continue;
    }
    if (!current) current = { from: date, to: date, tradingDays: 1 };
    else {
      current.to = date;
      current.tradingDays++;
    }
  }
  if (current) runs.push(current);
  return runs;
}

function indexContinuity(dataset: MarketDataset) {
  const stockDates = new Set(
    dataset.instruments
      .filter((instrument) => instrument.instrumentType === "STOCK")
      .flatMap((instrument) => (dataset.bars[instrument.symbol] ?? []).map((bar) => bar.tradeDate)),
  );
  const expected = [...stockDates]
    .filter((date) => date >= (dataset.tradeDates[0] ?? "") && date <= dataset.asOfDate)
    .sort();
  const indexDateSets = Object.fromEntries(
    INDEX_CODES.map((code) => [
      code,
      new Set(
        dataset.indexSeries.find((item) => item.indexCode === code)?.bars.map((bar) => bar.tradeDate) ?? [],
      ),
    ]),
  ) as Record<IndexCode, Set<string>>;
  const indexes = Object.fromEntries(
    INDEX_CODES.map((code) => {
      const series = dataset.indexSeries.find((item) => item.indexCode === code);
      const dates = indexDateSets[code];
      const missingDates = expected.filter((date) => !dates.has(date));
      const otherCode: IndexCode = code === "KOSPI" ? "KOSDAQ" : "KOSPI";
      const missingWhereOtherIndexPresent = missingDates.filter((date) => indexDateSets[otherCode].has(date));
      const missingByYear = Object.fromEntries(
        [...new Set(missingDates.map((date) => date.slice(0, 4)))].sort().map((year) => [
          year,
          missingDates.filter((date) => date.startsWith(year)).length,
        ]),
      );
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
          missingTradingDates: missingDates,
          missingDatesTruncated: false,
          missingByYear,
          missingTradingDateRuns: groupMissingTradingDates(expected, missingDates),
          comparisonIndex: otherCode,
          missingWhereOtherIndexPresentCount: missingWhereOtherIndexPresent.length,
          missingWhereOtherIndexPresent,
        },
      ];
    }),
  );
  return { expectedCalendar: "union of observed STOCK dates", expectedTradingDays: expected.length, indexes };
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
    INDEX_CODES.map((code) => [
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
    indexContinuity: {
      ...indexContinuity(dataset),
      fileDiagnostics: scan.fileIndexDiagnostics,
    },
    universeCoverage: universeCoverage(dataset, limit),
    fileQuality: scan.fileQuality,
  };
}
