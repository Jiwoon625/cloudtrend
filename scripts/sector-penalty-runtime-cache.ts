import { gunzipSync, gzipSync } from "node:zlib";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MarketDataset } from "../src/lib/engine/dataset";
import { ANALYSIS_BUCKET, sha256, stableJson } from "./analysis-run-store";
import { listSourceRecords, type LoadedSourceInput } from "./source-registry-store";

export const PORTFOLIO_RUNTIME_CACHE_VERSION = "sector-v8-runtime-v1" as const;

export interface RuntimeSourceFile {
  id: string;
  fileName: string | null;
  bytes: number;
  savedAt: string;
  dataHash: string;
  schemaHash: string;
}

export interface PortfolioRuntimeCache {
  version: typeof PORTFOLIO_RUNTIME_CACHE_VERSION;
  createdAt: string;
  manifestFingerprint: string;
  limit: number;
  sourceFiles: RuntimeSourceFile[];
  dataset: MarketDataset;
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

/**
 * V8 포트폴리오 엔진에서 실제로 쓰는 시장 구조만 유지한다.
 * 재무/ETF/VKOSPI payload는 제거하여 압축 전 메모리와 Storage 용량을 줄인다.
 */
function compactPortfolioDataset(dataset: MarketDataset): MarketDataset {
  const instruments = dataset.instruments.filter((instrument) => instrument.instrumentType === "STOCK");
  const symbols = new Set(instruments.map((instrument) => instrument.symbol));
  return {
    ...dataset,
    instruments,
    bars: Object.fromEntries(Object.entries(dataset.bars).filter(([symbol]) => symbols.has(symbol))),
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
}): PortfolioRuntimeCache {
  return {
    version: PORTFOLIO_RUNTIME_CACHE_VERSION,
    createdAt: new Date().toISOString(),
    manifestFingerprint: input.manifestFingerprint,
    limit: input.limit,
    sourceFiles: input.sourceFiles,
    dataset: compactPortfolioDataset(input.dataset),
  };
}

export async function maybeDownloadPortfolioRuntimeCache(
  client: SupabaseClient,
  objectPath: string,
  expectedManifestFingerprint: string,
  expectedLimit: number,
): Promise<{ cache: PortfolioRuntimeCache | null; compressedBytes: number | null }> {
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(objectPath);
  if (error) {
    if (/Object not found|not_found|404/i.test(error.message)) return { cache: null, compressedBytes: null };
    throw new Error(`Supabase runtime cache 다운로드 실패 (${objectPath}): ${error.message}`);
  }
  const compressed = Buffer.from(await data.arrayBuffer());
  const parsed = JSON.parse(gunzipSync(compressed).toString("utf8")) as PortfolioRuntimeCache;
  if (
    parsed.version !== PORTFOLIO_RUNTIME_CACHE_VERSION ||
    parsed.manifestFingerprint !== expectedManifestFingerprint ||
    parsed.limit !== expectedLimit
  ) return { cache: null, compressedBytes: compressed.byteLength };
  return { cache: parsed, compressedBytes: compressed.byteLength };
}

export async function uploadPortfolioRuntimeCache(
  client: SupabaseClient,
  objectPath: string,
  cache: PortfolioRuntimeCache,
) {
  const raw = Buffer.from(JSON.stringify(cache), "utf8");
  const compressed = gzipSync(raw, { level: 6 });
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(objectPath, compressed, {
    // cloudtrend-data bucket explicitly allows application/octet-stream.
    contentType: "application/octet-stream",
    upsert: true,
  });
  if (error) throw new Error(`Supabase runtime cache 업로드 실패 (${objectPath}): ${error.message}`);
  return { uncompressedBytes: raw.byteLength, compressedBytes: compressed.byteLength };
}
