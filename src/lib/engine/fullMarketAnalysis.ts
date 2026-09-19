import type { MarketDataset } from "./dataset";
import { runAnalysis, type AnalysisResult } from "./pipeline";
import {
  buildFullUniverseSectorDataset,
  computeFullUniverseSectorRotation,
} from "./sectorRotationFullUniverse";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "./scoring";

/**
 * Browser screening, dashboard snapshots, and trusted automation share this
 * exact orchestration layer. Keeping the orchestration pure prevents the CLI
 * from silently drifting from the values rendered by the web application.
 */
export function runFullMarketAnalysis(
  rawDataset: MarketDataset,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): { analysis: AnalysisResult; dataset: MarketDataset } {
  const dataset = buildFullUniverseSectorDataset(rawDataset);
  const analysis = runAnalysis(dataset, config);
  // Preserve the V8 structural signals, status and score delta from the pipeline.

  const representativeEtf = new Map<string, { symbol: string; name: string }>();
  for (const sector of analysis.sectorRotation?.sectors ?? []) {
    if (sector.representativeEtfSymbol && sector.representativeEtf) {
      representativeEtf.set(sector.sectorCode, {
        symbol: sector.representativeEtfSymbol,
        name: sector.representativeEtf,
      });
    }
  }

  analysis.sectorRotation = computeFullUniverseSectorRotation(dataset, {
    representativeEtf,
    weights: config.rotation,
  });
  return { analysis, dataset };
}
