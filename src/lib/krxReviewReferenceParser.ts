import { parseManualMarketData, normalizeKrxSymbol } from "./engine/manualDataset";
import { visitDelimitedRows } from "./sourceData";
import { validDate } from "./ledger/date";
import { selectKrxReviewReference, type KrxReviewObservation } from "./krxReviewReference";
import { calculateKrxPreliminary } from "./krxPreliminary";
import type { MarketDataset } from "./engine/dataset";
import type { AnalysisResult } from "./engine/pipeline";

const normalize = (key: string) => key.replace(/\s|_/g, "").toLowerCase();
const referenceColumns = new Set([
  "symbol",
  "close",
  "종가",
  "type",
  "종류",
  "securitytype",
  "market",
  "시장",
  "code",
  "종목코드",
  "단축코드",
  "date",
  "tradedate",
  "기준일",
  "일자",
  "marketcapsource",
  "tradingvaluesource",
  "marketcap",
  "시가총액",
  "listedshares",
  "etfmarketcap",
  "etftradingvalue",
  "etfnav",
  "etfnetassettotalamount",
  "etflistedunits",
  "etfunderlyingindexclose",
  "etfunderlyingindexname",
]);
const numeric = (value: unknown): number | null => {
  const text = String(value ?? "")
    .replace(/[, ₩원%]/g, "")
    .trim();
  if (!text || /^(null|none|nan|na|-|--)$/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
};

// Match the frozen parser's canonical-first JSON aliases. CSV rows are already
// normalized below. Display metadata must never make a rejected source row win.
const chartAliases: Record<string, string[]> = {
  symbol: ["code", "종목코드", "단축코드"],
  date: ["tradedate", "기준일", "일자"],
  close: ["종가"],
  type: ["종류", "securitytype"],
  market: ["시장"],
  etfUnderlyingIndexClose: ["etfunderlyingindexclose"],
  marketCapSource: ["marketcapsource"],
  tradingValueSource: ["tradingvaluesource"],
};
const chartCsvColumns = new Map(
  Object.entries(chartAliases).flatMap(([field, aliases]) =>
    [field, ...aliases].map((alias) => [normalize(alias), field] as const),
  ),
);
const chartField = (raw: Record<string, unknown>, field: string): unknown => {
  for (const key of [field, ...(chartAliases[field] ?? [])])
    if (raw[key] !== undefined) return raw[key];
  return undefined;
};

/** Minimal independent presentation parser: no edits to the frozen engine parser. */
export function parseManualMarketDataWithReferences(
  ...args: Parameters<typeof parseManualMarketData>
) {
  const parsed = parseManualMarketData(...args);
  const observations: Record<string, KrxReviewObservation[]> = {};
  const latest = new Map<
    string,
    Map<string, { date: string; source: KrxReviewObservation["source"]; value: number | string }>
  >();
  const symbols = new Map(parsed.dataset.instruments.map((i) => [i.symbol, i.instrumentType]));
  const acceptedCloses = new Map<string, number>();
  const consume = (raw: Record<string, unknown>) => {
    const row = Object.fromEntries(
      Object.entries(raw)
        .map(([key, value]) => [normalize(key), value])
        .filter(([key]) => referenceColumns.has(key as string)),
    );
    const symbol = normalizeKrxSymbol(
      row["symbol"] ?? row["code"] ?? row["종목코드"] ?? row["단축코드"],
    );
    if (!symbols.has(symbol)) return;
    const digits = String(
      row["date"] ?? row["tradedate"] ?? row["기준일"] ?? row["일자"] ?? "",
    ).replace(/\D/g, "");
    const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    if (!validDate(date) || date > parsed.dataset.asOfDate) return;
    const etf = symbols.get(symbol) === "ETF";
    const source = etf ? "KRX_ETF" : "KRX_STOCK";
    const capExact = row["marketcapsource"] === source;
    const valueExact = row["tradingvaluesource"] === source;
    if (etf) {
      // Replay only the frozen parser's acceptance/enrichment boundary. Its ETF
      // values are written by accepted ETF rows, never rejected close rows or
      // STOCK/INDEX duplicates, even when their numeric index values happen to match.
      const sourceSymbol = normalizeKrxSymbol(chartField(raw, "symbol"));
      const sourceDigits = String(chartField(raw, "date") ?? "")
        .trim()
        .replace(/[^\d]/g, "");
      const sourceDate =
        sourceDigits.length >= 8
          ? `${sourceDigits.slice(0, 4)}-${sourceDigits.slice(4, 6)}-${sourceDigits.slice(6, 8)}`
          : null;
      const key = `${sourceSymbol}:${sourceDate}`;
      const rawType = String(chartField(raw, "type") ?? "")
        .trim()
        .toUpperCase();
      const rawMarket = String(chartField(raw, "market") ?? "")
        .trim()
        .toUpperCase();
      const indexSymbol = ["KOSPI", "KOSDAQ", "VKOSPI"].includes(sourceSymbol);
      let sourceClose = numeric(chartField(raw, "close")) ?? acceptedCloses.get(key) ?? null;
      if (
        sourceClose === null &&
        !indexSymbol &&
        rawType !== "INDEX" &&
        (["KOSPI", "KOSDAQ", "코스피", "코스닥", "ETF"].includes(rawMarket) ||
          (!rawMarket && rawType === "ETF"))
      )
        sourceClose = 0;
      const options = args[1];
      const filtered =
        options?.symbols &&
        !indexSymbol &&
        (!options.symbols.has(sourceSymbol) ||
          (sourceDate && options.from && sourceDate < options.from));
      const accepted =
        sourceSymbol === symbol &&
        sourceDate === date &&
        !filtered &&
        sourceClose !== null &&
        sourceClose >= 0 &&
        !(sourceClose === 0 && indexSymbol);
      if (accepted) acceptedCloses.set(key, sourceClose!);
      const sourceIsEtf =
        accepted &&
        !indexSymbol &&
        rawType !== "INDEX" &&
        rawMarket !== "INDEX" &&
        rawMarket !== "지수" &&
        (rawType === "ETF" || rawMarket === "ETF");
      const underlyingClose = numeric(chartField(raw, "etfUnderlyingIndexClose"));
      if (etf && sourceIsEtf && underlyingClose !== null && underlyingClose > 0) {
        const bars = parsed.dataset.observedBars?.[symbol] ?? parsed.dataset.bars[symbol] ?? [];
        let lo = 0,
          hi = bars.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (bars[mid]!.tradeDate < date) lo = mid + 1;
          else hi = mid;
        }
        const bar = bars[lo];
        if (bar?.tradeDate === date && bar.etfUnderlyingIndexClose === underlyingClose) {
          const name = String(row["etfunderlyingindexname"] ?? "").trim();
          const exact =
            chartField(raw, "marketCapSource") === "KRX_ETF" ||
            chartField(raw, "tradingValueSource") === "KRX_ETF";
          bar.etfUnderlyingIndexSource = exact ? "KRX_ETF" : null;
          bar.etfUnderlyingIndexName =
            exact && name && !/^(null|none|nan|na|-|--)$/i.test(name) ? name : null;
        }
      }
    }
    // Verified collector contract: BAS_DD == request date, exact date/symbol join.
    // No provenance inference from a row date alone, and no Toss/proxy fallback.
    if (!capExact && !valueExact) return;
    const values: KrxReviewObservation["values"] = {};
    if (capExact)
      values.marketCap = numeric(
        row[etf ? "etfmarketcap" : "marketcap"] ?? (!etf ? row["시가총액"] : undefined),
      );
    if (!etf && capExact) values.listedShares = numeric(row["listedshares"]);
    if (etf) {
      if (valueExact) values.tradingValue = numeric(row["etftradingvalue"]);
      values.nav = numeric(row["etfnav"]);
      values.aum = numeric(row["etfnetassettotalamount"]);
      values.listedUnits = numeric(row["etflistedunits"]);
      values.underlyingIndexClose = numeric(row["etfunderlyingindexclose"]);
      const name = String(row["etfunderlyingindexname"] ?? "").trim();
      values.underlyingIndexName = !name || /^(null|none|nan|na|-|--)$/i.test(name) ? null : name;
    }
    const facts = latest.get(symbol) ?? new Map();
    for (const [field, value] of Object.entries(values)) {
      const usable =
        field === "underlyingIndexName"
          ? typeof value === "string" && value.length > 0
          : typeof value === "number" &&
            Number.isFinite(value) &&
            (field === "tradingValue" ? value >= 0 : value > 0);
      if (usable && (!facts.has(field) || facts.get(field).date <= date))
        facts.set(field, { date, source, value });
    }
    latest.set(symbol, facts);
  };
  const flatten = (item: unknown, head: Record<string, unknown> = {}) => {
    if (!item || typeof item !== "object") return;
    const row = item as Record<string, unknown>;
    if (Array.isArray(row["bars"])) {
      const { bars, ...rest } = row;
      for (const bar of bars as unknown[]) flatten(bar, { ...head, ...rest });
    } else consume({ ...head, ...row });
  };
  for (const text of Array.isArray(args[0]) ? args[0] : [args[0]]) {
    const trimmed = text.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const json = JSON.parse(trimmed);
      if (Array.isArray(json)) json.forEach((item) => flatten(item));
      else
        for (const key of ["instruments", "stocks", "etfs", "indexes", "indices", "rows", "data"]) {
          if (Array.isArray(json[key]))
            json[key].forEach((item: unknown) => {
              const isIndex = key === "indexes" || key === "indices";
              flatten(
                isIndex && item && typeof item === "object" ? { ...item, type: "INDEX" } : item,
              );
            });
        }
    } else {
      let headers: Array<[string, number]> = [];
      visitDelimitedRows(trimmed, (cells, index) => {
        if (index === 0)
          headers = cells
            .map((header, i): [string, number] => [normalize(header), i])
            .filter(([header]) => referenceColumns.has(header));
        else {
          const row = Object.fromEntries(headers.map(([header, i]) => [header, cells[i]]));
          // The frozen CSV parser canonicalizes aliases in header order, so the
          // last column for a duplicated canonical field wins before acceptance.
          for (const [header, i] of headers) {
            const canonical = chartCsvColumns.get(header);
            if (canonical) row[canonical] = cells[i];
          }
          consume(row);
        }
      });
    }
  }
  // Bound the extra memory to the latest usable value per field, not source history.
  for (const [symbol, facts] of latest) {
    const dated = new Map<string, KrxReviewObservation>();
    for (const [field, fact] of facts) {
      const observation = dated.get(fact.date) ?? {
        date: fact.date,
        source: fact.source,
        values: {},
      };
      observation.values[field as keyof KrxReviewObservation["values"]] = fact.value;
      dated.set(fact.date, observation);
    }
    observations[symbol] = [...dated.values()];
  }
  parsed.dataset.krxReviewObservations = observations;
  return parsed;
}

export function withKrxReviewReferences(
  analysis: AnalysisResult,
  dataset: MarketDataset,
): AnalysisResult {
  return {
    ...analysis,
    rows: analysis.rows.map((row) => {
      const reference = selectKrxReviewReference(
        dataset.krxReviewObservations?.[row.instrument.symbol] ?? [],
        analysis.asOfDate,
      );
      const preliminary = calculateKrxPreliminary(row, analysis, dataset, reference);
      return {
        ...row,
        krxReviewReference: preliminary ? { ...reference, preliminary } : reference,
      };
    }),
  };
}
