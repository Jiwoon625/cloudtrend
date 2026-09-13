import type { SupabaseClient } from "@supabase/supabase-js";

import { compactDashboardRow } from "../src/lib/dashboardRow";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import type { ScoringConfig } from "../src/lib/engine/scoring";
import type { ScreeningSnapshot } from "../src/lib/screeningSnapshot";
import { sourceRowKey, toCanonicalCsv } from "../src/lib/sourceData";
import type { AnalysisPayload } from "../src/lib/market.functions";
import {
  ANALYSIS_BUCKET,
  downloadJson,
  sha256,
  stableJson,
  uploadJson,
} from "./analysis-run-store";
import type { LoadedSourceInput } from "./source-registry-store";

const SCREENING_CACHE_VERSION = "screening-cache-v1";
const DASHBOARD_CACHE_VERSION = "dashboard-cache-v1";
const MAX_RAW_CACHE_BYTES = 45 * 1024 * 1024;

interface ExistingScreeningCache {
  version?: string;
  inputFingerprint?: string;
  resultDigest?: string;
  payload?: AnalysisPayload;
}

function deterministicAnalysis(analysis: AnalysisResult) {
  return { ...analysis, calculatedAt: "" };
}

function resultDigest(analysis: AnalysisResult) {
  return sha256(stableJson(deterministicAnalysis(analysis)));
}

function inputFingerprint(inputs: LoadedSourceInput[], config: ScoringConfig) {
  const sources = inputs
    .filter((input) => input.sourceRecord)
    .map((input) => ({
      id: input.sourceRecord!.id,
      dataHash: input.sourceRecord!.data_hash,
      schemaHash: input.sourceRecord!.schema_hash,
      activatedAt: input.sourceRecord!.activated_at,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256(
    stableJson({
      version: SCREENING_CACHE_VERSION,
      strategyConfig: config,
      sources,
      legacyFallback: sources.length
        ? null
        : {
            dataHash: inputs.at(-1)?.dataHash ?? null,
            schemaHash: inputs.at(-1)?.schemaHash ?? null,
            savedAt: inputs.at(-1)?.savedAt ?? null,
            chars: inputs.at(-1)?.text.length ?? null,
          },
    }),
  );
}

function strongSectors(analysis: AnalysisResult) {
  const rot = analysis.sectorRotation?.sectors ?? [];
  if (rot.length) {
    return [...rot]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 5)
      .map((s) => ({
        sectorCode: s.sectorCode,
        sectorName: s.sectorName,
        rank: s.rank,
        prevRank: s.prevRank,
        rs20: s.rs20,
        score: s.rotationScore,
      }));
  }
  return analysis.sectors.slice(0, 5).map((s) => ({
    sectorCode: s.sectorCode,
    sectorName: s.sectorName,
    rank: s.rank,
    prevRank: s.prevRank,
    rs20: s.rs20,
    score: s.score,
  }));
}

function snapshotDiff(current: ScreeningSnapshot, previous: ScreeningSnapshot | null) {
  if (!previous) return { previousDate: null, newGradeA: null, droppedAtoB: null };
  const prevMap = new Map(previous.entries.map((entry) => [entry.symbol, entry]));
  return {
    previousDate: previous.date,
    newGradeA: current.entries.filter(
      (entry) => entry.grade === "A" && prevMap.get(entry.symbol)?.grade !== "A",
    ).length,
    droppedAtoB: current.entries.filter(
      (entry) => prevMap.get(entry.symbol)?.grade === "A" && entry.grade === "B",
    ).length,
  };
}

function buildDashboardSummary(
  analysis: AnalysisResult,
  fingerprint: string,
  digest: string,
  snapshot: ScreeningSnapshot,
  previous: ScreeningSnapshot | null,
) {
  const rows = analysis.rows;
  const passed = rows.filter((row) => row.hardFilterPassed);
  const onsetTop = [...passed]
    .filter((row) => row.actionLabelText === "진입후보" || row.actionLabelText === "우선진입후보")
    .sort((a, b) => b.totalScoreNormalized - a.totalScoreNormalized)
    .slice(0, 10);
  const momentumRiskRows = [...rows]
    .filter((row) => row.actionLabelText === "모멘텀 위험")
    .sort((a, b) => b.totalScoreNormalized - a.totalScoreNormalized);
  const top = [...passed]
    .sort((a, b) => b.totalScoreNormalized - a.totalScoreNormalized)
    .slice(0, 10);
  const warningCodes = ["HEAD_FAKE", "PRICE_INSIDE_CLOUD", "EXIT_TRIGGER", "LOW_LIQUIDITY"] as const;
  const warningBuckets = warningCodes.map((code) => {
    const matches = code === "LOW_LIQUIDITY"
      ? rows.filter((row) => !row.hardFilterPassed)
      : rows.filter((row) => row.warnings.includes(code));
    return { code, count: matches.length, rows: matches.slice(0, 4).map(compactDashboardRow) };
  });
  const failMap = new Map<string, number>();
  for (const row of rows) {
    if (row.hardFilterPassed) continue;
    for (const reason of row.failedRules) failMap.set(reason, (failMap.get(reason) ?? 0) + 1);
  }
  const diff = snapshotDiff(snapshot, previous);
  return {
    version: DASHBOARD_CACHE_VERSION,
    createdAt: new Date().toISOString(),
    inputFingerprint: fingerprint,
    resultDigest: digest,
    asOfDate: analysis.asOfDate,
    strategyVersion: analysis.strategyVersion,
    dataVersion: analysis.dataVersion,
    calculatedAt: analysis.calculatedAt,
    marketGate: analysis.marketGate,
    kospi: analysis.kospi,
    kosdaq: analysis.kosdaq,
    vkospi: analysis.vkospi,
    marketForeignNet5d: analysis.marketForeignNet5d,
    strongSectors: strongSectors(analysis),
    counts: {
      total: rows.length,
      passed: passed.length,
      disqualified: rows.length - passed.length,
      entryOnsets: onsetTop.filter((row) => row.actionLabelText === "진입후보").length,
      priorityOnsets: onsetTop.filter((row) => row.actionLabelText === "우선진입후보").length,
      momentumRisk: momentumRiskRows.length,
      gradeA: passed.filter((row) => row.grade === "A").length,
      gradeB: passed.filter((row) => row.grade === "B").length,
      incomplete: rows.filter((row) => row.dataCompletenessRatio < 0.7).length,
      newGradeA: diff.newGradeA,
      droppedAtoB: diff.droppedAtoB,
      previousDate: diff.previousDate,
    },
    warningBuckets,
    failReasons: [...failMap.entries()].sort((a, b) => b[1] - a[1]),
    onsetTop: onsetTop.map(compactDashboardRow),
    momentumRiskRows: momentumRiskRows.map(compactDashboardRow),
    top: top.map(compactDashboardRow),
  };
}

async function uploadText(client: SupabaseClient, objectPath: string, text: string, contentType: string) {
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
    if (error instanceof Error && /Object not found|not_found|404/i.test(error.message)) return null;
    throw error;
  }
}

function canonicalMergedCsv(inputs: LoadedSourceInput[]) {
  const rows = new Map<string, LoadedSourceInput["validation"]["rows"][number]>();
  for (const input of inputs) {
    for (const row of input.validation.rows) rows.set(sourceRowKey(row), row);
  }
  return toCanonicalCsv([...rows.values()]);
}

export async function persistWebScreeningCaches(input: {
  client: SupabaseClient;
  userId: string;
  inputs: LoadedSourceInput[];
  config: ScoringConfig;
  analysis: AnalysisResult;
  snapshot: ScreeningSnapshot;
  previous: ScreeningSnapshot | null;
}) {
  const fingerprint = inputFingerprint(input.inputs, input.config);
  const digest = resultDigest(input.analysis);
  const screeningPath = `${input.userId}/cache/screening/latest.json`;
  const existing = await maybeDownloadJson<ExistingScreeningCache>(input.client, screeningPath);
  if (
    existing?.version === SCREENING_CACHE_VERSION &&
    existing.inputFingerprint === fingerprint &&
    existing.resultDigest &&
    existing.resultDigest !== digest
  ) {
    throw new Error(
      `스크리닝 regression guard 실패: 동일 원천·동일 산식인데 결과 digest가 변경되었습니다. expected=${existing.resultDigest}, actual=${digest}`,
    );
  }

  const source = { live: true, credentialsConfigured: true, fallbackReason: null };
  const payload: AnalysisPayload = { analysis: input.analysis, source };
  const screening = {
    version: SCREENING_CACHE_VERSION,
    createdAt: new Date().toISOString(),
    inputFingerprint: fingerprint,
    resultDigest: digest,
    payload,
  };
  const dashboard = buildDashboardSummary(
    input.analysis,
    fingerprint,
    digest,
    input.snapshot,
    input.previous,
  );
  const canonicalCsv = canonicalMergedCsv(input.inputs);
  const rawPath = `${input.userId}/raw/screening/latest.csv`;
  const rawCacheBytes = Buffer.byteLength(canonicalCsv);
  const shouldUploadRawCache = rawCacheBytes <= MAX_RAW_CACHE_BYTES;
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
    uploadJson(input.client, screeningPath, screening),
    uploadJson(input.client, dashboardPath, dashboard),
    uploadJson(input.client, `${input.userId}/kr.json`, meta),
  ]);

  const roundTrip = await downloadJson<ExistingScreeningCache>(input.client, screeningPath);
  const roundTripDigest = roundTrip.payload?.analysis ? resultDigest(roundTrip.payload.analysis) : null;
  if (roundTrip.resultDigest !== digest || roundTripDigest !== digest) {
    throw new Error(
      `스크리닝 cache 저장 후 digest 검증 실패: stored=${roundTrip.resultDigest ?? "null"}, recalculated=${roundTripDigest ?? "null"}, expected=${digest}`,
    );
  }

  return {
    inputFingerprint: fingerprint,
    resultDigest: digest,
    regressionBaseline: existing?.resultDigest ?? null,
    regressionMatched: !existing?.resultDigest || existing.resultDigest === digest,
    roundTripVerified: true,
    paths: { rawPath: shouldUploadRawCache ? rawPath : null, screeningPath, dashboardPath, krPath: `${input.userId}/kr.json` },
    bytes: {
      raw: rawBytes,
      screening: Buffer.byteLength(screeningUpload.body),
      dashboard: Buffer.byteLength(dashboardUpload.body),
      kr: Buffer.byteLength(metaUpload.body),
    },
  };
}
