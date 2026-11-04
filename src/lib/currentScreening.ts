import type { MarketDataset } from "./engine/dataset";
import { runFullMarketAnalysis } from "./engine/fullMarketAnalysis";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "./engine/scoring";

/** Daily screening only. Historical source bars and research engines stay intact. */
export function currentScreeningDataset(raw: MarketDataset): MarketDataset {
  const excluded: Array<{ symbol: string; name: string; last: string | null }> = [];
  const instruments = raw.instruments.filter((instrument) => {
    const bars = raw.bars[instrument.symbol] ?? [];
    const observed = raw.observedBars?.[instrument.symbol] ?? bars;
    const current = observed.some(
      (bar) => bar.tradeDate === raw.asOfDate && Number.isFinite(bar.close) && bar.close > 0,
    );
    if (!current) {
      excluded.push({
        symbol: instrument.symbol,
        name: instrument.name,
        last:
          observed
            .filter((b) => b.tradeDate <= raw.asOfDate && b.close > 0)
            .map((b) => b.tradeDate)
            .sort()
            .at(-1) ?? null,
      });
    }
    return current;
  });
  if (!instruments.length)
    throw new Error("기준 거래일 가격이 확인된 종목이 없습니다. 수집 상태를 확인하세요.");
  const allowed = new Set(instruments.map((instrument) => instrument.symbol));
  return {
    ...raw,
    instruments,
    bars: Object.fromEntries(Object.entries(raw.bars).filter(([symbol]) => allowed.has(symbol))),
    notes: [
      ...raw.notes,
      ...excluded.map(
        (item) =>
          `기준일 가격 미확인으로 스크리닝 제외: ${item.symbol} ${item.name} (기준일 ${raw.asOfDate}, 마지막 가격일 ${item.last ?? "확인 안 됨"}; 원인 미확정)`,
      ),
    ],
  };
}

export function runCurrentScreening(
  raw: MarketDataset,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
) {
  return runFullMarketAnalysis(currentScreeningDataset(raw), config);
}
