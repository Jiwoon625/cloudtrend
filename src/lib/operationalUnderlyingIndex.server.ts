import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketDataset } from "./engine/dataset";
import {
  readArtifactText,
  datasetDigest,
  sourceSetDigest,
  indexSha256,
} from "./underlyingIndexDiagnostics.server";
import { parseUnderlyingIndexArtifact } from "./underlyingIndexSupplement";
import {
  buildOperationalIndexProvider,
  OPERATIONAL_INDEX_START,
} from "./operationalUnderlyingIndex";
import { loadActiveSources, listActiveSources } from "./screeningSources.server";
import { parseManualMarketDataWithReferences } from "./krxReviewReferenceParser";
import { runFullMarketAnalysis } from "./engine/fullMarketAnalysis";
import { withOperationalEtfMa60 } from "./operationalEtfMa60";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "./engine/scoring";
import { stableCacheJson } from "./screeningCacheContract";
import { OPERATIONAL_INDEX_ENABLED } from "./operationalUnderlyingIndexRelease";
export async function loadOperationalIndex(
  client: SupabaseClient,
  owner: string,
  ds: MarketDataset,
  now: string,
  dryRun = false,
) {
  if (!dryRun && (!OPERATIONAL_INDEX_ENABLED || ds.asOfDate < OPERATIONAL_INDEX_START))
    return undefined;
  const text = await readArtifactText(client, owner, now);
  if (text === null) throw new Error("승인된 운영 MA60 자료가 설치되지 않았습니다.");
  return buildOperationalIndexProvider(
    ds,
    parseUnderlyingIndexArtifact(JSON.parse(text), now),
    now,
    { dryRunAtCutoff: dryRun },
  );
}
/** Owner-authenticated read-only impact check. Does not call publication, screening execution or portfolio services. */
export async function compareOperationalIndex(
  client: SupabaseClient,
  owner: string,
  now: string,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
) {
  const { sources, texts } = await loadActiveSources(client, owner);
  const sourceDigest = sourceSetDigest(sources);
  const { dataset } = parseManualMarketDataWithReferences(texts);
  const before = datasetDigest(dataset);
  const provider = await loadOperationalIndex(client, owner, dataset, now, true);
  if (!provider) throw new Error("비교 기준일이 보강 자료보다 과거입니다.");
  const { analysis } = runFullMarketAnalysis(dataset, config);
  const after = withOperationalEtfMa60(analysis, provider);
  const changes = after.rows.flatMap((row, i) => {
    const old = analysis.rows[i]!;
    if (stableCacheJson(old.etfStrategy) === stableCacheJson(row.etfStrategy)) return [];
    return [
      {
        symbol: row.instrument.symbol,
        name: row.instrument.name,
        before: old.etfStrategy,
        after: row.etfStrategy,
      },
    ];
  });
  const scores = [
    "score",
    "previousScore",
    "technical",
    "priority",
    "health",
    "environment",
    "environmentSource",
    "eligible",
    "rawOnset",
    "originDate",
  ] as const;
  const unexpected = after.rows
    .filter((row, i) =>
      scores.some((k) => row.etfStrategy?.[k] !== analysis.rows[i]?.etfStrategy?.[k]),
    )
    .map((r) => r.instrument.symbol);
  const finalHash = datasetDigest(dataset);
  if (
    before !== finalHash ||
    sourceSetDigest(await listActiveSources(client, owner)) !== sourceDigest
  )
    throw new Error("비교 도중 입력이 변경되었습니다.");
  return {
    asOfDate: dataset.asOfDate,
    scoringConfigSha256: indexSha256(stableCacheJson(config)),
    usesDefaultScoringConfig: stableCacheJson(config) === stableCacheJson(DEFAULT_SCORING_CONFIG),
    providerVersion: provider.version,
    artifactSha256: provider.artifactSha256,
    sourceSetDigest: sourceDigest,
    datasetBeforeSha256: before,
    datasetAfterSha256: finalHash,
    writesPerformed: 0,
    activeSourcesRead: sources.length,
    rows: analysis.rows.length,
    unexpectedScoreChanges: unexpected,
    signalChanges: changes.filter(
      (c) =>
        c.before?.onset !== c.after?.onset ||
        c.before?.exit !== c.after?.exit ||
        c.before?.entryState !== c.after?.entryState,
    ),
    ma60Changed: changes.filter((c) => c.before?.underlyingMa60 !== c.after?.underlyingMa60).length,
    changes,
    providerSummary: {
      ready: Object.values(provider.rows).filter((r) => r.status === "ready").length,
      quarantined: Object.values(provider.rows).filter((r) => r.status === "quarantined").length,
    },
  };
}
