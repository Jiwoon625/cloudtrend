import type { MarketDataset } from "./dataset";
import { parseManualMarketData } from "./manualDataset";
import {
  CANONICAL_SOURCE_COLUMNS,
  toCanonicalCsv,
  visitDelimitedRows,
  type CanonicalSourceRow,
} from "../sourceData";

const REQUIRED_DETAIL_INDEXES = new Set(["KOSPI", "KOSDAQ", "VKOSPI"]);

function normalizeDetailSymbol(value: unknown) {
  let symbol = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/^A(?=\d{6}$)/, "")
    .replace(/\.0$/, "");
  if (/^\d{1,6}$/.test(symbol)) symbol = symbol.padStart(6, "0");
  return symbol;
}

/**
 * 종목 상세 차트 계산에는 선택 종목과 시장 지수만 필요하다.
 * 전체 원천을 다시 분석하지 않으면서도 parseManualMarketData의 시장 게이트 계약을 충족한다.
 */
export function buildInstrumentDetailDataset(text: string, symbol: string): MarketDataset {
  const target = normalizeDetailSymbol(symbol);
  const rows: CanonicalSourceRow[] = [];
  let indexes: Record<string, number> | null = null;
  let targetRows = 0;

  visitDelimitedRows(text, (cells, rowIndex) => {
    if (rowIndex === 0) {
      indexes = Object.fromEntries(
        cells.map((column, index) => [column, index]),
      ) as Record<string, number>;
      return;
    }
    if (!indexes) return;
    const rawSymbol = normalizeDetailSymbol(cells[indexes["symbol"] ?? -1]);
    if (rawSymbol !== target && !REQUIRED_DETAIL_INDEXES.has(rawSymbol)) return;

    const row = {} as CanonicalSourceRow;
    for (const column of CANONICAL_SOURCE_COLUMNS) {
      row[column] = String(cells[indexes[column] ?? -1] ?? "");
    }
    row.symbol = rawSymbol;
    rows.push(row);
    if (rawSymbol === target) targetRows++;
  });

  if (targetRows === 0) throw new Error(`${target}의 원천 일봉을 찾지 못했습니다.`);
  return parseManualMarketData(toCanonicalCsv(rows)).dataset;
}
