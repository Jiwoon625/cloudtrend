import {
  VF_STOCK_PL_FALLBACK_OVERHEAT_THRESHOLD,
  getV8EtfPlOverheatThreshold,
} from "./vfConfig";

export type V8SectorPlSource = "ETF" | "STOCK" | null;

export interface V8SectorPlSelection {
  value: number | null;
  source: V8SectorPlSource;
  threshold: number | null;
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

/**
 * Production V8 policy:
 * 1) use sector ETF PL when available,
 * 2) otherwise fall back to Stock PL,
 * 3) use market-specific ETF thresholds (KOSPI 84 / KOSDAQ 85),
 * 4) keep Stock PL fallback threshold at 80.
 */
export function selectV8SectorPriceLeadership(
  market: "KOSPI" | "KOSDAQ",
  sectorCode: string,
  stockPl: Map<string, number>,
  etfPl: Map<string, number>,
): V8SectorPlSelection {
  const etfValue = etfPl.get(sectorCode);
  if (finite(etfValue)) {
    return {
      value: etfValue,
      source: "ETF",
      threshold: getV8EtfPlOverheatThreshold(market),
    };
  }

  const stockValue = stockPl.get(sectorCode);
  if (finite(stockValue)) {
    return {
      value: stockValue,
      source: "STOCK",
      threshold: VF_STOCK_PL_FALLBACK_OVERHEAT_THRESHOLD,
    };
  }

  return { value: null, source: null, threshold: null };
}
