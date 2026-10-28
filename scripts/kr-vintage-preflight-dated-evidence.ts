import type { MarketDataset } from "../src/lib/engine/dataset";
import type { ScreeningSnapshot } from "../src/lib/screeningSnapshot";
/* Exact AST extraction; no server module import. */
export function currentDateEvidence(dataset: MarketDataset, snapshot: ScreeningSnapshot) {
  const date = snapshot.asOfDate;
  return {
    version: "shadow-dated-input-v1",
    date,
    universe: dataset.instruments.map((instrument) => ({
      symbol: instrument.symbol,
      name: instrument.name,
      market: instrument.market,
      instrumentType: instrument.instrumentType,
      sectorCode: instrument.sectorCode,
    })),
    bars: Object.fromEntries(
      dataset.instruments.map((instrument) => [
        instrument.symbol,
        (
          (date >= "2026-10-12" ? dataset.observedBars?.[instrument.symbol] : undefined) ??
          dataset.bars[instrument.symbol] ??
          []
        ).filter((bar) => bar.tradeDate === date),
      ]),
    ),
    indexes: dataset.indexSeries.map((series) => ({
      indexCode: series.indexCode,
      bars: series.bars.filter((bar) => bar.tradeDate === date),
    })),
    marketGate: snapshot.kospiMarketGate ?? null,
    snapshotEntries: snapshot.entries,
  };
}
