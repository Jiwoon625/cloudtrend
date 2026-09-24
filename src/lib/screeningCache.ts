import { type InstrumentChartRange } from "@/lib/engine/instrumentChart";
import {
  supabase,
  userId,
  ownerPath,
  readBinaryObject,
  readObject,
  writeBinaryObject,
  writeObject,
} from "@/lib/cloud";
import { chartSeries, scoreHistory, type AnalysisResult } from "@/lib/engine/pipeline";
import { historicalSectorDataset } from "@/lib/engine/historicalInstrumentScore";
import { getActiveScoringConfig } from "@/lib/scoringConfigStore";
import { ensureManualDataset, getManualDataMeta } from "@/lib/manualDataStore";
import { computeLocalAnalysis } from "@/lib/localAnalysis";
import type { AnalysisPayload, InstrumentDetailPayload } from "@/lib/market.functions";
import { buildSnapshot, hydrateSnapshots, saveSnapshot } from "@/lib/screeningHistory";
import { listRegisteredSources } from "@/lib/sourceRegistry";
import {
  buildDashboardSummary,
  DASHBOARD_CACHE_VERSION,
  deterministicAnalysis,
  INSTRUMENT_CACHE_VERSION,
  SCREENING_CACHE_VERSION,
  stableCacheJson,
  type DashboardSummary,
} from "@/lib/screeningCacheContract";

export { DASHBOARD_CACHE_VERSION, INSTRUMENT_CACHE_VERSION, SCREENING_CACHE_VERSION };
export type { DashboardSummary };

interface CacheMeta {
  version: string;
  createdAt: string;
  inputFingerprint: string;
  resultDigest: string;
}

export interface ScreeningCachePayload extends CacheMeta {
  version: typeof SCREENING_CACHE_VERSION;
  payload: AnalysisPayload;
}

interface InstrumentCachePayload extends CacheMeta {
  version: typeof INSTRUMENT_CACHE_VERSION;
  symbol: string;
  detail: InstrumentDetailPayload;
}

async function sha256Text(text: string) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function analysisDigest(analysis: AnalysisResult) {
  return sha256Text(stableCacheJson(deterministicAnalysis(analysis)));
}

async function currentInputFingerprint() {
  const [sources, config] = await Promise.all([
    listRegisteredSources("screening", ["active"]),
    Promise.resolve(getActiveScoringConfig()),
  ]);
  const meta = getManualDataMeta();
  return sha256Text(
    stableCacheJson({
      version: SCREENING_CACHE_VERSION,
      strategyConfig: config,
      sources: sources
        .map((source) => ({
          id: source.id,
          dataHash: source.data_hash,
          schemaHash: source.schema_hash,
          activatedAt: source.activated_at,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      legacyFallback: sources.length
        ? null
        : {
            dataHash: meta?.dataHash ?? null,
            schemaHash: meta?.schemaHash ?? null,
            savedAt: meta?.savedAt ?? null,
            chars: meta?.chars ?? null,
          },
    }),
  );
}

async function screeningPath() {
  return ownerPath("cache/screening/latest.json");
}
async function dashboardPath() {
  return ownerPath("cache/dashboard/latest.json");
}
async function instrumentPath(symbol: string) {
  return ownerPath(`cache/instruments/${symbol.toUpperCase()}.json.gz`);
}

async function gzipJson(value: unknown): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined")
    throw new Error("이 브라우저는 gzip 캐시 생성을 지원하지 않습니다.");
  const stream = new Blob([JSON.stringify(value)], { type: "application/json" })
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipJson<T>(bytes: Uint8Array): Promise<T> {
  if (typeof DecompressionStream === "undefined")
    throw new Error("이 브라우저는 gzip 캐시 해제를 지원하지 않습니다.");
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as T;
}

export async function readScreeningCache(): Promise<ScreeningCachePayload | null> {
  const cached = await readObject<ScreeningCachePayload>(await screeningPath());
  if (!cached || cached.version !== SCREENING_CACHE_VERSION) return null;
  const expectedInput = await currentInputFingerprint();
  if (cached.inputFingerprint !== expectedInput) return null;
  const digest = await analysisDigest(cached.payload.analysis);
  return digest === cached.resultDigest ? cached : null;
}

export async function readDashboardCache(): Promise<DashboardSummary | null> {
  const path = await dashboardPath();
  const cached = await readObject<DashboardSummary>(path);
  if (cached?.version === DASHBOARD_CACHE_VERSION) {
    const expectedInput = await currentInputFingerprint();
    if (cached.inputFingerprint === expectedInput) return cached;
  }

  // The dashboard is only a projection. A missing/stale summary must not trigger
  // another engine run when the shared screening result is already valid.
  // readScreeningCache checks version, active inputs and the full result digest.
  const screening = await readScreeningCache();
  if (!screening) return null;
  const recovered = buildDashboardSummary(
    screening.payload.analysis,
    screening.inputFingerprint,
    screening.resultDigest,
    screening.createdAt,
  );
  // Rendering must not depend on the repair upload (or a CDN read-after-write).
  void writeObject(path, recovered).catch((error: unknown) => {
    console.warn("대시보드 요약 캐시 복원 저장 실패", error);
  });
  return recovered;
}

export async function buildAndPersistScreeningCaches(): Promise<{
  screening: ScreeningCachePayload;
  dashboard: DashboardSummary;
}> {
  await ensureManualDataset();
  const inputFingerprint = await currentInputFingerprint();
  const previous = await readObject<ScreeningCachePayload>(await screeningPath());
  const payload = computeLocalAnalysis();
  if (!("analysis" in payload) || payload.analysis === null)
    throw new Error("스크리닝 분석 결과를 만들지 못했습니다.");
  const resultDigest = await analysisDigest(payload.analysis);
  if (
    previous?.version === SCREENING_CACHE_VERSION &&
    previous.inputFingerprint === inputFingerprint &&
    previous.resultDigest !== resultDigest
  )
    throw new Error(
      `스크리닝 regression guard 실패: 동일 원천·동일 산식인데 결과가 달라졌습니다. expected=${previous.resultDigest}, actual=${resultDigest}`,
    );

  const screening: ScreeningCachePayload = {
    version: SCREENING_CACHE_VERSION,
    createdAt: new Date().toISOString(),
    inputFingerprint,
    resultDigest,
    payload,
  };
  try {
    await hydrateSnapshots();
    await saveSnapshot(buildSnapshot(payload.analysis));
  } catch {
    // 이력 저장 실패가 V8 스크리닝 결과 생성을 막지 않게 한다.
  }
  const dashboard = buildDashboardSummary(payload.analysis, inputFingerprint, resultDigest);
  await Promise.all([
    writeObject(await screeningPath(), screening),
    writeObject(await dashboardPath(), dashboard),
  ]);
  const roundTrip = await readObject<ScreeningCachePayload>(await screeningPath());
  if (!roundTrip || (await analysisDigest(roundTrip.payload.analysis)) !== resultDigest)
    throw new Error("스크리닝 cache 저장 후 digest 검증에 실패했습니다.");
  return { screening, dashboard };
}

export async function getOrBuildScreeningPayload(): Promise<AnalysisPayload> {
  const cached = await readScreeningCache();
  if (cached) return cached.payload;
  return (await buildAndPersistScreeningCaches()).screening.payload;
}

export async function getOrBuildDashboardSummary(): Promise<DashboardSummary> {
  const cached = await readDashboardCache();
  if (cached) return cached;
  return (await buildAndPersistScreeningCaches()).dashboard;
}

export async function getCachedInstrumentDetail(symbol: string): Promise<InstrumentDetailPayload> {
  const normalized = symbol.trim().toUpperCase();
  const screening = await readScreeningCache();
  const shared = screening ?? (await buildAndPersistScreeningCaches()).screening;
  const row =
    shared.payload.analysis.rows.find((item) => item.instrument.symbol === normalized) ?? null;
  if (!row)
    return {
      source: shared.payload.source,
      asOfDate: shared.payload.analysis.asOfDate,
      dataProvider: shared.payload.analysis.dataProvider,
      dataVersion: shared.payload.analysis.dataVersion,
      strategyVersion: shared.payload.analysis.strategyVersion,
      notes: shared.payload.analysis.notes,
      isLive: shared.payload.analysis.isLive,
      marketGateStatus: shared.payload.analysis.marketGate.status,
      row: null,
      chart: [],
      history: [],
    };

  const path = await instrumentPath(normalized);
  const compressed = await readBinaryObject(path);
  if (compressed) {
    try {
      const cached = await gunzipJson<InstrumentCachePayload>(compressed);
      if (
        cached.version === INSTRUMENT_CACHE_VERSION &&
        cached.inputFingerprint === shared.inputFingerprint &&
        cached.resultDigest === shared.resultDigest &&
        cached.symbol === normalized
      )
        return cached.detail;
    } catch {
      // 손상/구버전 cache는 아래에서 재생성한다.
    }
  }

  const parsed = await ensureManualDataset();
  if (!parsed) throw new Error("종목 상세 차트를 만들 원천 시세가 없습니다.");
  const targetDataset = historicalSectorDataset(parsed.dataset);
  const config = getActiveScoringConfig();
  const analysis = shared.payload.analysis;
  const detail: InstrumentDetailPayload = {
    source: shared.payload.source,
    asOfDate: analysis.asOfDate,
    dataProvider: analysis.dataProvider,
    dataVersion: analysis.dataVersion,
    strategyVersion: analysis.strategyVersion,
    notes: analysis.notes,
    isLive: analysis.isLive,
    marketGateStatus: analysis.marketGate.status,
    row,
    chart: chartSeries(targetDataset, normalized, Infinity, config),
    history: scoreHistory(targetDataset, normalized, 60, config),
  };
  const cache: InstrumentCachePayload = {
    version: INSTRUMENT_CACHE_VERSION,
    createdAt: new Date().toISOString(),
    inputFingerprint: shared.inputFingerprint,
    resultDigest: shared.resultDigest,
    symbol: normalized,
    detail,
  };
  await writeBinaryObject(path, await gzipJson(cache));
  return detail;
}

export { FAST_CHART_VERSION as INSTRUMENT_CHART_VERSION } from "./instrumentChartContract";
import { chartPath, assertChartMatchesCard, type ChartKind } from "./instrumentChartContract";
import type { PreparedChart, PriceChart } from "./instrumentChartStore.server";
// Share metadata work between price and score requests, without sharing across users/settings.
const identities = new WeakMap<
  AnalysisPayload,
  Map<string, Promise<{ inputFingerprint: string; resultDigest: string }>>
>();
async function chartIdentity(payload: AnalysisPayload) {
  const uid = await userId(),
    key = uid + stableCacheJson(getActiveScoringConfig());
  let values = identities.get(payload);
  if (!values) {
    values = new Map();
    identities.set(payload, values);
  }
  let pending = values.get(key);
  if (!pending) {
    pending = Promise.all([currentInputFingerprint(), analysisDigest(payload.analysis)]).then(
      ([inputFingerprint, resultDigest]) => ({ inputFingerprint, resultDigest }),
    );
    values.set(key, pending);
    pending.catch(() => values!.delete(key));
  }
  return pending;
}
async function fastChart(
  symbol: string,
  range: InstrumentChartRange,
  payload: AnalysisPayload,
  kind: ChartKind,
) {
  const normalized = symbol.trim().toUpperCase(),
    identity = await chartIdentity(payload);
  const path = await ownerPath(chartPath(identity, normalized, range, kind));
  let data: PreparedChart | PriceChart | undefined;
  try {
    const bytes = await readBinaryObject(path);
    if (bytes)
      data = (await gunzipJson<Record<string, PreparedChart | PriceChart>>(bytes))[normalized];
  } catch (error) {
    console.warn("차트 캐시 읽기 실패: 서버에서 재시도합니다.", error);
  }
  if (!data) {
    const { data: session, error } = await supabase.auth.getSession();
    if (error || !session.session) throw new Error("로그인이 필요합니다.");
    const { getInstrumentChartServer } = await import("./instrumentCharts.functions");
    data = await getInstrumentChartServer({
      data: {
        ...identity,
        accessToken: session.session.access_token,
        config: getActiveScoringConfig(),
        symbol: normalized,
        range,
        kind,
      },
    });
  }
  if (kind === "scored")
    assertChartMatchesCard((data as PreparedChart).chart, payload.analysis, normalized);
  return data;
}
export async function getCachedInstrumentChart(
  symbol: string,
  range: InstrumentChartRange,
  payload: AnalysisPayload,
): Promise<PreparedChart> {
  return (await fastChart(symbol, range, payload, "scored")) as PreparedChart;
}
export async function getCachedInstrumentPrices(
  symbol: string,
  range: InstrumentChartRange,
  payload: AnalysisPayload,
): Promise<PriceChart> {
  return (await fastChart(symbol, range, payload, "prices")) as PriceChart;
}
