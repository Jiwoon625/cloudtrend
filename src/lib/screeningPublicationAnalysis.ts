import type { AnalysisResult } from "./engine/pipeline";
import type { MarketDataset } from "./engine/dataset";
import type { ScoringConfig } from "./engine/scoring";
import type { OperationalIndexProvider } from "./operationalUnderlyingIndex";
import { withOperationalEtfMa60 } from "./operationalEtfMa60";
import { withOnsetProfiles } from "./onsetProfile";
import { withKrxReviewReferences } from "./krxReviewReferenceParser";

/** Web and Actions publish the same projection. Shadow keeps the untouched engine result. */
export function screeningPublicationAnalysis(
  engineAnalysis: AnalysisResult,
  dataset: MarketDataset,
  config: ScoringConfig,
  provider?: OperationalIndexProvider,
) {
  return withKrxReviewReferences(
    withOnsetProfiles(withOperationalEtfMa60(engineAnalysis, provider), dataset, config),
    dataset,
  );
}
