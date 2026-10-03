import type { UsProspectiveCacheRow } from "./usProspectiveCloud";

export interface UsDataQuality {
  rowCount: number;
  duplicateSymbols: number;
  dateMismatch: number;
  coverage: Array<{ key: string; label: string; present: number }>;
}

/** Coverage of saved screening fields only. This is not raw OHLC/bar validation. */
export function summarizeUsDataQuality(rows: UsProspectiveCacheRow[], date: string): UsDataQuality {
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const positive = (v: unknown) => finite(v) && Number(v) > 0;
  const fields: Array<[string, string, (r: UsProspectiveCacheRow) => boolean]> = [
    ["open", "시가", (r) => positive(r.open)],
    ["close", "종가", (r) => positive(r.close)],
    ["marketCap", "시가총액", (r) => positive(r.marketCap)],
    ["sector", "섹터 분류", (r) => typeof r.sector === "string" && r.sector.trim().length > 0],
    ["returns", "120·252일 수익률", (r) => finite(r.ret120) && finite(r.ret252)],
    ["coreRank", "Core 순위", (r) => finite(r.coreRank)],
    ["betaRank", "Beta 순위", (r) => finite(r.betaRank)],
    ["tkRank", "TK gap 순위", (r) => finite(r.tkRank)],
    ["adv20Usd", "ADV20 거래대금", (r) => positive(r.adv20Usd)],
    ["liquidityRank", "유동성 순위", (r) => finite(r.liquidityRank)],
  ];
  return {
    rowCount: rows.length,
    duplicateSymbols: rows.length - new Set(rows.map((r) => r.symbol)).size,
    dateMismatch: rows.filter((r) => r.date !== date).length,
    coverage: fields.map(([key, label, present]) => ({
      key,
      label,
      present: rows.filter(present).length,
    })),
  };
}
