import { ownerPath, removeObjects, supabase, userId } from "./cloud";
import { parseManualMarketData } from "./engine/manualDataset";
import {
  compareSourceRows,
  sourceRowKey,
  toCanonicalCsv,
  type SourceOverlapResult,
  type SourceType,
  type SourceUploadOrigin,
  type SourceValidationResult,
  validateSourceBlob,
} from "./sourceData";

export type ScreeningRegistrationMode = "replace" | "append" | "merge";
export type BacktestRegistrationMode = "add" | "replace_all";
export type SourceRegistrationMode = ScreeningRegistrationMode | BacktestRegistrationMode;

export interface AnalysisSourceFileRecord {
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

export interface SourceRegistrationResult {
  source: AnalysisSourceFileRecord;
  validation: SourceValidationResult;
  overlap: SourceOverlapResult;
  reused: boolean;
}

const BUCKET = "cloudtrend-data";

function modeFor(type: SourceType, mode: SourceRegistrationMode) {
  const allowed = type === "screening" ? ["replace", "append", "merge"] : ["add", "replace_all"];
  if (!allowed.includes(mode))
    throw new Error(`${type} 데이터에는 ${mode} 모드를 사용할 수 없습니다.`);
  return mode;
}

function safeFileName(filename: string, format: SourceValidationResult["format"]) {
  const extension = format === "xlsx" ? ".xlsx" : format === "json" ? ".json" : ".csv";
  const base = filename
    .normalize("NFKC")
    // File paths must not contain separators or C0/DEL control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\\u0000-\u001f\u007f]/g, "-")
    .replace(/[^0-9A-Za-z가-힣._ -]/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  const withoutKnownExtension = base.replace(/\.(csv|txt|json|xlsx)$/i, "") || "source";
  return `${withoutKnownExtension}${extension}`;
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

function recordFromValidation(input: {
  id: string;
  owner: string;
  sourceType: SourceType;
  origin: SourceUploadOrigin;
  storagePath: string;
  validation: SourceValidationResult;
  overlap: SourceOverlapResult;
}) {
  const { validation } = input;
  return {
    id: input.id,
    user_id: input.owner,
    source_type: input.sourceType,
    original_filename: validation.originalFilename,
    storage_bucket: BUCKET,
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

export async function listRegisteredSources(
  sourceType: SourceType,
  statuses: AnalysisSourceFileRecord["status"][] = ["active"],
) {
  const owner = await userId();
  const { data, error } = await supabase
    .from("analysis_source_files")
    .select("*")
    .eq("user_id", owner)
    .eq("source_type", sourceType)
    .in("status", statuses)
    .order("activated_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`등록 원천데이터 목록을 불러오지 못했습니다: ${error.message}`);
  return (data ?? []) as AnalysisSourceFileRecord[];
}

async function activeRows(sourceType: SourceType) {
  const active = await listRegisteredSources(sourceType);
  return Promise.all(
    active.map(async (source) => {
      const { data, error } = await supabase.storage
        .from(source.storage_bucket)
        .download(source.storage_path);
      if (error)
        throw new Error(`기존 원천데이터를 확인하지 못했습니다: ${source.original_filename}`);
      const validation = await validateSourceBlob(data, source.original_filename);
      if (!validation.valid)
        throw new Error(`기존 원천데이터 검증에 실패했습니다: ${source.original_filename}`);
      if (validation.fileHash !== source.file_hash || validation.dataHash !== source.data_hash)
        throw new Error(
          `기존 원천데이터의 해시가 등록정보와 다릅니다: ${source.original_filename}`,
        );
      return { sourceId: source.id, rows: validation.rows };
    }),
  );
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
    .filter((item) => item.kind === "conflict")
    .slice(0, 3)
    .map((item) => item.key)
    .join(", ");
  throw new Error(
    `기존 활성 데이터와 값이 다른 중복 종목·거래일이 ${overlap.conflictingRows}건 있습니다` +
      `${examples ? ` (${examples})` : ""}. replace/merge 또는 replace_all 모드를 사용해 주세요.`,
  );
}

export async function registerSourceBlob(input: {
  blob: Blob;
  filename: string;
  sourceType: SourceType;
  mode: SourceRegistrationMode;
  origin?: SourceUploadOrigin;
}): Promise<SourceRegistrationResult> {
  modeFor(input.sourceType, input.mode);
  const validation = await validateSourceBlob(input.blob, input.filename);
  if (!validation.valid) {
    const first = validation.errors
      .slice(0, 5)
      .map((item) => item.message)
      .join(" / ");
    throw new Error(`원천데이터 검증 실패: ${first}`);
  }

  const owner = await userId();
  const active = await listRegisteredSources(input.sourceType);
  const exact = active.find((source) => source.data_hash === validation.dataHash);
  if (exact && (input.mode === "append" || input.mode === "add")) {
    return {
      source: exact,
      validation,
      overlap: {
        incomingRows: validation.stats.rowCount,
        newRows: 0,
        identicalRows: validation.stats.rowCount,
        conflictingRows: 0,
        overlappingSymbols: validation.stats.symbolCount,
        examples: [],
      },
      reused: true,
    };
  }

  const compareExisting =
    (input.sourceType === "screening" && input.mode === "replace") ||
    (input.sourceType === "backtest" && input.mode === "replace_all")
      ? []
      : await activeRows(input.sourceType);
  const overlap = compareSourceRows(validation.rows, compareExisting);
  validateOverlap(input.sourceType, input.mode, overlap);
  if (input.sourceType === "screening") {
    const effective = new Map<string, (typeof validation.rows)[number]>();
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
  const storagePath = await ownerPath(`source/${input.sourceType}/${sourceId}/${storedName}`);
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, input.blob, {
      contentType: validation.contentType,
      upsert: false,
    });
  if (uploadError) throw new Error(`원천파일 업로드 실패: ${uploadError.message}`);

  const record = recordFromValidation({
    id: sourceId,
    owner,
    sourceType: input.sourceType,
    origin: input.origin ?? "web",
    storagePath,
    validation,
    overlap,
  });
  const { data: inserted, error: insertError } = await supabase
    .from("analysis_source_files")
    .insert(record)
    .select("*")
    .single();
  if (insertError) {
    await removeObjects([storagePath]);
    throw new Error(`원천데이터 등록 실패: ${insertError.message}`);
  }

  const { data: activated, error: activateError } = await supabase.rpc(
    "activate_analysis_source_file",
    { p_source_id: sourceId, p_mode: input.mode },
  );
  if (activateError) {
    await Promise.allSettled([
      removeObjects([storagePath]),
      supabase
        .from("analysis_source_files")
        .update({ status: "invalid" })
        .eq("id", sourceId)
        .eq("user_id", owner),
    ]);
    throw new Error(`원천데이터 활성화 실패: ${activateError.message}`);
  }
  return {
    source: (activated ?? inserted) as AnalysisSourceFileRecord,
    validation,
    overlap,
    reused: false,
  };
}

export async function removeRegisteredSource(sourceId: string) {
  const owner = await userId();
  const { data, error } = await supabase
    .from("analysis_source_files")
    .select("*")
    .eq("id", sourceId)
    .eq("user_id", owner)
    .maybeSingle();
  if (error) throw new Error(`원천데이터를 찾지 못했습니다: ${error.message}`);
  if (!data) return false;
  const source = data as AnalysisSourceFileRecord;
  const { error: updateError } = await supabase
    .from("analysis_source_files")
    .update({ status: "deleted" })
    .eq("id", sourceId)
    .eq("user_id", owner);
  if (updateError) throw new Error(`원천데이터 삭제상태 저장 실패: ${updateError.message}`);
  await removeObjects([source.storage_path]);
  return true;
}
