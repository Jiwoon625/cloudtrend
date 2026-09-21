import type { MarketDataset } from "./dataset";
import { computeIndicators, type IndicatorSnapshot } from "./indicators";
import { historicalTechnicalScore, type ScoringConfig } from "./scoring";
import { computeV8SectorPriceLeadership } from "./v8SectorPriceLeadership";
import { selectV8SectorPriceLeadership } from "./v8SectorPriceLeadershipPolicy";
import { buildFullUniverseSectorDataset } from "./sectorRotationFullUniverse";

// Dataset objects are immutable snapshots; a newly loaded source gets a new cache.
const normalizedDatasets = new WeakMap<MarketDataset, MarketDataset>();
export function historicalSectorDataset(raw: MarketDataset) {
  let dataset = normalizedDatasets.get(raw);
  if (!dataset) {
    dataset = buildFullUniverseSectorDataset(raw);
    normalizedDatasets.set(raw, dataset);
  }
  return dataset;
}

const leadershipByDataset = new WeakMap<MarketDataset, Map<string, Map<string, number>>>();
function leadershipAtDate(dataset: MarketDataset, date: string, source: "STOCK" | "ETF") {
  let cache = leadershipByDataset.get(dataset);
  if (!cache) {
    cache = new Map();
    leadershipByDataset.set(dataset, cache);
  }
  const key = `${source}:${date}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const benchmark = dataset.indexSeries.find((series) => series.indexCode === "KOSPI");
  const index = benchmark?.bars.findIndex((bar) => bar.tradeDate === date) ?? -1;
  // Match by trading date, not by the target stock's position (suspensions/gaps).
  const result =
    benchmark && index >= 0
      ? computeV8SectorPriceLeadership(dataset, benchmark.bars.length - 1 - index, source)
      : new Map<string, number>();
  cache.set(key, result);
  return result;
}

/** Same dated universe, market policy and 0.5-point slot as runAnalysis. */
export function historicalInstrumentScore(
  dataset: MarketDataset,
  symbol: string,
  index: number,
  cfg: ScoringConfig,
  snapshot?: IndicatorSnapshot,
) {
  const bars = dataset.bars[symbol] ?? [];
  const snap = snapshot ?? computeIndicators(bars, index);
  const instrument = dataset.instruments.find((item) => item.symbol === symbol);
  if (!instrument || instrument.instrumentType !== "STOCK")
    return historicalTechnicalScore(snap, cfg);
  const date = bars[index]!.tradeDate;
  const market = instrument.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
  const selection = selectV8SectorPriceLeadership(
    market,
    instrument.sectorCode,
    leadershipAtDate(dataset, date, "STOCK"),
    market === "KOSPI" ? leadershipAtDate(dataset, date, "ETF") : new Map(),
  );
  return historicalTechnicalScore(snap, cfg, {
    sectorPriceLeadership: selection.value,
    sectorPriceLeadershipThreshold: selection.threshold,
  });
}
