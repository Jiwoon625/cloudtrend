import { combineOperationalImpactPhases } from "./operationalImpactComparison";
import { validateSourceBytes } from "./sourceData";
import { screeningPublicationAnalysis } from "./screeningPublicationAnalysis";
import { screeningInputIdentity } from "./screeningInputIdentity";
import { hasOperationalIndexInstallation } from "./operationalIndexInstallation.server";
import { savedOperationalIdentity, type OperationalIndexIdentity } from "./screeningInputIdentity";
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
import { stableCacheJson, deterministicAnalysis } from "./screeningCacheContract";
import { OPERATIONAL_INDEX_ENABLED } from "./operationalUnderlyingIndexRelease";
export async function operationalArtifactForPublication(
  client: SupabaseClient,
  owner: string,
  asOfDate: string,
  now: string,
) {
  if (!OPERATIONAL_INDEX_ENABLED || asOfDate < OPERATIONAL_INDEX_START) return undefined;
  const installed = await hasOperationalIndexInstallation(client, owner);
  const text = await readArtifactText(client, owner, now);
  if (!installed && text === null) {
    if (await hasOperationalIndexInstallation(client, owner))
      throw new Error("MA60 설치가 시작됐습니다. 검증자료 설치 완료 후 다시 확인하세요.");
    return undefined;
  }
  if (!installed) throw new Error("MA60 설치 이력이 없습니다. 전용 자료 설치 상태를 확인하세요.");
  if (text === null)
    throw new Error("설치된 운영 MA60 자료가 사라졌습니다. 기존 계산으로 강등하지 않습니다.");
  return parseUnderlyingIndexArtifact(JSON.parse(text), now);
}

export async function loadOperationalIndex(
  client: SupabaseClient,
  owner: string,
  ds: MarketDataset,
  now: string,
  dryRun = false,
  saved?: OperationalIndexIdentity,
) {
  let artifact;
  if (dryRun || saved) {
    if (saved) savedOperationalIdentity({ asOfDate: ds.asOfDate, operationalIndex: saved });
    const text = await readArtifactText(client, owner, now);
    if (text === null) throw new Error("승인된 운영 MA60 자료가 설치되지 않았습니다.");
    artifact = parseUnderlyingIndexArtifact(JSON.parse(text), now);
  } else artifact = await operationalArtifactForPublication(client, owner, ds.asOfDate, now);
  if (!artifact) return undefined;
  const provider = buildOperationalIndexProvider(ds, artifact, now, { dryRunAtCutoff: dryRun });
  if (
    saved &&
    (!provider ||
      provider.version !== saved.version ||
      provider.artifactSha256 !== saved.artifactSha256 ||
      provider.availableFrom !== saved.availableFrom)
  )
    throw new Error("저장된 스크리닝과 MA60 자료 버전이 다릅니다.");
  return provider;
}
/** Owner-authenticated read-only impact check. Does not call publication, screening execution or portfolio services. */
export async function compareOperationalIndexPhase(
  client: SupabaseClient,
  owner: string,
  now: string,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
  phase: "web" | "actions" = "web",
) {
  let stage = "활성 원천 읽기";
  try {
    const { sources, texts } = await loadActiveSources(client, owner);
    const sourceDigest = sourceSetDigest(sources);
    if (phase === "actions") {
      // Reproduce the Actions canonical-CSV ingress without calling its runner/publisher/Shadow.
      // Release raw strings as each canonical source is produced to bound comparison memory.
      for (let i = 0; i < texts.length; i++) {
        stage = `Actions 입력 정규화 ${i + 1}/${sources.length}`;
        const validated = await validateSourceBytes({
          bytes: new TextEncoder().encode(texts[i]!),
          filename: sources[i]!.original_filename,
          streamingCsv: true,
        });
        if (
          !validated.valid ||
          validated.dataHash !== sources[i]!.data_hash ||
          validated.schemaHash !== sources[i]!.schema_hash
        )
          throw new Error("Actions 비교 입력 검증·논리 해시 불일치");
        texts[i] = validated.canonicalCsv;
      }
    }
    stage = phase === "web" ? "웹 원본 입력 계산" : "Actions 정규화 입력 계산";
    const first = await (async () => {
      const { dataset } = parseManualMarketDataWithReferences(texts);
      texts.length = 0;
      const before = datasetDigest(dataset);
      const provider = await loadOperationalIndex(client, owner, dataset, now, true);
      if (!provider) throw new Error("비교 기준일이 보강 자료보다 과거입니다.");
      const { analysis, dataset: engineDataset } = runFullMarketAnalysis(dataset, config);
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
      if (before !== finalHash) throw new Error("비교 도중 입력이 변경되었습니다.");
      const publication = screeningPublicationAnalysis(analysis, engineDataset, config, provider);
      const webResultDigest = indexSha256(stableCacheJson(deterministicAnalysis(publication)));
      const webInputFingerprint = indexSha256(
        stableCacheJson(screeningInputIdentity(sources, config, provider)),
      );
      const report = (() => {
        return {
          asOfDate: dataset.asOfDate,
          scoringConfigSha256: indexSha256(stableCacheJson(config)),
          usesDefaultScoringConfig:
            stableCacheJson(config) === stableCacheJson(DEFAULT_SCORING_CONFIG),
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
          ma60Changed: changes.filter((c) => c.before?.underlyingMa60 !== c.after?.underlyingMa60)
            .length,
          changes,
          providerSummary: {
            ready: Object.values(provider.rows).filter((r) => r.status === "ready").length,
            quarantined: Object.values(provider.rows).filter((r) => r.status === "quarantined")
              .length,
          },
        };
      })();
      return { webResultDigest, webInputFingerprint, report };
    })();
    if (sourceSetDigest(await listActiveSources(client, owner)) !== sourceDigest)
      throw new Error("비교 도중 입력이 변경되었습니다.");
    return { phase, ...first };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : "오류 상세 없음";
    throw new Error(`[${stage}] ${message.slice(0, 2000)}`);
  }
}

export async function compareOperationalIndex(
  client: SupabaseClient,
  owner: string,
  now: string,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
) {
  const web = await compareOperationalIndexPhase(client, owner, now, config, "web");
  const actions = await compareOperationalIndexPhase(client, owner, now, config, "actions");
  return combineOperationalImpactPhases(web, actions);
}
