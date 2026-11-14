import {
  assertScreeningResultTransition,
  type ScreeningEngineIdentity,
} from "../src/lib/screeningEngineIdentity";
import { preserveConfirmedEtfContext } from "../src/lib/confirmedEtfContext.server";
import {
  screeningInputIdentity,
  savedOperationalIdentity,
  type OperationalIndexIdentity,
} from "../src/lib/screeningInputIdentity";
import { memory } from "./screening-memory";
import type { DriveResultPublication } from "../src/lib/driveResultPublication";
import { krResultPhase } from "../src/lib/driveResultPublication";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildDashboardSummary,
  SCREENING_CACHE_VERSION,
  stableCacheJson,
  deterministicAnalysis,
} from "../src/lib/screeningCacheContract";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import type { ScoringConfig } from "../src/lib/engine/scoring";
import type { ScreeningSnapshot } from "../src/lib/screeningSnapshot";
import { CANONICAL_SOURCE_COLUMNS, visitDelimitedRows } from "../src/lib/sourceData";
import type { AnalysisPayload } from "../src/lib/marketPayload";
import { ANALYSIS_BUCKET, downloadJson, sha256, uploadJson } from "./analysis-run-store";
import { compressedCacheObjectPath } from "../src/lib/cacheObjectEncoding";
import { downloadCachePointer, uploadCachePointer } from "./screening-cache-pointer";
import type { LoadedSourceInput } from "./source-registry-store";

const MAX_RAW_CACHE_BYTES = 45 * 1024 * 1024;

export interface ExistingScreeningCache {
  publicationId?: string;
  engineIdentity?: ScreeningEngineIdentity;
  version?: string;
  inputFingerprint?: string;
  resultDigest?: string;
  payload?: AnalysisPayload;
}

function resultDigest(analysis: AnalysisResult) {
  return sha256(stableCacheJson(deterministicAnalysis(analysis)));
}

export function inputFingerprint(
  inputs: LoadedSourceInput[],
  config: ScoringConfig,
  operationalIndex?: OperationalIndexIdentity,
) {
  const sources = inputs.flatMap((input) => (input.sourceRecord ? [input.sourceRecord] : []));
  return sha256(
    stableCacheJson(
      screeningInputIdentity(
        sources,
        config,
        operationalIndex,
        sources.length
          ? null
          : {
              dataHash: inputs.at(-1)?.dataHash ?? null,
              schemaHash: inputs.at(-1)?.schemaHash ?? null,
              savedAt: inputs.at(-1)?.savedAt ?? null,
              chars: inputs.at(-1)?.text.length ?? null,
            },
      ),
    ),
  );
}

async function uploadText(
  client: SupabaseClient,
  objectPath: string,
  text: string,
  contentType: string,
) {
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(objectPath, text, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`Supabase 업로드 실패 (${objectPath}): ${error.message}`);
  return Buffer.byteLength(text);
}

async function maybeDownloadJson<T>(client: SupabaseClient, objectPath: string): Promise<T | null> {
  try {
    return await downloadJson<T>(client, objectPath);
  } catch (error) {
    if (error instanceof Error && /Object not found|not_found|404/i.test(error.message))
      return null;
    throw error;
  }
}

async function maybeDownloadCachePointer<T>(
  client: SupabaseClient,
  objectPath: string,
): Promise<T | null> {
  // The pointer is stored gzip-encoded, with the plain object as the pre-migration fallback.
  return downloadCachePointer<T>(client, objectPath);
}

export function canonicalMergedCsv(inputs: LoadedSourceInput[]) {
  // Inputs are already validated canonical CSV. Keep one encoded line per key,
  // rather than reconstructing 102-property objects for the entire history.
  const rows = new Map<string, string>();
  const cell = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  for (const input of inputs) {
    visitDelimitedRows(input.text, (values, index) => {
      if (index === 0) {
        if (values.join(",") !== CANONICAL_SOURCE_COLUMNS.join(","))
          throw new Error("Expected validated canonical source columns");
        return;
      }
      rows.set(`${values[0]}\u0000${values[4]}`, values.map(cell).join(","));
    });
  }
  return `${[CANONICAL_SOURCE_COLUMNS.join(","), ...rows.values()].join("\n")}\n`;
}

export interface WebScreeningCacheInput {
  engineIdentity: ScreeningEngineIdentity;
  client: SupabaseClient;
  userId: string;
  inputs: LoadedSourceInput[];
  config: ScoringConfig;
  analysis: AnalysisResult;
  snapshot: ScreeningSnapshot;
  previous: ScreeningSnapshot | null;
  resultOnly?: DriveResultPublication;
  generationId?: string;
}

/** Read/validate only. Must finish before ANY publication object is mutated. */
export async function preflightWebScreeningCaches(input: WebScreeningCacheInput) {
  const fingerprint = inputFingerprint(
    input.inputs,
    input.config,
    savedOperationalIdentity(input.analysis),
  );
  const digest = resultDigest(input.analysis);
  const screeningPath = `${input.userId}/cache/screening/latest.json`;
  const existing = await maybeDownloadCachePointer<ExistingScreeningCache>(
    input.client,
    screeningPath,
  );
  if (!input.resultOnly) {
    const driveHead = await maybeDownloadJson<{ version?: string }>(
      input.client,
      `${input.userId}/results/drive-screening/input-head/latest.json`,
    );
    if (driveHead?.version === "drive-input-head-v1")
      throw new Error(
        "Drive 추가 이력이 있는 운영입니다. 등록 원천만으로 덮어쓰지 말고 v1.1에서 게시해 주세요.",
      );
  }
  if (
    existing?.payload?.analysis &&
    (existing.payload.analysis.asOfDate > input.analysis.asOfDate ||
      (existing.payload.analysis.asOfDate === input.analysis.asOfDate &&
        krResultPhase(existing.payload.analysis) === "FINAL" &&
        krResultPhase(input.analysis) === "PRELIMINARY"))
  )
    throw new Error("최신 또는 확정 홈페이지 결과를 과거·잠정 결과로 덮어쓸 수 없습니다.");
  if (
    existing?.version === SCREENING_CACHE_VERSION &&
    (!existing.payload?.analysis ||
      resultDigest(existing.payload.analysis) !== existing.resultDigest)
  )
    throw new Error("Existing screening cache content does not match its result digest");
  assertScreeningResultTransition(
    existing ? { ...existing, asOfDate: existing.payload?.analysis?.asOfDate } : null,
    {
      version: SCREENING_CACHE_VERSION,
      inputFingerprint: fingerprint,
      resultDigest: digest,
      engineIdentity: input.engineIdentity,
      asOfDate: input.analysis.asOfDate,
    },
  );
  return () => writeWebScreeningCaches(input, fingerprint, digest, existing);
}

export async function persistWebScreeningCaches(input: WebScreeningCacheInput) {
  const publish = await preflightWebScreeningCaches(input);
  return publish();
}

async function writeWebScreeningCaches(
  input: WebScreeningCacheInput,
  fingerprint: string,
  digest: string,
  existing: ExistingScreeningCache | null,
) {
  const screeningPath = `${input.userId}/cache/screening/latest.json`;
  // Storage keeps the gzip-encoded body; receipts report the object that actually exists.
  const storedScreeningPath = compressedCacheObjectPath(screeningPath);

  if (input.analysis.krPublication?.phase === "PRELIMINARY")
    await preserveConfirmedEtfContext(input.client, input.userId, existing);

  const source = {
    live: true,
    credentialsConfigured: true,
    fallbackReason: null,
    ...(input.resultOnly ? { drivePublication: input.resultOnly } : {}),
  };
  const payload: AnalysisPayload = { analysis: input.analysis, source };
  const publicationId = input.generationId ?? crypto.randomUUID();
  const screening = {
    version: SCREENING_CACHE_VERSION,
    engineIdentity: input.engineIdentity,
    publicationId,
    createdAt: new Date().toISOString(),
    inputFingerprint: fingerprint,
    resultDigest: digest,
    payload,
  };
  const dashboard = buildDashboardSummary(input.analysis, fingerprint, digest);
  dashboard.engineIdentity = input.engineIdentity;
  if (input.resultOnly) {
    dashboard.drivePublication = input.resultOnly;
    dashboard.publicationId = publicationId;
  }
  if (input.snapshot.sourceRegisteredAt)
    dashboard.sourceRegisteredAt = input.snapshot.sourceRegisteredAt;
  memory("dashboard-built", dashboard.counts);
  memory("raw-cache-merge-start");
  const canonicalCsv = input.resultOnly ? "" : canonicalMergedCsv(input.inputs);
  memory("raw-cache-merge-end");
  const rawPath = `${input.userId}/raw/screening/latest.csv`;
  const rawCacheBytes = Buffer.byteLength(canonicalCsv);
  const shouldUploadRawCache = !input.resultOnly && rawCacheBytes <= MAX_RAW_CACHE_BYTES;
  const dashboardPath = `${input.userId}/cache/dashboard/latest.json`;
  const latestInput = input.inputs.at(-1);
  const meta = {
    text: "",
    meta: {
      savedAt: latestInput?.savedAt ?? new Date().toISOString(),
      fileName: latestInput?.fileName ?? null,
      chars: canonicalCsv.length,
      rawPath: shouldUploadRawCache ? rawPath : null,
      dataHash: latestInput?.dataHash ?? null,
      schemaHash: latestInput?.schemaHash ?? null,
      normalizedBytes: rawCacheBytes,
    },
  };

  const [rawBytes, screeningUpload, dashboardUpload, metaUpload] = await Promise.all([
    shouldUploadRawCache
      ? uploadText(input.client, rawPath, canonicalCsv, "text/csv")
      : Promise.resolve(0),
    // The two pointers are stored gzip-encoded; everything else keeps its plain body.
    uploadCachePointer(input.client, screeningPath, screening).then((body) => ({ body })),
    uploadCachePointer(input.client, dashboardPath, dashboard).then((body) => ({ body })),
    input.resultOnly
      ? Promise.resolve({ body: "" })
      : uploadJson(input.client, `${input.userId}/kr.json`, meta),
  ]);

  memory("cache-uploads-end");
  const roundTrip = await downloadCachePointer<ExistingScreeningCache>(input.client, screeningPath);
  if (!roundTrip) throw new Error("스크리닝 cache 저장 후 재읽기에 실패했습니다.");
  const roundTripDigest = roundTrip.payload?.analysis
    ? resultDigest(roundTrip.payload.analysis)
    : null;
  memory("cache-roundtrip-end");
  if (
    roundTrip.resultDigest !== digest ||
    roundTripDigest !== digest ||
    roundTrip.publicationId !== publicationId ||
    roundTrip.inputFingerprint !== fingerprint ||
    stableCacheJson(roundTrip.engineIdentity) !== stableCacheJson(input.engineIdentity)
  ) {
    throw new Error(
      `스크리닝 cache 저장 후 digest 검증 실패: stored=${roundTrip.resultDigest ?? "null"}, recalculated=${roundTripDigest ?? "null"}, expected=${digest}`,
    );
  }

  return {
    publicationId,
    engineIdentity: input.engineIdentity,
    inputFingerprint: fingerprint,
    resultDigest: digest,
    regressionBaseline: existing?.resultDigest ?? null,
    regressionMatched: !existing?.resultDigest || existing.resultDigest === digest,
    roundTripVerified: true,
    paths: {
      rawPath: shouldUploadRawCache ? rawPath : null,
      screeningPath: storedScreeningPath,
      dashboardPath: compressedCacheObjectPath(dashboardPath),
      krPath: input.resultOnly ? null : `${input.userId}/kr.json`,
    },
    bytes: {
      raw: rawBytes,
      screening: Buffer.byteLength(screeningUpload.body),
      dashboard: Buffer.byteLength(dashboardUpload.body),
      kr: Buffer.byteLength(metaUpload.body),
    },
  };
}
