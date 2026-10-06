import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketDataset } from "./engine/dataset";
import type { AnalysisResult } from "./engine/pipeline";
import type { ScoringConfig } from "./engine/scoring";
import type { ActiveSourceRecord } from "./screeningSources.server";
import type { ScreeningSnapshot } from "./screeningSnapshot";
import { MODEL_ACCOUNTING_START } from "./ledger/modelSeries";
import { replayKrShadow } from "./shadowReplay.server";

/**
 * The web screening remains a latest-view calculation.
 * Shadow is independent: it replays every missing KR session from the frozen ledger head
 * through the newest dated input, regardless of when the upload/screening was run.
 */
export async function recordWebOctoberShadow(input: {
  client: SupabaseClient;
  userId: string;
  dataset: MarketDataset;
  analysis: AnalysisResult;
  config: ScoringConfig;
  snapshot: ScreeningSnapshot;
  sources: ActiveSourceRecord[];
  decisionAt: string;
}) {
  if (input.analysis.asOfDate < MODEL_ACCOUNTING_START)
    return {
      status: "WAITING_START" as const,
      market: "KR" as const,
      calculatedAt: input.decisionAt,
      processed: [],
      deferred: null,
      latestRecordedDate: null,
      throughDate: input.analysis.asOfDate,
    };
  const replay = await replayKrShadow({
    client: input.client,
    userId: input.userId,
    dataset: input.dataset,
    config: input.config,
    sources: input.sources,
    mode: "authenticated-owner",
    calculatedAt: input.decisionAt,
  });
  return {
    ...replay,
    status: replay.deferred
      ? ("DEFERRED" as const)
      : replay.processed.length
        ? ("RECORDED" as const)
        : ("UP_TO_DATE" as const),
  };
}
