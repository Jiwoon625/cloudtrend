import type { MarketDataset } from "../../src/lib/engine/dataset";
import type { ScoringConfig } from "../../src/lib/engine/scoring";
import type { FrozenModelSeries, SeriesHash } from "../../src/lib/ledger/modelSeries";
import type { OctoberRun } from "../../src/lib/ledger/octoberShadowPipeline";
import type { KrDailyInputArchive } from "../../src/lib/ledger/octoberShadowArchive";
import type { KrSourceVintagePrivateApproval } from "../../src/lib/ledger/krSourceVintage";

/** Private capture. Transport must bind every raw byte to its current registered hash and generation. */
export interface FinalCapture {
  version: "kr-final-retrospective-capture-v1";
  owner: string;
  codeCommit: string;
  runtimeHashes: { october: SeriesHash; kospi: SeriesHash };
  capturedAt: string;
  computedAt: string;
  sourceManifest: unknown;
  captureManifest: unknown;
  preservationBaseline: unknown;
  finalPublication: { hash: SeriesHash; activatedAt: string; asOfDate: string };
  dataset: MarketDataset;
  config: ScoringConfig;
  sourceVintageApproval: KrSourceVintagePrivateApproval;
  predecessors: Array<{ series: FrozenModelSeries; run: OctoberRun; payloadHash: SeriesHash }>;
  archives: Array<{ hash: SeriesHash; payload: KrDailyInputArchive }>;
  legacyObjects: Record<string, { hash: SeriesHash; payload: unknown }>;
}
