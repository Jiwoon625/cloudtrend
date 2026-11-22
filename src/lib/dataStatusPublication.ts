import type { AnalysisResult } from "./engine/pipeline";
import { krResultPhase } from "./driveResultPublication";
import { dataStatusStrategyVersion } from "./dataStatusPresentation";
import type { DataStatusBarCoverage, DataStatusPayload } from "./marketPayload";

/**
 * 한국 데이터 상태는 이제 Drive v7 게시본이 기준이다.
 *
 * 예전 서버 경로는 Supabase `analysis_source_files`의 활성 CSV 전체(수십 개, 수백 MB)를
 * 매번 내려받아 파싱했다. 그 원천은 Drive 전환 뒤 2026-11-05에 멈춰 있어서, 홈페이지
 * 스크리닝이 2026-11-13 FINAL을 게시해도 데이터 상태 화면만 구버전을 보여 주었다.
 *
 * 그래서 게시 실행기(계산 단계에서 데이터셋을 이미 들고 있는 곳)가 게시본과 같은 세대로
 * 묶인 요약(`kr-data-status-v1`)을 남기고, 서버는 그 요약만 읽는다. 요약이 현재 게시본과
 * 맞지 않거나 없으면 기존 CSV 경로로 내려간다(값을 추정해 채우지 않는다).
 */
export const KR_DATA_STATUS_VERSION = "kr-data-status-v1" as const;
export const KR_DATA_STATUS_POINTER_PATH = "cache/data-status/latest.json" as const;

export type KrDataStatusPhase = "PRELIMINARY" | "FINAL";

export interface KrDataStatusIdentity {
  publicationId: string;
  resultDigest: string;
  asOfDate: string;
  phase: KrDataStatusPhase;
}

export interface KrDataStatusPointer extends KrDataStatusIdentity {
  version: typeof KR_DATA_STATUS_VERSION;
  /** 저장된 요약 객체 경로. 게시 세대마다 새 객체를 가리킨다. */
  path: string;
}

export interface KrDataStatusArtifact extends KrDataStatusIdentity {
  version: typeof KR_DATA_STATUS_VERSION;
  computedAt: string;
  payload: DataStatusPayload;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const date = /^\d{4}-\d{2}-\d{2}$/;

export function krDataStatusPointerPath(owner: string) {
  return `${owner}/${KR_DATA_STATUS_POINTER_PATH}`;
}

/** 게시 세대별 불변 객체 이름. 같은 publicationId를 다시 게시하면 같은 자리를 덮어쓴다. */
export function krDataStatusObjectPath(owner: string, publicationId: string) {
  if (!uuid.test(publicationId)) throw new Error("데이터 상태 게시 세대가 올바르지 않습니다.");
  return `${owner}/cache/data-status/${publicationId}.json`;
}

export function krDataStatusIdentityOf(analysis: {
  asOfDate: string;
  krPublication?: AnalysisResult["krPublication"];
}): { asOfDate: string; phase: KrDataStatusPhase } {
  return { asOfDate: analysis.asOfDate, phase: krResultPhase(analysis) };
}

/**
 * 게시본과 같은 세대에 묶인 요약을 만든다. 게시 실행기는 계산 단계에서 만든
 * `payload`를 그대로 넘기고, 여기서는 어떤 게시본의 값인지만 못박는다.
 */
export function buildKrDataStatusPublication(input: {
  owner: string;
  publicationId: string;
  resultDigest: string;
  analysis: AnalysisResult;
  payload: DataStatusPayload;
  computedAt?: string;
}): { pointer: KrDataStatusPointer; artifact: KrDataStatusArtifact } {
  const { asOfDate, phase } = krDataStatusIdentityOf(input.analysis);
  if (!date.test(asOfDate)) throw new Error("데이터 상태 기준일이 올바르지 않습니다.");
  if (!/^[0-9a-f]{8}-/i.test(input.publicationId))
    throw new Error("데이터 상태 게시 세대가 올바르지 않습니다.");
  if (!digest.test(input.resultDigest))
    throw new Error("데이터 상태 결과 지문이 올바르지 않습니다.");
  if (input.payload.asOfDate !== asOfDate)
    throw new Error("데이터 상태 요약의 기준일이 게시본과 다릅니다.");
  const computedAt = input.computedAt ?? new Date().toISOString();
  const identity: KrDataStatusIdentity = {
    publicationId: input.publicationId,
    resultDigest: input.resultDigest,
    asOfDate,
    phase,
  };
  const artifact: KrDataStatusArtifact = {
    version: KR_DATA_STATUS_VERSION,
    ...identity,
    computedAt,
    payload: { ...input.payload, evidence: publicationEvidence(identity, computedAt) },
  };
  return {
    pointer: {
      version: KR_DATA_STATUS_VERSION,
      ...identity,
      path: krDataStatusObjectPath(input.owner, input.publicationId),
    },
    artifact,
  };
}

export function publicationEvidence(
  identity: KrDataStatusIdentity,
  computedAt: string,
): NonNullable<DataStatusPayload["evidence"]> {
  return {
    version: "kr-data-status-evidence-v1",
    source: "DRIVE_PUBLICATION_DATA_STATUS",
    asOfDate: identity.asOfDate,
    phase: identity.phase,
    publicationId: identity.publicationId,
    computedAt,
  };
}

/**
 * 저장된 포인터와 요약이 지금 화면의 게시본과 같은 세대인지 확인한다.
 * 하나라도 맞지 않으면 null을 돌려주고 호출자는 fallback으로 내려간다.
 */
export function readKrDataStatusArtifact(
  pointer: unknown,
  artifact: unknown,
  expected: { asOfDate?: string; publicationId?: string } = {},
): DataStatusPayload | null {
  const identity = readIdentity(pointer);
  if (!identity) return null;
  const pointerPath = (pointer as { path?: unknown }).path;
  if (typeof pointerPath !== "string" || !pointerPath.endsWith(`/${identity.publicationId}.json`))
    return null;
  if (expected.asOfDate && expected.asOfDate !== identity.asOfDate) return null;
  if (expected.publicationId && expected.publicationId !== identity.publicationId) return null;
  if (!artifact || typeof artifact !== "object") return null;
  const stored = artifact as Partial<KrDataStatusArtifact>;
  if (stored.version !== KR_DATA_STATUS_VERSION) return null;
  if (
    stored.publicationId !== identity.publicationId ||
    stored.resultDigest !== identity.resultDigest ||
    stored.asOfDate !== identity.asOfDate ||
    stored.phase !== identity.phase
  )
    return null;
  const payload = stored.payload;
  if (!isDataStatusPayload(payload)) return null;
  if (payload.asOfDate !== identity.asOfDate) return null;
  if (payload.evidence && payload.evidence.publicationId !== identity.publicationId) return null;
  return payload;
}

function readIdentity(value: unknown): KrDataStatusIdentity | null {
  if (!value || typeof value !== "object") return null;
  const pointer = value as Partial<KrDataStatusPointer>;
  if (pointer.version !== KR_DATA_STATUS_VERSION) return null;
  if (typeof pointer.publicationId !== "string" || !uuid.test(pointer.publicationId)) return null;
  if (typeof pointer.resultDigest !== "string" || !digest.test(pointer.resultDigest)) return null;
  if (typeof pointer.asOfDate !== "string" || !date.test(pointer.asOfDate)) return null;
  if (pointer.phase !== "PRELIMINARY" && pointer.phase !== "FINAL") return null;
  return {
    publicationId: pointer.publicationId,
    resultDigest: pointer.resultDigest,
    asOfDate: pointer.asOfDate,
    phase: pointer.phase,
  };
}

function isDataStatusPayload(value: unknown): value is DataStatusPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<DataStatusPayload>;
  if (typeof payload.asOfDate !== "string" || !date.test(payload.asOfDate)) return false;
  if (typeof payload.dataProvider !== "string" || typeof payload.dataVersion !== "string")
    return false;
  if (typeof payload.strategyVersion !== "string" || typeof payload.isLive !== "boolean")
    return false;
  if (!Array.isArray(payload.notes) || !payload.notes.every((note) => typeof note === "string"))
    return false;
  if (!Array.isArray(payload.coverage)) return false;
  if (!payload.capabilities || typeof payload.capabilities !== "object") return false;
  if (payload.checks !== undefined && !isChecks(payload.checks)) return false;
  if (payload.barCoverage !== undefined && !isBarCoverage(payload.barCoverage)) return false;
  return true;
}

function isChecks(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const checks = value as Record<string, unknown>;
  return [
    "ohlcErrors",
    "negativeVolume",
    "duplicates",
    "futureDates",
    "insufficient",
    "abnormalMoves",
  ]
    .map((key) => checks[key])
    .every((count) => Number.isSafeInteger(count) && (count as number) >= 0);
}

function isBarCoverage(value: unknown): value is DataStatusBarCoverage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        !!row &&
        typeof row === "object" &&
        typeof row.symbol === "string" &&
        typeof row.name === "string" &&
        Number.isSafeInteger(row.bars) &&
        typeof row.first === "string" &&
        typeof row.last === "string",
    )
  );
}

/**
 * 게시본은 있는데 게시 시점 요약이 아직 없는 경우(이 변경 이전에 게시된 세대)에 쓰는 축약본.
 *
 * 게시 결과에서 실제로 확인할 수 있는 값만 담고, 종목별 봉 수·자동 검증처럼 데이터셋이
 * 있어야 하는 항목은 `evidence.unavailable`로 밝힌다. 0으로 채우지 않는다.
 */
export function deriveDataStatusFromPublishedAnalysis(
  analysis: AnalysisResult,
  options: { source?: NonNullable<DataStatusPayload["evidence"]>["source"] } = {},
): DataStatusPayload {
  const asOfDate = analysis.asOfDate;
  const rows = Array.isArray(analysis.rows) ? analysis.rows : [];
  const currentRows = rows.filter((row) => row.snapshot?.tradeDate === asOfDate);
  const marketCapRows = currentRows.filter(
    (row) => row.marketCap != null && Number.isFinite(row.marketCap) && row.marketCap > 0,
  ).length;
  const stockCount = rows.filter((row) => row.instrument.instrumentType === "STOCK").length;
  return {
    source: {
      live: analysis.isLive,
      credentialsConfigured: true,
      fallbackReason: null,
    },
    asOfDate,
    dataProvider: analysis.dataProvider,
    dataVersion: analysis.dataVersion,
    strategyVersion: analysis.strategyVersion,
    isLive: analysis.isLive,
    capabilities: analysis.capabilities,
    notes: [
      ...analysis.notes,
      "이 게시본의 종목별 일봉 구간과 자동 검증 결과는 게시 원천에서 계산된 요약으로만 제공합니다. 다음 게시 실행부터 이 화면에 표시됩니다.",
    ],
    coverage: [
      {
        provider: analysis.dataProvider,
        kind: "종목 일봉(기준일)",
        count: currentRows.length,
        availableEntities: currentRows.length,
        asOfDate,
        entities: rows.length,
        ok: currentRows.length > 0,
      },
      {
        provider: analysis.dataProvider,
        kind: "시가총액",
        count: marketCapRows,
        availableEntities: marketCapRows,
        asOfDate,
        entities: rows.length,
        ok: marketCapRows === rows.length && marketCapRows > 0,
      },
    ],
    evidence: {
      version: "kr-data-status-evidence-v1",
      source: options.source ?? "PUBLISHED_ANALYSIS",
      asOfDate,
      phase: krResultPhase(analysis),
      unavailable: [
        "checks",
        "barCoverage",
        "priceRecordCoverage",
        "investorFlowCoverage",
        "volatilityObservation",
      ],
    },
  };
}

/** 전략 버전 표기는 게시본과 같은 함수로 만든다(두 화면의 표기가 갈라지지 않게). */
export const publishedStrategyVersion = dataStatusStrategyVersion;

/** 활성 CSV 원천의 마지막 기준일. Drive 게시본보다 최신이면 CSV 결과가 기준이다. */
export function latestSourceDate(sources: readonly { max_date?: string | null }[]): string | null {
  let latest: string | null = null;
  for (const source of sources) {
    const maxDate = source.max_date;
    if (typeof maxDate !== "string" || !date.test(maxDate)) continue;
    if (!latest || maxDate > latest) latest = maxDate;
  }
  return latest;
}

/** 게시본이 원천 CSV보다 오래됐거나 같을 때만 CSV 결과를 쓴다. */
export function publishedDataStatusIsCurrent(
  publishedAsOfDate: string,
  legacyLatestDate: string | null,
) {
  if (!date.test(publishedAsOfDate)) return false;
  if (!legacyLatestDate) return true;
  return publishedAsOfDate >= legacyLatestDate;
}
