import type { KospiVolatilityObservation } from "./dataset";
import type { DailyPrice } from "./types";

/** Existing manual-provider 20-session annualized realized-volatility formula. */
export function realizedVolatilitySeries(closes: number[], window = 20): number[] {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const p0 = closes[i - 1]!;
    const p1 = closes[i]!;
    rets.push(p0 > 0 && p1 > 0 ? Math.log(p1 / p0) : 0);
  }
  const out: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < window) {
      out.push(Number.NaN);
      continue;
    }
    const slice = rets.slice(i - window, i);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / (slice.length - 1);
    out.push(Math.sqrt(variance * 252) * 100);
  }
  return out;
}

function validCloses(bars: DailyPrice[]): boolean {
  return bars.every((bar) => Number.isFinite(bar.close) && bar.close > 0);
}

/**
 * Preserve the provider's actual VKOSPI / existing realized-volatility choice.
 * The proxy's 70/30 blend is permitted only for identical dated return windows.
 * Warmup remains KOSPI-only, as in the original provider, and no new volatility
 * proxy is introduced. Missing/ambiguous contributor dates produce null evidence.
 */
export function buildDatedVolatilityObservations(
  kospiBars: DailyPrice[],
  kosdaqBars: DailyPrice[] = [],
  vkospiBars: DailyPrice[] = [],
): KospiVolatilityObservation[] {
  if (vkospiBars.length > 0) {
    return vkospiBars.map((bar) => ({ date: bar.tradeDate, value: bar.close, source: "VKOSPI" }));
  }
  const kospi = kospiBars.slice().sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const kosdaq = kosdaqBars.slice().sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const kospiVol = realizedVolatilitySeries(kospi.map((bar) => bar.close));
  const kosdaqVol = realizedVolatilitySeries(kosdaq.map((bar) => bar.close));
  const kosdaqByDate = new Map<string, number[]>();
  kosdaq.forEach((bar, index) => {
    const indices = kosdaqByDate.get(bar.tradeDate) ?? [];
    indices.push(index);
    kosdaqByDate.set(bar.tradeDate, indices);
  });

  return kospi.map((bar, index): KospiVolatilityObservation => {
    const point: KospiVolatilityObservation = {
      date: bar.tradeDate,
      value: null,
      source: "REALIZED_VOLATILITY_KOSPI",
    };
    const value = kospiVol[index]!;
    const window = kospi.slice(Math.max(0, index - 20), index + 1);
    if (window.length !== 21 || !validCloses(window) || !Number.isFinite(value)) {
      point.issues = ["MISSING_OR_NONFINITE_VOLATILITY_PROXY_WINDOW"];
      return point;
    }
    if (new Set(window.map((item) => item.tradeDate)).size !== window.length) {
      point.issues = ["AMBIGUOUS_VOLATILITY_PROXY_DATE"];
      return point;
    }
    if (kosdaq.length === 0) return { ...point, value };

    const matching = kosdaqByDate.get(bar.tradeDate) ?? [];
    if (matching.length !== 1) {
      point.issues = [
        matching.length > 1 ? "AMBIGUOUS_VOLATILITY_PROXY_DATE" : "VOLATILITY_PROXY_DATE_MISMATCH",
      ];
      return point;
    }
    const kosdaqIndex = matching[0]!;
    // The existing definition uses KOSPI alone before KOSDAQ's 20-return warmup.
    if (kosdaqIndex < 20) return { ...point, value };
    point.source = "REALIZED_VOLATILITY_KOSPI_KOSDAQ_70_30";
    const kosdaqWindow = kosdaq.slice(kosdaqIndex - 20, kosdaqIndex + 1);
    if (window.some((item, at) => item.tradeDate !== kosdaqWindow[at]?.tradeDate)) {
      point.issues = ["VOLATILITY_PROXY_DATE_MISMATCH"];
      return point;
    }
    const kosdaqValue = kosdaqVol[kosdaqIndex]!;
    if (!validCloses(kosdaqWindow) || !Number.isFinite(kosdaqValue)) {
      point.issues = ["MISSING_OR_NONFINITE_VOLATILITY_PROXY_WINDOW"];
      return point;
    }
    point.value = 0.7 * value + 0.3 * kosdaqValue;
    return point;
  });
}
