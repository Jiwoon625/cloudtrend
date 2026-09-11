import { gunzipSync, gzipSync } from "node:zlib";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MarketDataset } from "../src/lib/engine/dataset";
import {
  PORTFOLIO_FEATURE_CACHE_VERSION,
  type PortfolioFeatureCache,
} from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import type { DailyPrice, Instrument, Market } from "../src/lib/engine/types";
import { ANALYSIS_BUCKET, sha256, stableJson } from "./analysis-run-store";
import { listSourceRecords, type LoadedSourceInput } from "./source-registry-store";

export const PORTFOLIO_RUNTIME_CACHE_VERSION = "sector-v8-runtime-v2" as const;

export interface RuntimeSourceFile {
  id: string;
  fileName: string | null;
  bytes: number;
  savedAt: string;
  dataHash: string;
  schemaHash: string;
}

type CompactBar = [dateIndex: number, open: number, high: number, low: number, close: number, tradingValue: number];
type CompactIndexBar = [dateIndex: number, close: number];

interface CompactInstrument {
  symbol: string;
  name: string;
  market: Market;
  sectorCode: string;
  sectorName: string;
  isActive: boolean;
}

interface CompactDataset {
  provider: string;
  version: string;
  asOfDate: string;
  isLive: boolean;
  capabilities: MarketDataset["capabilities"];
  notes: string[];
  tradeDates: string[];
  instruments: CompactInstrument[];
  bars: Record<string, CompactBar[]>;
  indexSeries: Array<{
    indexCode: string;
    indexName: string;
    bars: CompactIndexBar[];
  }>;
}

export interface PortfolioRuntimeCache {
  version: typeof PORTFOLIO_RUNTIME_CACHE_VERSION;
  createdAt: string;
  manifestFingerprint: string;
  limit: number;
  sourceFiles: RuntimeSourceFile[];
  dataset: CompactDataset;
  featureCache: PortfolioFeatureCache;
}

export interface BacktestSourceManifest {
  fingerprint: string;
  registeredCount: number;
  legacyObjectCount: number;
  entries: unknown[];
}

function storageObjectDescriptor(item: {
  id?: string | null;
  name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const metadata = item.metadata ?? {};
  return {
    id: item.id ?? null,
    name: item.name ?? null,
    createdAt: item.created_at ?? null,
    updatedAt: item.updated_at ?? null,
    size: typeof metadata["size"] === "number" ? metadata["size"] : null,
    eTag: typeof metadata["eTag"] === "string" ? metadata["eTag"] : null,
    lastModified: typeof metadata["lastModified"] === "string" ? metadata["lastModified"] : null,
  };
}

async function listStorageObjects(client: SupabaseClient, prefix: string, search?: string) {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).list(prefix, {
    limit: 1000,
    offset: 0,
    sortBy: { column: "name", order: "asc" },
    ...(search ? { search } : {}),
  });
  if (error) throw new Error(`Supabase 원천 manifest 조회 실패 (${prefix}): ${error.message}`);
  return (data ?? []).filter((item) => item.id !== null).map(storageObjectDescriptor);
}

/**
 * 원천 파일 본문을 내려받기 전에 DB registry + Storage object metadata만으로
 * 백테스트 입력 변경 여부를 판정한다. 같은 manifest면 압축 runtime cache를 재사용한다.
 */
export async function buildBacktestSourceManifest(
  client: SupabaseClient,
  userId: string,
  limit: number,
): Promise<BacktestSourceManifest> {
  const [registered, legacyFolder, legacyRoot] = await Promise.all([
    listSourceRecords(client, userId, "backtest"),
    listStorageObjects(client, `${userId}/backtest`),
    listStorageObjects(client, userId, "backtest.json"),
  ]);

  const registeredEntries = registered
    .map((record) => ({
      kind: "registry" as const,
      id: record.id,
      storageBucket: record.storage_bucket,
      storagePath: record.storage_path,
      bytes: record.file_size_bytes,
      dataHash: record.data_hash,
      schemaHash: record.schema_hash,
      status: record.status,
      activatedAt: record.activated_at,
      updatedAt: record.updated_at,
    }))
    .sort((a, b) => a.storagePath.localeCompare(b.storagePath));

  const legacyEntries = [...legacyFolder, ...legacyRoot]
    .filter((entry) => entry.name?.endsWith(".json"))
    .map((entry) => ({ kind: "legacy-storage" as const, ...entry }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const entries = [...registeredEntries, ...legacyEntries];
  const fingerprint = sha256(stableJson({
    version: PORTFOLIO_RUNTIME_CACHE_VERSION,
    limit,
    entries,
  }));

  return {
    fingerprint,
    registeredCount: registeredEntries.length,
    legacyObjectCount: legacyEntries.length,
    entries,
  };
}

export function runtimeSourceFiles(inputs: LoadedSourceInput[]): RuntimeSourceFile[] {
  return inputs.map((input) => ({
    id: input.id,
    fileName: input.fileName,
    bytes: input.bytes,
    savedAt: input.savedAt,
    dataHash: input.dataHash,
    schemaHash: input.schemaHash,
  }));
}

function compactInstrument(instrument: Instrument): CompactInstrument {
  return {
    symbol: instrument.symbol,
    name: instrument.name,
    market: instrument.market,
    sectorCode: instrument.sectorCode,
    sectorName: instrument.sectorName,
    isActive: instrument.isActive,
  };
}

function restoreInstrument(instrument: CompactInstrument): Instrument {
  return {
    id: instrument.symbol,
    symbol: instrument.symbol,
    name: instrument.name,
    instrumentType: "STOCK",
    market: instrument.market,
    sectorCode: instrument.sectorCode,
    sectorName: instrument.sectorName,
    isPreferredStock: false,
    isManagementIssue: false,
    isInvestmentWarning: false,
    isLeveraged: false,
    isInverse: false,
    isActive: instrument.isActive,
    indexMemberships: [],
  };
}

function restoreBar(tradeDate: string, tuple: CompactBar): DailyPrice {
  const [, open, high, low, close, tradingValue] = tuple;
  return {
    tradeDate,
    open,
    high,
    low,
    close,
    volume: 0,
    tradingValue,
    marketCap: null,
    foreignNetBuyValue: null,
    institutionNetBuyValue: null,
  };
}

function restoreIndexBar(tradeDate: string, tuple: CompactIndexBar): DailyPrice {
  const [, close] = tuple;
  return {
    tradeDate,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
    tradingValue: 0,
    marketCap: null,
    foreignNetBuyValue: null,
    institutionNetBuyValue: null,
  };
}

/**
 * Runtime cache는 Feature Cache가 이미 계산한 종목 집합만 보존한다.
 * OHLC + 거래대금은 tuple로, 날짜는 전역 tradeDates의 정수 index로 저장해
 * JSON key/date 반복을 제거한다. Feature Cache도 같은 gzip 객체에 묶는다.
 */
function compactPortfolioDataset(
  dataset: MarketDataset,
  featureCache: PortfolioFeatureCache,
): CompactDataset {
  const instrumentBySymbol = new Map(dataset.instruments.map((instrument) => [instrument.symbol, instrument]));
  const selected = featureCache.series
    .map((item) => instrumentBySymbol.get(item.symbol))
    .filter((instrument): instrument is Instrument => Boolean(instrument));

  const dateSet = new Set(dataset.tradeDates);
  for (const instrument of selected) {
    for (const bar of dataset.bars[instrument.symbol] ?? []) dateSet.add(bar.tradeDate);
  }
  for (const series of dataset.indexSeries) {
    if (series.indexCode !== "KOSPI" && series.indexCode !== "KOSDAQ") continue;
    for (const bar of series.bars) dateSet.add(bar.tradeDate);
  }
  const tradeDates = [...dateSet].sort();
  const dateIndex = new Map(tradeDates.map((date, index) => [date, index]));

  const bars = Object.fromEntries(
    selected.map((instrument) => [
      instrument.symbol,
      (dataset.bars[instrument.symbol] ?? []).map((bar): CompactBar => [
        dateIndex.get(bar.tradeDate)!,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.tradingValue,
      ]),
    ]),
  );

  const indexSeries = dataset.indexSeries
    .filter((series) => series.indexCode === "KOSPI" || series.indexCode === "KOSDAQ")
    .map((series) => ({
      indexCode: series.indexCode,
      indexName: series.indexName,
      bars: series.bars.map((bar): CompactIndexBar => [dateIndex.get(bar.tradeDate)!, bar.close]),
    }));

  return {
    provider: dataset.provider,
    version: dataset.version,
    asOfDate: dataset.asOfDate,
    isLive: dataset.isLive,
    capabilities: dataset.capabilities,
    notes: dataset.notes,
    tradeDates,
    instruments: selected.map(compactInstrument),
    bars,
    indexSeries,
  };
}

function restorePortfolioDataset(dataset: CompactDataset): MarketDataset {
  const tradeDates = dataset.tradeDates;
  const instruments = dataset.instruments.map(restoreInstrument);
  const sectors = [...new Map(instruments.map((instrument) => [instrument.sectorCode, {
    code: instrument.sectorCode,
    name: instrument.sectorName,
  }])).values()];

  return {
    provider: dataset.provider,
    version: dataset.version,
    asOfDate: dataset.asOfDate,
    isLive: dataset.isLive,
    capabilities: dataset.capabilities,
    notes: dataset.notes,
    sectors,
    tradeDates,
    instruments,
    bars: Object.fromEntries(
      Object.entries(dataset.bars).map(([symbol, tuples]) => [
        symbol,
        tuples.map((tuple) => restoreBar(tradeDates[tuple[0]]!, tuple)),
      ]),
    ),
    indexSeries: dataset.indexSeries.map((series) => ({
      indexCode: series.indexCode,
      indexName: series.indexName,
      bars: series.bars.map((tuple) => restoreIndexBar(tradeDates[tuple[0]]!, tuple)),
    })),
    financials: {},
    etfFacts: {},
    vkospiSeries: [],
  };
}

export function createPortfolioRuntimeCache(input: {
  manifestFingerprint: string;
  limit: number;
  sourceFiles: RuntimeSourceFile[];
  dataset: MarketDataset;
  featureCache: PortfolioFeatureCache;
}): PortfolioRuntimeCache {
  return {
    version: PORTFOLIO_RUNTIME_CACHE_VERSION,
    createdAt: new Date().toISOString(),
    manifestFingerprint: input.manifestFingerprint,
    limit: input.limit,
    sourceFiles: input.sourceFiles,
    dataset: compactPortfolioDataset(input.dataset, input.featureCache),
    featureCache: input.featureCache,
  };
}

export async function maybeDownloadPortfolioRuntimeCache(
  client: SupabaseClient,
  objectPath: string,
  expectedManifestFingerprint: string,
  expectedLimit: number,
): Promise<{
  cache: { dataset: MarketDataset; featureCache: PortfolioFeatureCache; sourceFiles: RuntimeSourceFile[] } | null;
  compressedBytes: number | null;
  uncompressedBytes: number | null;
}> {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(objectPath);
  if (error) {
    if (/Object not found|not_found|404/i.test(error.message)) {
      return { cache: null, compressedBytes: null, uncompressedBytes: null };
    }
    throw new Error(`Supabase runtime cache 다운로드 실패 (${objectPath}): ${error.message}`);
  }
  const compressed = Buffer.from(await data.arrayBuffer());
  const raw = gunzipSync(compressed);
  const parsed = JSON.parse(raw.toString("utf8")) as PortfolioRuntimeCache;
  if (
    parsed.version !== PORTFOLIO_RUNTIME_CACHE_VERSION ||
    parsed.manifestFingerprint !== expectedManifestFingerprint ||
    parsed.limit !== expectedLimit ||
    parsed.featureCache?.version !== PORTFOLIO_FEATURE_CACHE_VERSION ||
    parsed.featureCache?.limit !== expectedLimit ||
    parsed.featureCache?.datasetVersion !== parsed.dataset?.version ||
    parsed.featureCache?.asOfDate !== parsed.dataset?.asOfDate
  ) {
    return {
      cache: null,
      compressedBytes: compressed.byteLength,
      uncompressedBytes: raw.byteLength,
    };
  }
  return {
    cache: {
      dataset: restorePortfolioDataset(parsed.dataset),
      featureCache: parsed.featureCache,
      sourceFiles: parsed.sourceFiles,
    },
    compressedBytes: compressed.byteLength,
    uncompressedBytes: raw.byteLength,
  };
}

export async function uploadPortfolioRuntimeCache(
  client: SupabaseClient,
  objectPath: string,
  cache: PortfolioRuntimeCache,
) {
  const raw = Buffer.from(JSON.stringify(cache), "utf8");
  const compressed = gzipSync(raw, { level: 9 });
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(objectPath, compressed, {
    // cloudtrend-data bucket에서 허용되는 일반 바이너리 MIME을 사용한다.
    contentType: "application/octet-stream",
    upsert: true,
  });
  if (error) throw new Error(`Supabase runtime cache 업로드 실패 (${objectPath}): ${error.message}`);
  return { uncompressedBytes: raw.byteLength, compressedBytes: compressed.byteLength };
}
