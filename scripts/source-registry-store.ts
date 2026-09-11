import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  compareSourceRows,
  SOURCE_MAX_FILE_BYTES,
  sourceRowKey,
  toCanonicalCsv,
  type CanonicalSourceRow,
  type SourceOverlapResult,
  type SourceType,
  type SourceUploadOrigin,
  type SourceValidationResult,
  validateSourceBytes,
} from "../src/lib/sourceData";
import { ANALYSIS_BUCKET, downloadJson, uploadJson } from "./analysis-run-store";

export type SourceRegistrationMode = "replace" | "append" | "merge" | "add" | "replace_all";

export interface SourceRecord {
  id: string;
  user_id: string;
  source_type: SourceType;
  original_filename: string;
  storage_bucket: string;
  storage_path: string;
  content_type: string;
  canonical_format: string;
  file_size_bytes: number;
  normalized_size_bytes: number;
  file_hash: string;
  data_hash: string;
  schema_hash: string;
  row_count: number;
  symbol_count: number;
  min_date: string | null;
  max_date: string | null;
  market_count: number;
  kospi_count: number;
  kosdaq_count: number;
  stock_count: number;
  etf_count: number;
  sector_mapped_count: number;
  sector_unmapped_count: number;
  upload_source: SourceUploadOrigin;
  status: "validating" | "valid" | "invalid" | "active" | "archived" | "superseded" | "deleted";
  validation_result: Record<string, unknown>;
  overlap_result: SourceOverlapResult | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  superseded_by: string | null;
}

export interface LoadedSourceInput {
  id: string;
  fileName: string | null;
  bytes: number;
  savedAt: string;
  text: string;
  fileHash: string;
  dataHash: string;
  schemaHash: string;
  sourceRecord: SourceRecord | null;
  validation: SourceValidationResult;
}

interface LegacyBacktestIndexEntry {
  id: string;
  fileName?: string | null;
  bytes?: number;
  savedAt?: string;
  sourceId?: string;
  dataHash?: string;
}

interface LegacyStoredText {
  text?: string;
  meta?: { fileName?: string | null; bytes?: number; chars?: number; savedAt?: string };
}

function safeFileName(filename: string, format: SourceValidationResult["format"]) {
  const extension = format === "xlsx" ? ".xlsx" : format === "json" ? ".json" : ".csv";
  const base = path
    .basename(filename)
    .normalize("NFKC")
    // File paths must not contain C0/DEL control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "-")
    .replace(/[^0-9A-Za-z가-힣._ -]/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return `${base.replace(/\.(csv|txt|json|xlsx)$/i, "") || "source"}${extension}`;
}

function modeFor(type: SourceType, mode: SourceRegistrationMode) {
  const allowed = type === "screening" ? ["replace", "append", "merge"] : ["add", "replace_all"];
  if (!allowed.includes(mode))
    throw new Error(`${type} 데이터에는 ${mode} 모드를 사용할 수 없습니다.`);
}

function compactValidation(validation: SourceValidationResult) {
  return {
    valid: validation.valid,
    format: validation.format,
    columns: validation.columns,
    stats: validation.stats,
    errors: validation.errors.slice(0, 100),
    warnings: validation.warnings.slice(0, 100),
    hashes: {
      file: validation.fileHash,
      data: validation.dataHash,
      schema: validation.schemaHash,
    },
  };
}

function recordFor(input: {
  id: string;
  userId: string;
  sourceType: SourceType;
  storagePath: string;
  origin: SourceUploadOrigin;
  validation: SourceValidationResult;
  overlap: SourceOverlapResult;
}) {
  const { validation } = input;
  return {
    id: input.id,
    user_id: input.userId,
    source_type: input.sourceType,
    original_filename: validation.originalFilename,
    storage_bucket: ANALYSIS_BUCKET,
    storage_path: input.storagePath,
    content_type: validation.contentType,
    canonical_format: "csv",
    file_size_bytes: validation.originalSizeBytes,
    normalized_size_bytes: validation.normalizedSizeBytes,
    file_hash: validation.fileHash,
    data_hash: validation.dataHash,
    schema_hash: validation.schemaHash,
    row_count: validation.stats.rowCount,
    symbol_count: validation.stats.symbolCount,
    min_date: validation.stats.minDate,
    max_date: validation.stats.maxDate,
    market_count: validation.stats.marketCount,
    kospi_count: validation.stats.kospiCount,
    kosdaq_count: validation.stats.kosdaqCount,
    stock_count: validation.stats.stockCount,
    etf_count: validation.stats.etfCount,
    sector_mapped_count: validation.stats.sectorMappedCount,
    sector_unmapped_count: validation.stats.sectorUnmappedCount,
    upload_source: input.origin,
    status: "valid" as const,
    validation_result: compactValidation(validation),
    overlap_result: input.overlap,
  };
}

export async function listSourceRecords(
  client: SupabaseClient,
  userId: string,
  sourceType: SourceType,
  statuses: SourceRecord["status"][] = ["active"],
) {
  const { data, error } = await client
    .from("analysis_source_files")
    .select("*")
    .eq("user_id", userId)
    .eq("source_type", sourceType)
    .in("status", statuses)
    .order("activated_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`원천데이터 목록 조회 실패: ${error.message}`);
  return (data ?? []) as SourceRecord[];
}

async function downloadBytes(client: SupabaseClient, bucket: string, objectPath: string) {
  const { data, error } = await client.storage.from(bucket).download(objectPath);
  if (error) throw new Error(`Supabase 다운로드 실패 (${objectPath}): ${error.message}`);
  return new Uint8Array(await data.arrayBuffer());
}

async function loadRegistryInputs(client: SupabaseClient, userId: string, sourceType: SourceType) {
  const records = await listSourceRecords(client, userId, sourceType);
  return Promise.all(
    records.map(async (record): Promise<LoadedSourceInput> => {
      const bytes = await downloadBytes(client, record.storage_bucket, record.storage_path);
      const validation = await validateSourceBytes({
        bytes,
        filename: record.original_filename,
        contentType: record.content_type,
      });
      if (!validation.valid)
        throw new Error(
          `등록 원천데이터 검증 실패 (${record.original_filename}): ${validation.errors[0]?.message ?? "형식 오류"}`,
        );
      if (
        validation.fileHash !== record.file_hash ||
        validation.dataHash !== record.data_hash ||
        validation.schemaHash !== record.schema_hash
      )
        throw new Error(`등록 원천데이터 해시 불일치: ${record.original_filename}`);
      return {
        id: record.id,
        fileName: record.original_filename,
        bytes: record.file_size_bytes,
        savedAt: record.activated_at ?? record.created_at,
        text: validation.canonicalCsv,
        fileHash: validation.fileHash,
        dataHash: validation.dataHash,
        schemaHash: validation.schemaHash,
        sourceRecord: record,
        validation,
      };
    }),
  );
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

async function legacyInput(
  client: SupabaseClient,
  objectPath: string,
  fallbackName: string,
  id: string,
): Promise<LoadedSourceInput | null> {
  const stored = await maybeDownloadJson<LegacyStoredText>(client, objectPath);
  if (!stored?.text?.trim()) return null;
  const filename = stored.meta?.fileName ?? fallbackName;
  const bytes = new TextEncoder().encode(stored.text);
  const validation = await validateSourceBytes({ bytes, filename });
  if (!validation.valid)
    throw new Error(
      `기존 Supabase 입력 검증 실패 (${filename}): ${validation.errors[0]?.message ?? "형식 오류"}`,
    );
  return {
    id,
    fileName: filename,
    bytes: stored.meta?.bytes ?? bytes.byteLength,
    savedAt: stored.meta?.savedAt ?? new Date(0).toISOString(),
    text: validation.canonicalCsv,
    fileHash: validation.fileHash,
    dataHash: validation.dataHash,
    schemaHash: validation.schemaHash,
    sourceRecord: null,
    validation,
  };
}

async function loadLegacyBacktestInputs(client: SupabaseClient, userId: string) {
  const index = await maybeDownloadJson<{ files?: LegacyBacktestIndexEntry[] }>(
    client,
    `${userId}/backtest/index.json`,
  );
  const entries = Array.isArray(index?.files) ? index.files : [];
  const loaded = await Promise.all(
    entries.map((entry) =>
      legacyInput(
        client,
        entry.id === "__legacy__"
          ? `${userId}/backtest.json`
          : `${userId}/backtest/${entry.id}.json`,
        entry.fileName ?? `${entry.id}.csv`,
        `legacy:${entry.id}`,
      ),
    ),
  );
  if (entries.length === 0) {
    const single = await legacyInput(
      client,
      `${userId}/backtest.json`,
      "backtest.csv",
      "legacy:__legacy__",
    );
    if (single) loaded.push(single);
  }
  return loaded.filter((value): value is LoadedSourceInput => value !== null);
}

/**
 * Actions와 CLI의 공통 입력 로더다. 신규 registry가 있으면 이를 우선하며,
 * backtest는 전환기 호환을 위해 아직 registry에 없는 legacy 파일도 해시 중복 제거 후 포함한다.
 */
export async function loadAnalysisSourceInputs(
  client: SupabaseClient,
  userId: string,
  sourceType: SourceType,
) {
  const registered = await loadRegistryInputs(client, userId, sourceType);
  if (sourceType === "screening") {
    // parseManualMarketData는 같은 종목·거래일의 첫 행을 유지한다. merge에서
    // 나중에 활성화한 원천이 기존 값을 덮어쓰도록 최신 파일부터 넘긴다.
    if (registered.length > 0) return [...registered].reverse();
    const legacy = await legacyInput(client, `${userId}/kr.json`, "screening.csv", "legacy:kr");
    if (!legacy) throw new Error("Supabase에 활성 스크리닝 원천데이터 또는 kr.json이 없습니다.");
    return [legacy];
  }
  const legacy = await loadLegacyBacktestInputs(client, userId);
  const seen = new Set(registered.map((input) => input.dataHash));
  const uniqueLegacy = legacy.filter((input) => {
    if (seen.has(input.dataHash)) return false;
    seen.add(input.dataHash);
    return true;
  });
  const combined = [...registered, ...uniqueLegacy];
  if (combined.length === 0) throw new Error("Supabase에 활성 백테스트 원천데이터가 없습니다.");
  return combined;
}

function validateOverlap(
  type: SourceType,
  mode: SourceRegistrationMode,
  overlap: SourceOverlapResult,
) {
  if (overlap.conflictingRows === 0) return;
  if (type === "screening" && (mode === "replace" || mode === "merge")) return;
  if (type === "backtest" && mode === "replace_all") return;
  const examples = overlap.examples
    .filter((value) => value.kind === "conflict")
    .slice(0, 3)
    .map((value) => value.key)
    .join(", ");
  throw new Error(
    `기존 데이터와 값이 다른 종목·거래일 중복이 ${overlap.conflictingRows}건입니다` +
      `${examples ? ` (${examples})` : ""}. 명시적인 교체 또는 merge 모드를 사용해 주세요.`,
  );
}

async function syncLegacyScreening(
  client: SupabaseClient,
  userId: string,
  inputs: LoadedSourceInput[],
  filename: string,
) {
  const merged = new Map<string, CanonicalSourceRow>();
  for (const input of inputs) {
    for (const row of input.validation.rows) merged.set(sourceRowKey(row), row);
  }
  const text = toCanonicalCsv([...merged.values()]);
  await uploadJson(client, `${userId}/kr.json`, {
    text,
    meta: { savedAt: new Date().toISOString(), fileName: filename, chars: text.length },
  });
}

async function syncLegacyBacktestEntry(
  client: SupabaseClient,
  userId: string,
  source: SourceRecord,
  validation: SourceValidationResult,
  replaceAll: boolean,
) {
  const indexPath = `${userId}/backtest/index.json`;
  const current = replaceAll
    ? { files: [] as LegacyBacktestIndexEntry[] }
    : ((await maybeDownloadJson<{ files?: LegacyBacktestIndexEntry[] }>(client, indexPath)) ?? {});
  const oldEntries = Array.isArray(current.files) ? current.files : [];
  if (replaceAll && oldEntries.length > 0) {
    const oldPaths = oldEntries
      .filter((entry) => entry.id !== source.id)
      .map((entry) =>
        entry.id === "__legacy__"
          ? `${userId}/backtest.json`
          : `${userId}/backtest/${entry.id}.json`,
      );
    if (oldPaths.length > 0) {
      const { error } = await client.storage.from(ANALYSIS_BUCKET).remove(oldPaths);
      if (error) throw new Error(`기존 백테스트 파일 정리 실패: ${error.message}`);
    }
  }
  await uploadJson(client, `${userId}/backtest/${source.id}.json`, {
    text: validation.canonicalCsv,
    meta: {
      savedAt: source.activated_at ?? source.created_at,
      fileName: source.original_filename,
      bytes: validation.normalizedSizeBytes,
      sourceId: source.id,
      dataHash: source.data_hash,
    },
  });
  const entry: LegacyBacktestIndexEntry = {
    id: source.id,
    fileName: source.original_filename,
    bytes: validation.normalizedSizeBytes,
    savedAt: source.activated_at ?? source.created_at,
    sourceId: source.id,
    dataHash: source.data_hash,
  };
  await uploadJson(client, indexPath, {
    files: [...oldEntries.filter((value) => value.id !== source.id && !replaceAll), entry],
  });
}

export async function registerSourceBytes(input: {
  client: SupabaseClient;
  userId: string;
  sourceType: SourceType;
  mode: SourceRegistrationMode;
  origin: SourceUploadOrigin;
  bytes: Uint8Array;
  filename: string;
  contentType?: string;
  syncLegacy?: boolean;
}) {
  modeFor(input.sourceType, input.mode);
  if (input.bytes.byteLength > SOURCE_MAX_FILE_BYTES)
    throw new Error("파일 1개 크기는 45MB 이하여야 합니다.");
  const validation = await validateSourceBytes({
    bytes: input.bytes,
    filename: input.filename,
    contentType: input.contentType,
  });
  if (!validation.valid)
    throw new Error(
      `원천데이터 검증 실패: ${validation.errors
        .slice(0, 5)
        .map((value) => value.message)
        .join(" / ")}`,
    );

  const existing = await loadAnalysisSourceInputs(
    input.client,
    input.userId,
    input.sourceType,
  ).catch((error: unknown) => {
    if (error instanceof Error && /없습니다/.test(error.message)) return [] as LoadedSourceInput[];
    throw error;
  });
  const activeRegistered = existing.filter((value) => value.sourceRecord);
  const exact = activeRegistered.find((value) => value.dataHash === validation.dataHash);
  if (exact && (input.mode === "append" || input.mode === "add")) {
    return {
      reused: true,
      source: exact.sourceRecord!,
      validation,
      overlap: compareSourceRows(validation.rows, [
        { sourceId: exact.id, rows: exact.validation.rows },
      ]),
    };
  }

  const compareExisting =
    (input.sourceType === "screening" && input.mode === "replace") ||
    (input.sourceType === "backtest" && input.mode === "replace_all")
      ? []
      : existing.map((value) => ({ sourceId: value.id, rows: value.validation.rows }));
  const overlap = compareSourceRows(validation.rows, compareExisting);
  validateOverlap(input.sourceType, input.mode, overlap);
  if (input.sourceType === "screening") {
    const effective = new Map<string, CanonicalSourceRow>();
    for (const source of compareExisting) {
      for (const row of source.rows) effective.set(sourceRowKey(row), row);
    }
    for (const row of validation.rows) effective.set(sourceRowKey(row), row);
    parseManualMarketData(toCanonicalCsv([...effective.values()]));
  } else if (input.mode === "replace_all" || compareExisting.length === 0) {
    parseManualMarketData(validation.canonicalCsv);
  }

  const sourceId = crypto.randomUUID();
  const storedName = safeFileName(validation.originalFilename, validation.format);
  const storagePath = `${input.userId}/source/${input.sourceType}/${sourceId}/${storedName}`;
  const { error: uploadError } = await input.client.storage
    .from(ANALYSIS_BUCKET)
    .upload(storagePath, input.bytes, {
      contentType: validation.contentType,
      upsert: false,
    });
  if (uploadError) throw new Error(`원천파일 업로드 실패: ${uploadError.message}`);

  const record = recordFor({
    id: sourceId,
    userId: input.userId,
    sourceType: input.sourceType,
    storagePath,
    origin: input.origin,
    validation,
    overlap,
  });
  const { error: insertError } = await input.client.from("analysis_source_files").insert(record);
  if (insertError) {
    await input.client.storage.from(ANALYSIS_BUCKET).remove([storagePath]);
    throw new Error(`원천데이터 등록 실패: ${insertError.message}`);
  }
  const { data: activated, error: activateError } = await input.client.rpc(
    "activate_analysis_source_file",
    { p_source_id: sourceId, p_mode: input.mode },
  );
  if (activateError) {
    await Promise.allSettled([
      input.client.storage.from(ANALYSIS_BUCKET).remove([storagePath]),
      input.client.from("analysis_source_files").update({ status: "invalid" }).eq("id", sourceId),
    ]);
    throw new Error(`원천데이터 활성화 실패: ${activateError.message}`);
  }
  const source = activated as SourceRecord;
  if (input.syncLegacy !== false) {
    if (input.sourceType === "screening") {
      const activeAfter = await loadRegistryInputs(input.client, input.userId, "screening");
      await syncLegacyScreening(input.client, input.userId, activeAfter, source.original_filename);
    } else {
      await syncLegacyBacktestEntry(
        input.client,
        input.userId,
        source,
        validation,
        input.mode === "replace_all",
      );
    }
  }
  await uploadJson(input.client, `${input.userId}/results/ingestion/${source.id}.json`, {
    sourceId: source.id,
    sourceType: source.source_type,
    mode: input.mode,
    status: source.status,
    originalFilename: source.original_filename,
    createdAt: source.created_at,
    hashes: {
      file: source.file_hash,
      data: source.data_hash,
      schema: source.schema_hash,
    },
    validation: compactValidation(validation),
    overlap,
  });
  return { reused: false, source, validation, overlap };
}

export async function removeSourceRecord(client: SupabaseClient, userId: string, sourceId: string) {
  const { data, error } = await client
    .from("analysis_source_files")
    .select("*")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`원천데이터 조회 실패: ${error.message}`);
  if (!data) return null;
  const source = data as SourceRecord;
  const { error: updateError } = await client
    .from("analysis_source_files")
    .update({ status: "deleted" })
    .eq("id", sourceId)
    .eq("user_id", userId);
  if (updateError) throw new Error(`원천데이터 삭제상태 저장 실패: ${updateError.message}`);
  const paths = [source.storage_path];
  if (source.source_type === "backtest") paths.push(`${userId}/backtest/${source.id}.json`);
  const { error: removeError } = await client.storage.from(ANALYSIS_BUCKET).remove(paths);
  if (removeError) throw new Error(`원천파일 삭제 실패: ${removeError.message}`);

  if (source.source_type === "backtest") {
    const indexPath = `${userId}/backtest/index.json`;
    const index = await maybeDownloadJson<{ files?: LegacyBacktestIndexEntry[] }>(
      client,
      indexPath,
    );
    await uploadJson(client, indexPath, {
      files: (index?.files ?? []).filter((entry) => entry.id !== source.id),
    });
  }
  return source;
}
