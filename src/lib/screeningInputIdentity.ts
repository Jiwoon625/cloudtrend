import type { ScoringConfig } from "./engine/scoring";
import { SCREENING_CACHE_VERSION } from "./screeningCacheContract";
import { sourceFingerprintRecords } from "./sourceFingerprintRecords";
import { OPERATIONAL_INDEX_START, OPERATIONAL_INDEX_VERSION } from "./operationalUnderlyingIndex";
import { UNDERLYING_INDEX_RELEASE } from "./underlyingIndexSupplementRelease";

export interface OperationalIndexIdentity {
  version: string;
  artifactSha256: string;
  asOfDate: string;
  availableFrom: string;
}

/** Saved results select a pinned reader; the current enable flag is deliberately irrelevant.
 * Keep old reader identities here when adding a future provider. Never upgrade saved metadata.
 */
export function savedOperationalIdentity(value: {
  asOfDate: string;
  operationalIndex?: unknown;
}): OperationalIndexIdentity | undefined {
  const meta = value.operationalIndex;
  if (meta === undefined) return undefined;
  if (!meta || typeof meta !== "object") throw new Error("저장된 MA60 공급 정보가 손상됐습니다.");
  const m = meta as Partial<OperationalIndexIdentity>;
  if (
    m.version !== OPERATIONAL_INDEX_VERSION ||
    m.artifactSha256 !== UNDERLYING_INDEX_RELEASE.sha256 ||
    m.asOfDate !== value.asOfDate ||
    !/^\d{4}-\d{2}-\d{2}$/.test(m.asOfDate ?? "") ||
    m.asOfDate < OPERATIONAL_INDEX_START ||
    typeof m.availableFrom !== "string" ||
    !Number.isFinite(Date.parse(m.availableFrom))
  )
    throw new Error("저장된 MA60 공급 버전·승인 해시·기준일을 확인할 수 없습니다.");
  return m as OperationalIndexIdentity;
}

export type FingerprintSource = Parameters<typeof sourceFingerprintRecords>[0][number];
export interface LegacyFingerprint {
  dataHash: string | null;
  schemaHash: string | null;
  savedAt: string | null;
  chars: number | null;
}
/** Input order is calculation precedence, not lexical symbol/id order. All three callers use this. */
export function screeningInputIdentity(
  sources: readonly FingerprintSource[],
  config: ScoringConfig,
  operationalIndex?: OperationalIndexIdentity,
  legacyFallback: LegacyFingerprint | null = null,
) {
  return {
    version: SCREENING_CACHE_VERSION,
    strategyConfig: config,
    sources: sourceFingerprintRecords(sources),
    legacyFallback: sources.length ? null : legacyFallback,
    ...(operationalIndex
      ? {
          operationalIndex: {
            version: operationalIndex.version,
            artifactSha256: operationalIndex.artifactSha256,
          },
        }
      : {}),
  };
}
