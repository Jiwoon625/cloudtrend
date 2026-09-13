import { parseManualMarketData, type ManualParseResult } from "@/lib/engine/manualDataset";
import {
  buildV8InputQualityReport,
  V8_INPUT_CONTRACT_VERSION,
} from "@/lib/engine/v8InputQuality";
import {
  ownerPath,
  readFile,
  readTextObject,
  removeFile,
  removeObjects,
  supabase,
  type CloudFile,
  writeFile,
  writeTextObject,
} from "@/lib/cloud";
import {
  listRegisteredSources,
  registerSourceBlob,
  removeRegisteredSource,
  type AnalysisSourceFileRecord,
  type SourceRegistrationResult,
} from "@/lib/sourceRegistry";
import {
  sourceRowFingerprint,
  sourceRowKey,
  toCanonicalCsv,
  validateSourceBlob,
  type SourceValidationResult,
} from "@/lib/sourceData";

export interface ManualDataMeta {
  savedAt: string;
  fileName: string | null;
  chars: number;
  rawPath?: string | null;
  dataHash?: string | null;
  schemaHash?: string | null;
  normalizedBytes?: number | null;
  sourceContractVersion?: string | null;
}

export interface ManualSourceFileEntry {
  id: string;
  fileName: string;
  bytes: number;
  rows: number;
  symbols: number;
  minDate: string | null;
  maxDate: string | null;
  savedAt: string;
  dataHash: string;
}

const RAW_SCREENING_RELATIVE_PATH = "raw/screening/latest.csv";
let file: CloudFile<ManualDataMeta> | null = null;
let metaHydration: Promise<void> | null = null;
let rawHydration: Promise<void> | null = null;
let sourceHydration: Promise<void> | null = null;
let rawText: string | null = null;
let sources: AnalysisSourceFileRecord[] = [];
let cache: { key: string; parsed: ManualParseResult } | null = null;
const sourceValidationCache = new Map<string, SourceValidationResult>();

async function hydrateMeta(): Promise<void> {
  if (file) return;
  return (metaHydration ??= readFile<ManualDataMeta>("kr")
    .then((v) => {
      file = v;
      if (v?.text?.trim()) rawText = v.text;
    })
    .catch((e) => {
      metaHydration = null;
      throw e;
    }));
}

async function refreshSources() {
  sources = await listRegisteredSources("screening", ["active"]);
  sourceHydration = Promise.resolve();
}

async function hydrateSources(): Promise<void> {
  if (sourceHydration) return sourceHydration;
  return (sourceHydration = refreshSources().catch((e) => {
    sourceHydration = null;
    throw e;
  }));
}

async function migrateLegacyKrJsonIfNeeded() {
  if (!file?.text?.trim() || file.meta.rawPath || sources.length > 0) return;
  const rawPath = await ownerPath(RAW_SCREENING_RELATIVE_PATH);
  await writeTextObject(rawPath, file.text);
  const next: CloudFile<ManualDataMeta> = {
    text: "",
    meta: {
      ...file.meta,
      rawPath,
      normalizedBytes: new TextEncoder().encode(file.text).byteLength,
    },
  };
  await writeFile("kr", next);
  file = next;
}

async function loadRegisteredValidation(source: AnalysisSourceFileRecord) {
  const cached = sourceValidationCache.get(source.id);
  if (cached) return cached;
  const { data, error } = await supabase.storage
    .from(source.storage_bucket)
    .download(source.storage_path);
  if (error)
    throw new Error(`스크리닝 원천파일을 불러오지 못했습니다: ${source.original_filename}`);
  const validation = await validateSourceBlob(data, source.original_filename);
  if (!validation.valid)
    throw new Error(`스크리닝 원천파일 검증에 실패했습니다: ${source.original_filename}`);
  if (validation.fileHash !== source.file_hash || validation.dataHash !== source.data_hash)
    throw new Error(`스크리닝 원천파일 해시가 등록정보와 다릅니다: ${source.original_filename}`);
  sourceValidationCache.set(source.id, validation);
  return validation;
}

function sourceKey() {
  return sources.map((source) => `${source.id}:${source.data_hash}`).join("|");
}

/**
 * 화면 진입 시 registry 목록은 가볍게 복원한다. loadRaw=true인 기존 호출은 호환을 위해
 * 실제 데이터셋까지 준비하지만, 다중파일 UI는 false를 사용해 파일 목록만 먼저 보여준다.
 */
export async function hydrateManualData(loadRaw = true): Promise<void> {
  await Promise.all([hydrateMeta(), hydrateSources()]);
  if (!loadRaw) return;
  if (sources.length > 0) await ensureManualDataset();
  else await ensureManualDataText();
}

/**
 * 레거시 호출용 단일 canonical CSV. 다중 active source가 있으면 요청 시에만 병합한다.
 * 일반 스크리닝 계산은 ensureManualDataset()에서 파일 배열을 직접 파싱해 이 큰 문자열을 만들지 않는다.
 */
export async function ensureManualDataText(): Promise<string | null> {
  await Promise.all([hydrateMeta(), hydrateSources()]);
  if (sources.length > 0) {
    if (rawText?.trim()) return rawText;
    const validations = await Promise.all(sources.map(loadRegisteredValidation));
    const effective = new Map<string, SourceValidationResult["rows"][number]>();
    for (const validation of validations) {
      for (const row of validation.rows) {
        const key = sourceRowKey(row);
        const previous = effective.get(key);
        if (!previous) effective.set(key, row);
        else if (sourceRowFingerprint(previous) !== sourceRowFingerprint(row))
          throw new Error(`활성 스크리닝 파일 사이에 값이 다른 중복 행이 있습니다: ${row.symbol} ${row.date}`);
      }
    }
    rawText = toCanonicalCsv([...effective.values()]);
    return rawText;
  }
  if (rawText?.trim()) {
    await migrateLegacyKrJsonIfNeeded();
    return rawText;
  }
  const rawPath = file?.meta.rawPath;
  if (!rawPath) return null;
  return (rawHydration ??= readTextObject(rawPath)
    .then((text) => {
      rawText = text;
    })
    .catch((e) => {
      rawHydration = null;
      throw e;
    })).then(() => rawText);
}

export function getManualDataText() {
  return rawText ?? file?.text ?? null;
}
export function getManualDataMeta() {
  return file?.meta ?? null;
}
export function hasManualData() {
  return Boolean(sources.length > 0 || file?.meta || rawText?.trim() || file?.text?.trim());
}

export function getManualFiles(): ManualSourceFileEntry[] {
  return sources.map((source) => ({
    id: source.id,
    fileName: source.original_filename,
    bytes: source.normalized_size_bytes,
    rows: source.row_count,
    symbols: source.symbol_count,
    minDate: source.min_date,
    maxDate: source.max_date,
    savedAt: source.activated_at ?? source.created_at,
    dataHash: source.data_hash,
  }));
}

export function getManualTotalBytes() {
  return sources.reduce((sum, source) => sum + source.normalized_size_bytes, 0);
}

export async function ensureManualDataset(): Promise<ManualParseResult | null> {
  await Promise.all([hydrateMeta(), hydrateSources()]);
  if (sources.length > 0) {
    const key = sourceKey();
    if (cache?.key === key) return cache.parsed;
    const validations = await Promise.all(sources.map(loadRegisteredValidation));
    const parsed = parseManualMarketData(validations.map((validation) => validation.canonicalCsv));
    cache = { key, parsed };
    return parsed;
  }
  const text = await ensureManualDataText();
  if (!text?.trim()) return null;
  const key = `legacy:${file?.meta.savedAt ?? text.length}`;
  if (cache?.key === key) return cache.parsed;
  const parsed = parseManualMarketData(text);
  cache = { key, parsed };
  return parsed;
}

export async function saveManualDataText(
  text: string,
  fileName?: string | null,
): Promise<ManualDataMeta> {
  const result = await saveManualDataSource(text, fileName);
  return result.meta;
}

function formatInputContractFailure(report: ReturnType<typeof buildV8InputQualityReport>) {
  const invalid = report.filesInvalidRequiredColumns[0];
  if (!invalid) return "현재 Toss+KRX 입력 계약을 충족하지 않습니다.";
  const details = [
    ...(invalid.missingColumns.length
      ? [`누락 열: ${invalid.missingColumns.join(", ")}`]
      : []),
    ...(invalid.emptyColumns.length
      ? [`전체 공란 필수 열: ${invalid.emptyColumns.join(", ")}`]
      : []),
  ];
  return `현재 Toss+KRX 입력 계약(${report.contractVersion}) 불충족 — ${details.join(" / ")}`;
}

async function persistRegistryMeta(lastFileName: string | null) {
  const oldRawPath = file?.meta.rawPath ?? null;
  const totalBytes = getManualTotalBytes();
  const now = new Date().toISOString();
  const meta: ManualDataMeta = {
    savedAt: now,
    fileName: sources.length <= 1 ? lastFileName : `${sources.length}개 파일`,
    chars: totalBytes,
    rawPath: null,
    dataHash: sources.length === 1 ? sources[0]!.data_hash : null,
    schemaHash: sources.length === 1 ? sources[0]!.schema_hash : null,
    normalizedBytes: totalBytes,
    sourceContractVersion: V8_INPUT_CONTRACT_VERSION,
  };
  const next: CloudFile<ManualDataMeta> = { text: "", meta };
  await writeFile("kr", next);
  file = next;
  metaHydration = Promise.resolve();
  rawHydration = null;
  if (oldRawPath) await Promise.allSettled([removeObjects([oldRawPath])]);
  return meta;
}

/**
 * 한 파일을 기존 screening active source에 추가한다. 파일별 45MB 제한은 source validator가 유지하며
 * 파일 개수에는 별도 제한을 두지 않는다. 서로 값이 다른 동일 종목·거래일은 append 단계에서 거부한다.
 */
export async function appendManualDataSource(
  source: Blob | string,
  fileName?: string | null,
): Promise<{ meta: ManualDataMeta; registration: SourceRegistrationResult }> {
  const filename = fileName ?? "붙여넣기.csv";
  const blob = typeof source === "string" ? new Blob([source], { type: "text/csv" }) : source;
  const validation = await validateSourceBlob(blob, filename);
  if (!validation.valid)
    throw new Error(
      `원천데이터 검증 실패: ${validation.errors
        .slice(0, 5)
        .map((item) => item.message)
        .join(" / ")}`,
    );

  const inputQuality = buildV8InputQualityReport([{ fileName: filename, validation }]);
  if (!inputQuality.validForV8) throw new Error(formatInputContractFailure(inputQuality));

  const registration = await registerSourceBlob({
    blob,
    filename,
    sourceType: "screening",
    mode: "append",
    origin: "web",
  });

  sourceValidationCache.set(registration.source.id, validation);
  await refreshSources();
  rawText = null;
  cache = null;
  const meta = await persistRegistryMeta(fileName ?? filename);
  return { meta, registration };
}

/** 기존 단일 업로드 API 호환. 이제 replace가 아니라 append 후 전체 active 파일을 함께 파싱한다. */
export async function saveManualDataSource(
  source: Blob | string,
  fileName?: string | null,
): Promise<{
  meta: ManualDataMeta;
  parsed: ManualParseResult;
  registration: SourceRegistrationResult;
}> {
  const added = await appendManualDataSource(source, fileName);
  const parsed = await ensureManualDataset();
  if (!parsed) throw new Error("스크리닝 데이터를 합쳐 해석하지 못했습니다.");
  return { ...added, parsed };
}

export async function removeManualDataSource(sourceId: string) {
  await hydrateSources();
  const target = sources.find((source) => source.id === sourceId);
  if (!target) return false;
  await removeRegisteredSource(sourceId);
  sourceValidationCache.delete(sourceId);
  await refreshSources();
  rawText = null;
  cache = null;
  if (sources.length === 0) {
    const oldRawPath = file?.meta.rawPath ?? null;
    await Promise.allSettled([
      removeFile("kr"),
      ...(oldRawPath ? [removeObjects([oldRawPath])] : []),
    ]);
    file = null;
    metaHydration = null;
    rawHydration = null;
  } else {
    await persistRegistryMeta(sources.at(-1)?.original_filename ?? null);
  }
  return true;
}

export async function clearManualData() {
  await Promise.all([hydrateMeta(), hydrateSources()]);
  await Promise.all(sources.map((source) => removeRegisteredSource(source.id)));
  const rawPath = file?.meta.rawPath ?? (await ownerPath(RAW_SCREENING_RELATIVE_PATH));
  await Promise.allSettled([removeFile("kr"), removeObjects([rawPath])]);
  file = null;
  rawText = null;
  sources = [];
  cache = null;
  sourceValidationCache.clear();
  metaHydration = null;
  rawHydration = null;
  sourceHydration = null;
}

export function getManualDataset(): ManualParseResult | null {
  if (cache) return cache.parsed;
  if (sources.length > 0) return null;
  const text = getManualDataText();
  if (!text?.trim()) return null;
  const parsed = parseManualMarketData(text);
  cache = { key: `legacy:${file?.meta.savedAt ?? text.length}`, parsed };
  return parsed;
}

export const MANUAL_DATA_MISSING_MESSAGE =
  "저장된 시세 데이터가 없습니다. 데이터 탭에서 CSV를 업로드하고 스크리닝을 시작해 주세요.";
