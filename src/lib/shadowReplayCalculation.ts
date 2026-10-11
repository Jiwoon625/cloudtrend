import type { MarketDataset } from "./engine/dataset";
import type { ScoringConfig } from "./engine/scoring";
import { runFullMarketAnalysis } from "./engine/fullMarketAnalysis";
import { buildFullUniverseSectorDataset } from "./engine/sectorRotationFullUniverse";
import { RESTART_ACCOUNTING_START } from "./ledger/modelSeries";

// Pure replay input/scoring preparation is explicitly covered by the reviewed runtime manifest.
export function sliceKrDatasetForReplay(raw: MarketDataset, date: string): MarketDataset {
  const copy = structuredClone(raw);
  const current = new Set(
    raw.instruments
      .filter(
        (instrument) =>
          (raw.bars[instrument.symbol] ?? []).some((bar) => bar.tradeDate === date) ||
          (date >= RESTART_ACCOUNTING_START &&
            (raw.observedBars?.[instrument.symbol] ?? []).some((bar) => bar.tradeDate === date)),
      )
      .map((instrument) => instrument.symbol),
  );
  copy.instruments = raw.instruments
    .filter((instrument) => current.has(instrument.symbol))
    .map((instrument) => structuredClone(instrument));
  copy.bars = Object.fromEntries(
    copy.instruments.map((instrument) => [
      instrument.symbol,
      (raw.bars[instrument.symbol] ?? [])
        .filter((bar) => bar.tradeDate <= date)
        .map((bar) => structuredClone(bar)),
    ]),
  );
  if (raw.observedBars)
    copy.observedBars = Object.fromEntries(
      Object.entries(raw.observedBars).map(([symbol, bars]) => [
        symbol,
        bars.filter((bar) => bar.tradeDate <= date).map((bar) => structuredClone(bar)),
      ]),
    );
  copy.indexSeries = raw.indexSeries.map((series) => ({
    ...structuredClone(series),
    bars: series.bars.filter((bar) => bar.tradeDate <= date).map((bar) => structuredClone(bar)),
  }));
  copy.tradeDates = raw.tradeDates.filter((day) => day <= date);
  copy.kospiGateDates = (raw.kospiGateDates ?? raw.tradeDates).filter((day) => day <= date);
  if (copy.vkospiObservations)
    copy.vkospiObservations = copy.vkospiObservations.filter((point) => point.date <= date);
  // The legacy gate consumes the last array value. Rebuild it from dated history;
  // an old undated array cannot establish which values were available on this day.
  // Preserve the evidence itself (including duplicates/provenance issues) so the
  // strict dated gate can still diagnose it. Match the provider's finite projection.
  copy.vkospiSeries = (copy.vkospiObservations ?? [])
    .filter(
      (point) =>
        /^\d{4}-\d{2}-\d{2}$/.test(point.date) &&
        Number.isFinite(Date.parse(`${point.date}T00:00:00Z`)) &&
        new Date(`${point.date}T00:00:00Z`).toISOString().slice(0, 10) === point.date,
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((point) => point.value)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (copy.kospiPriceInputIssues)
    copy.kospiPriceInputIssues = Object.fromEntries(
      Object.entries(copy.kospiPriceInputIssues).filter(([day]) => day <= date),
    );
  copy.asOfDate = date;
  copy.version = `${raw.version}@shadow-${date}`;
  return copy;
}

/** Keep execution observations separate from the current-close scoring universe. */
export function analyzeKrReplayDataset(dataset: MarketDataset, config: ScoringConfig) {
  if (dataset.asOfDate < RESTART_ACCOUNTING_START) return runFullMarketAnalysis(dataset, config);
  const executionDataset = buildFullUniverseSectorDataset(dataset);
  const scoringDataset = {
    ...executionDataset,
    instruments: executionDataset.instruments.filter((instrument) =>
      (executionDataset.bars[instrument.symbol] ?? []).some(
        (bar) => bar.tradeDate === dataset.asOfDate && Number.isFinite(bar.close) && bar.close > 0,
      ),
    ),
  };
  const { analysis } = runFullMarketAnalysis(scoringDataset, config);
  // Historical valid closes remain available to archive integrity checks and held
  // position adapters, but cannot manufacture a current score or close signal.
  return { analysis, dataset: executionDataset };
}
