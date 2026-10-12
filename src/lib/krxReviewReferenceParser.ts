import { parseManualMarketData, normalizeKrxSymbol } from "./engine/manualDataset";
import { visitDelimitedRows } from "./sourceData";
import { validDate } from "./ledger/date";
import { selectKrxReviewReference, type KrxReviewObservation } from "./krxReviewReference";
import type { MarketDataset } from "./engine/dataset";
import type { AnalysisResult } from "./engine/pipeline";

const normalize = (key: string) => key.replace(/\s|_/g, "").toLowerCase();
const referenceColumns = new Set([
  "symbol",
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
          if (Array.isArray(json[key])) json[key].forEach((item: unknown) => flatten(item));
        }
    } else {
      let headers: Array<[string, number]> = [];
      visitDelimitedRows(trimmed, (cells, index) => {
        if (index === 0)
          headers = cells
            .map((header, i): [string, number] => [normalize(header), i])
            .filter(([header]) => referenceColumns.has(header));
        else consume(Object.fromEntries(headers.map(([header, i]) => [header, cells[i]])));
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
    rows: analysis.rows.map((row) => ({
      ...row,
      krxReviewReference: selectKrxReviewReference(
        dataset.krxReviewObservations?.[row.instrument.symbol] ?? [],
        analysis.asOfDate,
      ),
    })),
  };
}
