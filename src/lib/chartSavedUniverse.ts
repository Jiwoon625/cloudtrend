import type { MarketDataset } from "./engine/dataset";
import type { AnalysisResult } from "./engine/pipeline";

/** Reconstruct the saved calculation universe, not today's mutable selection.
 * Current screening excludes missing-current-price instruments before calculating
 * ETF peers and stock sectors. Restoring all raw instruments changes M0 even
 * when every source byte is identical. Historical/legacy publications keep their
 * own saved membership; this layer never reruns screening or changes prices.
 */
export function chartSavedUniverse(raw: MarketDataset, analysis: AnalysisResult): MarketDataset {
  if (raw.asOfDate !== analysis.asOfDate)
    throw new Error("차트 원천과 저장된 스크리닝의 기준일이 다릅니다.");
  const saved = new Map(analysis.rows.map((row) => [row.instrument.symbol, row.instrument]));
  const available = new Map(raw.instruments.map((instrument) => [instrument.symbol, instrument]));
  if (saved.size !== analysis.rows.length || available.size !== raw.instruments.length)
    throw new Error("차트 유니버스에 중복 종목이 있습니다.");
  for (const [symbol, instrument] of saved) {
    const original = available.get(symbol);
    if (!original || original.instrumentType !== instrument.instrumentType)
      throw new Error(`저장된 차트 대상 종목의 원천이 다릅니다: ${symbol}`);
  }
  // Preserve the original input order and every real bar; only membership is
  // restored. Do not filter old dates by present-day price availability.
  const bars = Object.fromEntries(Object.entries(raw.bars).filter(([symbol]) => saved.has(symbol)));
  const observedBars = raw.observedBars
    ? Object.fromEntries(Object.entries(raw.observedBars).filter(([symbol]) => saved.has(symbol)))
    : undefined;
  return {
    ...raw,
    instruments: raw.instruments.filter((instrument) => saved.has(instrument.symbol)),
    bars,
    ...(observedBars ? { observedBars } : {}),
  };
}
