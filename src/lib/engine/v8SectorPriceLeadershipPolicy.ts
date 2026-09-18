import { VF_STOCK_PL_FALLBACK_OVERHEAT_THRESHOLD, getV8EtfPlOverheatThreshold } from "./vfConfig";

export type V8SectorPlSource = "ETF" | "STOCK" | null;

export interface V8SectorPlSelection {
  value: number | null;
  source: V8SectorPlSource;
  threshold: number | null;
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

/**
 * Production V8 policy after the complete 2018-2025 annual OOS gate:
 * - KOSPI: use sector ETF PL at threshold 84, with Stock PL 80 fallback.
 * - KOSDAQ: retain the existing Stock PL 80 policy; ETF PL 85 did not clear
 *   the final robustness gate.
 */
export function selectV8SectorPriceLeadership(
  market: "KOSPI" | "KOSDAQ",
  sectorCode: string,
  stockPl: Map<string, number>,
  etfPl: Map<string, number>,
): V8SectorPlSelection {
  if (market === "KOSPI") {
    const etfValue = etfPl.get(sectorCode);
    if (finite(etfValue)) {
      return {
        value: etfValue,
        source: "ETF",
        threshold: getV8EtfPlOverheatThreshold("KOSPI"),
      };
    }
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
