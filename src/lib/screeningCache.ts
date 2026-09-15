import {
  ownerPath,
  readBinaryObject,
  readObject,
  writeBinaryObject,
  writeObject,
} from "@/lib/cloud";
import { compactDashboardRow } from "@/lib/dashboardRow";
import {
  chartSeries,
  scoreHistory,
  type AnalysisResult,
  type ScreeningRow,
} from "@/lib/engine/pipeline";
import { buildInstrumentDetailDataset } from "@/lib/engine/instrumentDetailDataset";
import { getActiveScoringConfig } from "@/lib/scoringConfigStore";
import {
  ensureManualDataText,
  ensureManualDataset,
  getManualDataMeta,
} from "@/lib/manualDataStore";
import { computeLocalAnalysis } from "@/lib/localAnalysis";
import type { AnalysisPayload, InstrumentDetailPayload } from "@/lib/market.functions";
import {
  buildSnapshot,
  hydrateSnapshots,
  saveSnapshot,
} from "@/lib/screeningHistory";
import { listRegisteredSources } from "@/lib/sourceRegistry";

export const SCREENING_CACHE_VERSION = "screening-cache-v8-final-v1" as const;
export const DASHBOARD_CACHE_VERSION = "dashboard-cache-v8-final-v1" as const;
export const INSTRUMENT_CACHE_VERSION = "instrument-cache-v8-final-v1" as const;

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

export interface DashboardSummary {
  version: typeof DASHBOARD_CACHE_VERSION;
  createdAt: string;
  inputFingerprint: string;
  resultDigest: string;
  asOfDate: string;
  strategyVersion: string;
  dataVersion: string;
  calculatedAt: string;
  marketGate: AnalysisResult["marketGate"];
  kospi: AnalysisResult["kospi"];
  kosdaq: AnalysisResult["kosdaq"];
  vkospi: number | null;
  marketForeignNet5d: number | null;
  rotationSectors: Array<{
    sectorCode: string;
    sectorName: string;
    rank: number;
    prevRank: number;
    rs20: number | null;
    score: number;
    priceLeadership: number | null;
    moneyFlow: number | null;
  }>;
  counts: {
    total: number;
    passed: number;
    disqualified: number;
    kosdaq80Onsets: number;
    upsideExits: number;
    downsideExits: number;
    incomplete: number;
  };
  failReasons: Array<[string, number]>;
  onsetRows: ScreeningRow[];
  exitRows: ScreeningRow[];
  top: ScreeningRow[];
}

interface InstrumentCachePayload extends CacheMeta {
  version: typeof INSTRUMENT_CACHE_VERSION;
  symbol: string;
  detail: InstrumentDetailPayload;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
    .join(",")}}`;
}

async function sha256Text(text: string) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function deterministicAnalysis(analysis: AnalysisResult) {
  return { ...analysis, calculatedAt: "" };
}

async function analysisDigest(analysis: AnalysisResult) {
  return sha256Text(stable(deterministicAnalysis(analysis)));
}

async function currentInputFingerprint() {
  const [sources, config] = await Promise.all([
    listRegisteredSources("screening", ["active"]),
    Promise.resolve(getActiveScoringConfig()),
  ]);
  const meta = getManualDataMeta();
  return sha256Text(
    stable({
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

function buildRotationSectors(analysis: AnalysisResult): DashboardSummary["rotationSectors"] {
  const rotation = analysis.sectorRotation?.sectors ?? [];
  if (rotation.length > 0)
    return [...rotation]
      .sort((a, b) => a.rank - b.rank)
      .map((sector) => ({
        sectorCode: sector.sectorCode,
        sectorName: sector.sectorName,
        rank: sector.rank,
        prevRank: sector.prevRank,
        rs20: sector.rs20,
        score: sector.rotationScore,
        priceLeadership: sector.priceLeadership.score,
        moneyFlow: sector.moneyFlow.score,
      }));
  return [...analysis.sectors]
    .sort((a, b) => a.rank - b.rank)
    .map((sector) => ({
      sectorCode: sector.sectorCode,
      sectorName: sector.sectorName,
      rank: sector.rank,
      prevRank: sector.prevRank,
      rs20: sector.rs20,
      score: sector.score,
      priceLeadership: null,
      moneyFlow: null,
    }));
}

function signalPriority(a: ScreeningRow, b: ScreeningRow) {
  const priority = b.priority.points - a.priority.points;
  if (priority !== 0) return priority;
  const rotation = (b.sectorRotationScore ?? -Infinity) - (a.sectorRotationScore ?? -Infinity);
  if (rotation !== 0) return rotation;
  return (b.operatingScore10 ?? -Infinity) - (a.operatingScore10 ?? -Infinity);
}

async function buildDashboardSummary(
  analysis: AnalysisResult,
  inputFingerprint: string,
  resultDigest: string,
): Promise<DashboardSummary> {
  const rows = analysis.rows;
  const passed = rows.filter((row) => row.hardFilterPassed);
  const onsetRows = [...rows]
    .filter((row) => row.kosdaq80Onset)
    .sort(signalPriority)
    .slice(0, 30);
  const exitRows = [...rows]
    .filter(
      (row) =>
        row.instrument.instrumentType === "STOCK" &&
        row.instrument.market === "KOSDAQ" &&
        row.exitSignal !== null,
    )
    .sort((a, b) => (b.operatingScore10 ?? -Infinity) - (a.operatingScore10 ?? -Infinity))
    .slice(0, 30);
  const top = [...passed]
    .filter((row) => row.instrument.instrumentType === "STOCK")
    .sort((a, b) => b.totalScoreNormalized - a.totalScoreNormalized)
    .slice(0, 10);

  const failMap = new Map<string, number>();
  for (const row of rows) {
    if (row.hardFilterPassed) continue;
    for (const reason of row.failedRules) failMap.set(reason, (failMap.get(reason) ?? 0) + 1);
  }

  try {
    await hydrateSnapshots();
    await saveSnapshot(buildSnapshot(analysis));
  } catch {
    // 이력 저장 실패가 V8 스크리닝 결과 생성을 막지 않게 한다.
  }

  return {
    version: DASHBOARD_CACHE_VERSION,
    createdAt: new Date().toISOString(),
    inputFingerprint,
    resultDigest,
    asOfDate: analysis.asOfDate,
    strategyVersion: analysis.strategyVersion,
    dataVersion: analysis.dataVersion,
    calculatedAt: analysis.calculatedAt,
    marketGate: analysis.marketGate,
    kospi: analysis.kospi,
    kosdaq: analysis.kosdaq,
    vkospi: analysis.vkospi,
    marketForeignNet5d: analysis.marketForeignNet5d,
    rotationSectors: buildRotationSectors(analysis),
    counts: {
      total: rows.length,
      passed: passed.length,
      disqualified: rows.length - passed.length,
      kosdaq80Onsets: rows.filter((row) => row.kosdaq80Onset).length,
      upsideExits: rows.filter(
        (row) => row.instrument.market === "KOSDAQ" && row.exitSignal === "UP95",
      ).length,
      downsideExits: rows.filter(
        (row) => row.instrument.market === "KOSDAQ" && row.exitSignal === "DOWN25",
      ).length,
      incomplete: rows.filter(
        (row) => row.instrument.instrumentType === "STOCK" && row.operatingScore10 === null,
      ).length,
    },
    failReasons: [...failMap.entries()].sort((a, b) => b[1] - a[1]),
    onsetRows: onsetRows.map(compactDashboardRow),
    exitRows: exitRows.map(compactDashboardRow),
    top: top.map(compactDashboardRow),
  };
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
  const cached = await readObject<DashboardSummary>(await dashboardPath());
  if (!cached || cached.version !== DASHBOARD_CACHE_VERSION) return null;
  const expectedInput = await currentInputFingerprint();
  return cached.inputFingerprint === expectedInput ? cached : null;
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
  const dashboard = await buildDashboardSummary(payload.analysis, inputFingerprint, resultDigest);
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
  const row = shared.payload.analysis.rows.find((item) => item.instrument.symbol === normalized) ?? null;
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
      ) return cached.detail;
    } catch {
      // 손상/구버전 cache는 아래에서 재생성한다.
    }
  }

  const raw = await ensureManualDataText();
  if (!raw) throw new Error("종목 상세 차트를 만들 원천 시세가 없습니다.");
  const targetDataset = buildInstrumentDetailDataset(raw, normalized);
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
