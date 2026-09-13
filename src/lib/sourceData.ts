import "./engine/stockSectorMaster";
import "./engine/additionalStockSectorMaster";

import { resolveSectorCode, SECTOR_NAME_BY_CODE } from "./engine/sectors";

export const SOURCE_MAX_FILE_BYTES = 45 * 1024 * 1024;

export const CANONICAL_SOURCE_COLUMNS = [
  "symbol",
  "name",
  "market",
  "type",
  "date",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "tradingValue",
  "marketCap",
  "foreignNetBuyValue",
  "institutionNetBuyValue",
  "sector",
  "listedShares", "krxVolume", "krxTradingValue", "krxMarketCap", "krxListedShares",
  "individualNetBuyValue", "otherCorporationNetBuyValue", "registeredForeignNetBuyValue", "otherForeignNetBuyValue",
  "financialInvestmentNetBuyValue", "insuranceNetBuyValue", "trustNetBuyValue", "privateEquityFundNetBuyValue",
  "bankNetBuyValue", "otherFinancialInstitutionNetBuyValue", "pensionFundNetBuyValue",
  "individualBuyVolume", "individualSellVolume", "individualNetBuyVolume",
  "foreignBuyVolume", "foreignSellVolume", "foreignNetBuyVolume",
  "institutionBuyVolume", "institutionSellVolume", "institutionNetBuyVolume",
  "otherCorporationBuyVolume", "otherCorporationSellVolume", "otherCorporationNetBuyVolume",
  "financialInvestmentNetBuyVolume", "insuranceNetBuyVolume", "trustNetBuyVolume", "privateEquityFundNetBuyVolume",
  "bankNetBuyVolume", "otherFinancialInstitutionNetBuyVolume", "pensionFundNetBuyVolume",
  "foreignHoldingQuantity", "foreignHoldingLimitQuantity", "foreignHoldingRate", "foreignHoldingRatePct",
  "cfdBuyBalanceQuantity", "cfdBuyBalanceRate", "cfdSellBalanceQuantity", "cfdSellBalanceRate", "investorUpdatedAt",
  "programArbitrageBuyVolume", "programArbitrageSellVolume", "programArbitrageNetBuyVolume",
  "programNonArbitrageBuyVolume", "programNonArbitrageSellVolume", "programNonArbitrageNetBuyVolume", "programNetBuyVolume",
  "shortSellingVolume", "shortSellingAmount", "shortSellingVolumeRate", "shortSellingAmountRate", "shortUpdatedAt",
  "marginLoanNewQuantity", "marginLoanReturnQuantity", "marginLoanBalanceQuantity", "marginLoanBalanceRate", "marginLoanTradingRate",
  "stockLoanNewQuantity", "stockLoanReturnQuantity", "stockLoanBalanceQuantity", "stockLoanBalanceRate", "stockLoanTradingRate", "creditUpdatedAt",
  "lendingExecutionQuantity", "lendingRepaymentQuantity", "lendingBalanceQuantity", "lendingBalanceAmount", "lendingUpdatedAt",
  "etfNav", "etfTradingValue", "etfMarketCap", "etfNetAssetTotalAmount", "etfListedUnits",
  "etfUnderlyingIndexName", "etfUnderlyingIndexClose", "etfPremiumDiscountRate", "etfTrackingErrorRate",
  "priceSource", "tradingValueSource", "marketCapSource", "investorValueSource", "investorVolumeSource",
  "programTradeSource", "marketFlowUpdatedAt",
] as const;

export type CanonicalSourceColumn = (typeof CANONICAL_SOURCE_COLUMNS)[number];
export type SourceType = "screening" | "backtest";
export type SourceUploadOrigin = "web" | "gpt" | "github_action" | "migration";

export interface CanonicalSourceRow {
  symbol: string;
  name: string;
  market: string;
  type: string;
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  tradingValue: string;
  marketCap: string;
  foreignNetBuyValue: string;
  institutionNetBuyValue: string;
  sector: string;
  [key: string]: string;
}

export interface SourceValidationIssue {
  code: string;
  message: string;
  row?: number;
  key?: string;
}

export interface SourceValidationStats {
  rowCount: number;
  symbolCount: number;
  minDate: string | null;
  maxDate: string | null;
  marketCount: number;
  kospiCount: number;
  kosdaqCount: number;
  stockCount: number;
  etfCount: number;
  indexCount: number;
  sectorMappedCount: number;
  sectorUnmappedCount: number;
  duplicateRowCount: number;
  populatedColumnCount: number;
  completelyEmptyColumns: string[];
  columnNonEmptyRates: Record<string, number>;
}

export interface SourceValidationResult {
  valid: boolean;
  format: "csv" | "json" | "xlsx";
  originalFilename: string;
  contentType: string;
  originalSizeBytes: number;
  normalizedSizeBytes: number;
  fileHash: string;
  dataHash: string;
  schemaHash: string;
  canonicalCsv: string;
  columns: string[];
  rows: CanonicalSourceRow[];
  stats: SourceValidationStats;
  errors: SourceValidationIssue[];
  warnings: SourceValidationIssue[];
}

export interface SourceOverlapResult {
  incomingRows: number;
  newRows: number;
  identicalRows: number;
  conflictingRows: number;
  overlappingSymbols: number;
  examples: Array<{
    key: string;
    existingSourceId: string;
    kind: "identical" | "conflict";
  }>;
}

interface RawRecord {
  [key: string]: unknown;
}

interface RecordSet {
  records: RawRecord[];
  columns: string[];
}

const INDEX_SYMBOLS = new Set(["KOSPI", "KOSDAQ", "VKOSPI"]);

const FIELD_ALIASES: Record<string, CanonicalSourceColumn> = {
  symbol: "symbol",
  code: "symbol",
  ticker: "symbol",
  종목코드: "symbol",
  단축코드: "symbol",
  name: "name",
  종목명: "name",
  market: "market",
  시장: "market",
  type: "type",
  종류: "type",
  securitytype: "type",
  date: "date",
  tradedate: "date",
  기준일: "date",
  일자: "date",
  open: "open",
  시가: "open",
  high: "high",
  고가: "high",
  low: "low",
  저가: "low",
  close: "close",
  종가: "close",
  volume: "volume",
  거래량: "volume",
  tradingvalue: "tradingValue",
  amount: "tradingValue",
  tradingamount: "tradingValue",
  거래대금: "tradingValue",
  marketcap: "marketCap",
  시가총액: "marketCap",
  foreignnetbuyvalue: "foreignNetBuyValue",
  foreignnet: "foreignNetBuyValue",
  외국인순매수: "foreignNetBuyValue",
  institutionnetbuyvalue: "institutionNetBuyValue",
  institutionnet: "institutionNetBuyValue",
  기관순매수: "institutionNetBuyValue",
  sector: "sector",
  sectorcode: "sector",
  섹터: "sector",
  업종: "sector",
};

// 수집기 v3의 camelCase 102-column 계약은 대소문자/underscore 차이를 허용하되
// 이름을 바꾸지 않고 그대로 보존한다. 위 별칭은 구형 파일만 canonical field로 연결한다.
for (const column of CANONICAL_SOURCE_COLUMNS) {
  const compact = column.replace(/[\s_()\-/]/g, "").toLowerCase();
  FIELD_ALIASES[compact] = column;
}

const RECOMMENDED_COLUMNS: CanonicalSourceColumn[] = [
  "name",
  "market",
  "open",
  "high",
  "low",
  "volume",
  "tradingValue",
];

function normalizedHeader(value: unknown) {
  const raw = String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
  const compact = raw.replace(/[\s_()\-/]/g, "").toLowerCase();
  return FIELD_ALIASES[compact] ?? FIELD_ALIASES[raw] ?? compact;
}

function delimiterFor(line: string) {
  const candidates = [",", "\t", ";"];
  const counts = new Map(candidates.map((delimiter) => [delimiter, 0]));
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  return candidates.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0]!;
}

function firstLogicalLine(text: string) {
  let quoted = false;
  let line = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        line += '""';
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (!quoted && (ch === "\n" || ch === "\r")) break;
    line += ch;
  }
  return line;
}

/** RFC 4180에 맞춰 따옴표 안 줄바꿈과 이중 따옴표를 보존한다. */
export function parseDelimitedRows(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const delimiter = delimiterFor(firstLogicalLine(clean));
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell.length === 0) quoted = true;
    else if (ch === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(cell.trim());
      cell = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (quoted) throw new Error("CSV 따옴표가 닫히지 않았습니다.");
  row.push(cell.trim());
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function recordsFromTable(table: unknown[][]): RecordSet {
  const nonEmpty = table.filter((row) => row.some((cell) => String(cell ?? "").trim().length > 0));
  if (nonEmpty.length < 2) return { records: [], columns: [] };
  const header = nonEmpty[0]!.map(normalizedHeader);
  const records = nonEmpty.slice(1).map((cells) => {
    const record: RawRecord = {};
    header.forEach((key, index) => {
      if (key) record[key] = cells[index];
    });
    return record;
  });
  return { records, columns: [...new Set(header.filter(Boolean))] };
}

function recordsFromJson(text: string): RecordSet {
  const parsed: unknown = JSON.parse(text);
  const records: RawRecord[] = [];
  const push = (head: RawRecord, values: unknown) => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (value && typeof value === "object") records.push({ ...head, ...(value as RawRecord) });
    }
  };
  const visit = (value: unknown, inferredType?: string) => {
    if (!value || typeof value !== "object") return;
    const record = value as RawRecord;
    if (Array.isArray(record["bars"])) {
      const { bars, ...head } = record;
      push({ ...head, ...(inferredType ? { type: inferredType } : {}) }, bars);
    } else records.push({ ...record, ...(inferredType ? { type: inferredType } : {}) });
  };
  if (Array.isArray(parsed)) parsed.forEach((value) => visit(value));
  else if (parsed && typeof parsed === "object") {
    const root = parsed as RawRecord;
    let found = false;
    for (const key of ["instruments", "stocks", "etfs", "indexes", "indices", "rows", "data"]) {
      const values = root[key];
      if (!Array.isArray(values)) continue;
      found = true;
      const inferred = key === "indexes" || key === "indices" ? "INDEX" : undefined;
      values.forEach((value) => visit(value, inferred));
    }
    if (!found) visit(root);
  }
  const columns = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) columns.add(normalizedHeader(key));
  }
  const canonical = records.map((record) => {
    const out: RawRecord = {};
    for (const [key, value] of Object.entries(record)) out[normalizedHeader(key)] = value;
    return out;
  });
  return { records: canonical, columns: [...columns].filter(Boolean) };
}

export function parseSourceTextRecords(text: string, format?: "csv" | "json"): RecordSet {
  const trimmed = text.trim();
  if (!trimmed) return { records: [], columns: [] };
  const resolved = format ?? (trimmed.startsWith("[") || trimmed.startsWith("{") ? "json" : "csv");
  return resolved === "json"
    ? recordsFromJson(trimmed)
    : recordsFromTable(parseDelimitedRows(trimmed));
}

function normalizeDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/[^\d]/g, "").slice(0, 8);
  if (digits.length !== 8) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeSymbol(value: unknown) {
  let symbol = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/^A(?=\d{6}$)/, "")
    .replace(/\.0$/, "");
  if (/^\d{1,6}$/.test(symbol)) symbol = symbol.padStart(6, "0");
  return symbol;
}

function normalizedNumber(
  value: unknown,
  options: { required?: boolean; nonNegative?: boolean; positive?: boolean } = {},
) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "-" || /^(null|none|nan|na)$/i.test(raw)) {
    return { value: "", error: options.required ? "필수 숫자값이 비어 있습니다." : null };
  }
  const compact = raw.replace(/[, ₩원%]/g, "");
  const parsed = Number(compact);
  if (!Number.isFinite(parsed)) return { value: "", error: `숫자로 해석할 수 없습니다: ${raw}` };
  if (options.positive && parsed <= 0) return { value: "", error: "0보다 커야 합니다." };
  if (options.nonNegative && parsed < 0) return { value: "", error: "0 이상이어야 합니다." };
  return { value: String(parsed), error: null };
}

function normalizeMarket(value: unknown) {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase();
  if (raw.includes("KOSDAQ") || raw.includes("코스닥")) return "KOSDAQ";
  if (raw.includes("KOSPI") || raw.includes("코스피")) return "KOSPI";
  if (raw === "ETF") return "ETF";
  if (raw === "INDEX" || raw === "지수") return "INDEX";
  return raw;
}

function normalizeType(value: unknown, symbol: string, market: string, name: string) {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase();
  if (raw === "INDEX" || market === "INDEX" || INDEX_SYMBOLS.has(symbol)) return "INDEX";
  if (raw === "ETF" || market === "ETF" || /\bETF\b/i.test(name)) return "ETF";
  return raw === "STOCK" ? "STOCK" : "STOCK";
}

function csvCell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function sourceRowKey(row: CanonicalSourceRow) {
  return `${row.symbol}\u0000${row.date}`;
}

export function sourceRowFingerprint(row: CanonicalSourceRow) {
  return CANONICAL_SOURCE_COLUMNS.map((column) => row[column] ?? "").join("\u001f");
}

export function toCanonicalCsv(rows: CanonicalSourceRow[]) {
  const lines = [CANONICAL_SOURCE_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CANONICAL_SOURCE_COLUMNS.map((column) => csvCell(row[column] ?? "")).join(","));
  }
  return `${lines.join("\n")}\n`;
}

async function sha256(bytes: Uint8Array) {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return `sha256:${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function issue(
  code: string,
  message: string,
  detail: Pick<SourceValidationIssue, "row" | "key"> = {},
): SourceValidationIssue {
  return { code, message, ...detail };
}

function normalizeRecords(recordSet: RecordSet) {
  const errors: SourceValidationIssue[] = [];
  const warnings: SourceValidationIssue[] = [];
  const unique = new Map<string, CanonicalSourceRow>();
  const inferredMarketSymbols = new Set<string>();
  let duplicates = 0;

  for (const required of ["symbol", "date", "close"] as CanonicalSourceColumn[]) {
    if (!recordSet.columns.includes(required)) {
      errors.push(issue("MISSING_COLUMN", `필수 열 ${required}이(가) 없습니다.`));
    }
  }
  for (const recommended of RECOMMENDED_COLUMNS) {
    if (!recordSet.columns.includes(recommended)) {
      warnings.push(issue("MISSING_RECOMMENDED_COLUMN", `권장 열 ${recommended}이(가) 없습니다.`));
    }
  }

  recordSet.records.forEach((record, index) => {
    const rowNumber = index + 2;
    const symbol = normalizeSymbol(record["symbol"]);
    const date = normalizeDate(record["date"]);
    const name = String(record["name"] ?? symbol).trim() || symbol;
    const market = normalizeMarket(record["market"]);
    const type = normalizeType(record["type"], symbol, market, name);
    if (!symbol)
      errors.push(issue("INVALID_SYMBOL", "종목코드가 비어 있습니다.", { row: rowNumber }));
    if (!date)
      errors.push(
        issue("INVALID_DATE", `거래일을 해석할 수 없습니다: ${String(record["date"] ?? "")}`, {
          row: rowNumber,
        }),
      );

    const numeric = {
      open: normalizedNumber(record["open"], { positive: true }),
      high: normalizedNumber(record["high"], { positive: true }),
      low: normalizedNumber(record["low"], { positive: true }),
      close: normalizedNumber(record["close"], { required: true, positive: true }),
      volume: normalizedNumber(record["volume"], { nonNegative: true }),
      tradingValue: normalizedNumber(record["tradingValue"], { nonNegative: true }),
      marketCap: normalizedNumber(record["marketCap"], { nonNegative: true }),
      foreignNetBuyValue: normalizedNumber(record["foreignNetBuyValue"]),
      institutionNetBuyValue: normalizedNumber(record["institutionNetBuyValue"]),
    };
    for (const [column, result] of Object.entries(numeric)) {
      if (result.error)
        errors.push(issue("INVALID_NUMBER", `${column}: ${result.error}`, { row: rowNumber }));
    }
    if (numeric.close.error) return;
    const close = Number(numeric.close.value);
    const open = numeric.open.value ? Number(numeric.open.value) : close;
    const high = numeric.high.value ? Number(numeric.high.value) : Math.max(open, close);
    const low = numeric.low.value ? Number(numeric.low.value) : Math.min(open, close);
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      errors.push(
        issue("INVALID_OHLC", "OHLC 가격의 고가·저가 관계가 맞지 않습니다.", { row: rowNumber }),
      );
      return;
    }
    if (!symbol || !date) return;

    let resolvedMarket = market;
    if (!resolvedMarket) {
      resolvedMarket = type === "INDEX" ? "INDEX" : type === "ETF" ? "ETF" : "KOSPI";
      if (!inferredMarketSymbols.has(symbol)) {
        inferredMarketSymbols.add(symbol);
        warnings.push(
          issue(
            "INFERRED_MARKET",
            `${symbol}의 market이 없어 ${resolvedMarket}(으)로 추정했습니다.`,
            { row: rowNumber },
          ),
        );
      }
    }
    const explicitSector = String(record["sector"] ?? "").trim();
    const resolvedSector = explicitSector
      ? SECTOR_NAME_BY_CODE[explicitSector.toUpperCase()]
        ? explicitSector.toUpperCase()
        : explicitSector
      : type === "INDEX"
        ? "MARKET_IDX"
        : resolveSectorCode(symbol, name, type === "ETF").code;

    const row: CanonicalSourceRow = {
      symbol,
      name,
      market: resolvedMarket,
      type,
      date,
      open: String(open),
      high: String(high),
      low: String(low),
      close: String(close),
      volume: numeric.volume.value || "0",
      tradingValue:
        numeric.tradingValue.value || String(close * Number(numeric.volume.value || "0")),
      marketCap: numeric.marketCap.value,
      foreignNetBuyValue: numeric.foreignNetBuyValue.value,
      institutionNetBuyValue: numeric.institutionNetBuyValue.value,
      sector: resolvedSector,
    };
    for (const column of CANONICAL_SOURCE_COLUMNS) {
      if (column in row) continue;
      row[column] = String(record[column] ?? "").trim();
    }
    const key = sourceRowKey(row);
    const previous = unique.get(key);
    if (!previous) unique.set(key, row);
    else if (sourceRowFingerprint(previous) === sourceRowFingerprint(row)) duplicates++;
    else
      errors.push(
        issue("DUPLICATE_CONFLICT", `${symbol} ${date} 행의 값이 서로 다릅니다.`, {
          row: rowNumber,
          key,
        }),
      );
  });

  if (duplicates > 0)
    warnings.push(
      issue(
        "DUPLICATE_IDENTICAL",
        `완전히 같은 종목·거래일 행 ${duplicates}건을 1건으로 정리했습니다.`,
      ),
    );
  return { rows: [...unique.values()], errors, warnings, duplicates };
}

function emptyStats(): SourceValidationStats {
  return {
    rowCount: 0,
    symbolCount: 0,
    minDate: null,
    maxDate: null,
    marketCount: 0,
    kospiCount: 0,
    kosdaqCount: 0,
    stockCount: 0,
    etfCount: 0,
    indexCount: 0,
    sectorMappedCount: 0,
    sectorUnmappedCount: 0,
    duplicateRowCount: 0,
    populatedColumnCount: 0,
    completelyEmptyColumns: [...CANONICAL_SOURCE_COLUMNS],
    columnNonEmptyRates: {},
  };
}

function statsFor(rows: CanonicalSourceRow[], duplicateRowCount: number): SourceValidationStats {
  const bySymbol = new Map<string, CanonicalSourceRow>();
  rows.forEach((row) => bySymbol.set(row.symbol, row));
  const instruments = [...bySymbol.values()];
  const nonIndexes = instruments.filter((row) => row.type !== "INDEX");
  const dates = rows.map((row) => row.date).sort();
  const columnNonEmptyRates = Object.fromEntries(
    CANONICAL_SOURCE_COLUMNS.map((column) => [
      column,
      rows.length ? rows.filter((row) => (row[column] ?? "").trim() !== "").length / rows.length : 0,
    ]),
  );
  const completelyEmptyColumns = CANONICAL_SOURCE_COLUMNS.filter(
    (column) => (columnNonEmptyRates[column] ?? 0) === 0,
  );
  return {
    rowCount: rows.length,
    symbolCount: instruments.length,
    minDate: dates[0] ?? null,
    maxDate: dates.at(-1) ?? null,
    marketCount: new Set(instruments.map((row) => row.market)).size,
    kospiCount: nonIndexes.filter((row) => row.market === "KOSPI").length,
    kosdaqCount: nonIndexes.filter((row) => row.market === "KOSDAQ").length,
    stockCount: nonIndexes.filter((row) => row.type === "STOCK").length,
    etfCount: nonIndexes.filter((row) => row.type === "ETF").length,
    indexCount: instruments.filter((row) => row.type === "INDEX").length,
    sectorMappedCount: nonIndexes.filter((row) => row.sector !== "ETC" && row.sector !== "기타")
      .length,
    sectorUnmappedCount: nonIndexes.filter((row) => row.sector === "ETC" || row.sector === "기타")
      .length,
    duplicateRowCount,
    populatedColumnCount: CANONICAL_SOURCE_COLUMNS.length - completelyEmptyColumns.length,
    completelyEmptyColumns,
    columnNonEmptyRates,
  };
}

function formatFromFilename(filename: string, textHint?: string): "csv" | "json" | "xlsx" {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) return "csv";
  const trimmed = textHint?.trim() ?? "";
  return trimmed.startsWith("[") || trimmed.startsWith("{") ? "json" : "csv";
}

async function recordsFromXlsx(bytes: Uint8Array): Promise<RecordSet> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { records: [], columns: [] };
  const table: unknown[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    table.push(
      values.map((value) => {
        if (value instanceof Date) return value;
        if (value && typeof value === "object") {
          const rich = value as { text?: string; result?: unknown };
          return rich.text ?? rich.result ?? String(value);
        }
        return value;
      }),
    );
  });
  return recordsFromTable(table);
}

function decodeText(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

export async function validateSourceBytes(input: {
  bytes: Uint8Array;
  filename: string;
  contentType?: string;
}): Promise<SourceValidationResult> {
  const filename = input.filename.trim() || "source.csv";
  const filenameFormat = formatFromFilename(filename);
  const rawText =
    filenameFormat !== "xlsx" &&
    input.bytes.byteLength > 0 &&
    input.bytes.byteLength <= SOURCE_MAX_FILE_BYTES
      ? decodeText(input.bytes)
      : "";
  const format = filenameFormat === "csv" ? formatFromFilename(filename, rawText) : filenameFormat;
  const errors: SourceValidationIssue[] = [];
  const warnings: SourceValidationIssue[] = [];
  if (input.bytes.byteLength === 0)
    errors.push(issue("EMPTY_FILE", "빈 파일은 등록할 수 없습니다."));
  if (input.bytes.byteLength > SOURCE_MAX_FILE_BYTES)
    errors.push(issue("FILE_TOO_LARGE", "파일 1개 크기는 45MB 이하여야 합니다."));

  let recordSet: RecordSet = { records: [], columns: [] };
  if (errors.length === 0) {
    try {
      recordSet =
        format === "xlsx"
          ? await recordsFromXlsx(input.bytes)
          : parseSourceTextRecords(rawText, format);
    } catch (error) {
      errors.push(
        issue(
          "PARSE_ERROR",
          `파일을 해석하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  const normalized = normalizeRecords(recordSet);
  // Large market-history files can contain hundreds of thousands of rows and
  // therefore as many row-level warnings. Spreading those arrays into push()
  // exceeds V8's argument limit and raises "Maximum call stack size exceeded".
  for (const error of normalized.errors) errors.push(error);
  for (const warning of normalized.warnings) warnings.push(warning);
  if (normalized.rows.length === 0 && errors.every((item) => item.code !== "EMPTY_FILE"))
    errors.push(issue("NO_DATA_ROWS", "유효한 데이터 행이 없습니다."));

  const canonicalCsv = toCanonicalCsv(normalized.rows);
  const sortedCsv = toCanonicalCsv(
    [...normalized.rows].sort((a, b) => sourceRowKey(a).localeCompare(sourceRowKey(b))),
  );
  const encoder = new TextEncoder();
  const [fileHash, dataHash, schemaHash] = await Promise.all([
    sha256(input.bytes),
    sha256(encoder.encode(sortedCsv)),
    sha256(encoder.encode(JSON.stringify([...new Set(recordSet.columns)].sort()))),
  ]);
  return {
    valid: errors.length === 0,
    format,
    originalFilename: filename.slice(0, 180),
    contentType:
      input.contentType ||
      (format === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : format === "json"
          ? "application/json"
          : "text/csv"),
    originalSizeBytes: input.bytes.byteLength,
    normalizedSizeBytes: encoder.encode(canonicalCsv).byteLength,
    fileHash,
    dataHash,
    schemaHash,
    canonicalCsv,
    columns: [...new Set(recordSet.columns)].sort(),
    rows: normalized.rows,
    stats: normalized.rows.length ? statsFor(normalized.rows, normalized.duplicates) : emptyStats(),
    errors,
    warnings,
  };
}

export async function validateSourceText(text: string, filename = "source.csv") {
  return validateSourceBytes({ bytes: new TextEncoder().encode(text), filename });
}

export async function validateSourceBlob(blob: Blob, filename: string) {
  return validateSourceBytes({
    bytes: new Uint8Array(await blob.arrayBuffer()),
    filename,
    contentType: blob.type,
  });
}

export function compareSourceRows(
  incoming: CanonicalSourceRow[],
  existing: Array<{ sourceId: string; rows: CanonicalSourceRow[] }>,
): SourceOverlapResult {
  const existingByKey = new Map<string, { sourceId: string; row: CanonicalSourceRow }>();
  for (const source of existing) {
    for (const row of source.rows)
      existingByKey.set(sourceRowKey(row), { sourceId: source.sourceId, row });
  }
  let newRows = 0;
  let identicalRows = 0;
  let conflictingRows = 0;
  const overlappingSymbols = new Set<string>();
  const examples: SourceOverlapResult["examples"] = [];
  for (const row of incoming) {
    const key = sourceRowKey(row);
    const previous = existingByKey.get(key);
    if (!previous) {
      newRows++;
      continue;
    }
    overlappingSymbols.add(row.symbol);
    const kind =
      sourceRowFingerprint(previous.row) === sourceRowFingerprint(row) ? "identical" : "conflict";
    if (kind === "identical") identicalRows++;
    else conflictingRows++;
    if (examples.length < 20)
      examples.push({ key: key.replace("\u0000", "/"), existingSourceId: previous.sourceId, kind });
  }
  return {
    incomingRows: incoming.length,
    newRows,
    identicalRows,
    conflictingRows,
    overlappingSymbols: overlappingSymbols.size,
    examples,
  };
}
