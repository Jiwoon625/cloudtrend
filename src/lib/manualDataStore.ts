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
  type CloudFile,
  writeFile,
  writeTextObject,
} from "@/lib/cloud";
import {
  listRegisteredSources,
  registerSourceBlob,
  removeRegisteredSource,
  type SourceRegistrationResult,
} from "@/lib/sourceRegistry";
import { validateSourceBlob } from "@/lib/sourceData";

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

const RAW_SCREENING_RELATIVE_PATH = "raw/screening/latest.csv";
let file: CloudFile<ManualDataMeta> | null = null;
let metaHydration: Promise<void> | null = null;
let rawHydration: Promise<void> | null = null;
let rawText: string | null = null;
let cache: ManualParseResult | null = null;

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

async function migrateLegacyKrJsonIfNeeded() {
  if (!file?.text?.trim() || file.meta.rawPath) return;
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

/**
 * 기본값은 기존 호출과 호환되도록 raw 본문까지 복원한다.
 * 대시보드/스크리너는 결과 cache를 직접 사용하므로 원천 본문을 읽을 필요가 없다.
 */
export async function hydrateManualData(loadRaw = true): Promise<void> {
  await hydrateMeta();
  if (loadRaw) await ensureManualDataText();
}

export async function ensureManualDataText(): Promise<string | null> {
  await hydrateMeta();
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
  return Boolean(file?.meta || rawText?.trim() || file?.text?.trim());
}

export async function ensureManualDataset(): Promise<ManualParseResult | null> {
  if (cache) return cache;
  const text = await ensureManualDataText();
  if (!text?.trim()) return null;
  return (cache = parseManualMarketData(text));
}

export async function saveManualDataText(
  text: string,
  fileName?: string | null,
): Promise<ManualDataMeta> {
  const rawPath = await ownerPath(RAW_SCREENING_RELATIVE_PATH);
  await writeTextObject(rawPath, text);
  const meta: ManualDataMeta = {
    savedAt: new Date().toISOString(),
    fileName: fileName ?? null,
    chars: text.length,
    rawPath,
    normalizedBytes: new TextEncoder().encode(text).byteLength,
  };
  const next: CloudFile<ManualDataMeta> = { text: "", meta };
  await writeFile("kr", next);
  file = next;
  rawText = text;
  cache = null;
  metaHydration = Promise.resolve();
  rawHydration = Promise.resolve();
  return meta;
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

/** 원본 파일을 검증·등록하고 canonical CSV는 raw/screening/latest.csv에 별도 저장한다. */
export async function saveManualDataSource(
  source: Blob | string,
  fileName?: string | null,
): Promise<{
  meta: ManualDataMeta;
  parsed: ManualParseResult;
  registration: SourceRegistrationResult;
}> {
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

  // 메인 데이터/산식 업로드도 장기 백테스트와 동일한 toss-krx-102 입력 계약을 적용한다.
  // STOCK이 들어 있는 파일은 market과 foreignNetBuyValue를 반드시 포함해야 하며,
  // 개별 행의 외국인 결측은 0으로 치환하지 않고 parser에서 null로 유지한다.
  const inputQuality = buildV8InputQualityReport([{ fileName: filename, validation }]);
  if (!inputQuality.validForV8) throw new Error(formatInputContractFailure(inputQuality));

  const parsed = parseManualMarketData(validation.canonicalCsv);
  const registration = await registerSourceBlob({
    blob,
    filename,
    sourceType: "screening",
    mode: "replace",
    origin: "web",
  });

  const rawPath = await ownerPath(RAW_SCREENING_RELATIVE_PATH);
  await writeTextObject(rawPath, validation.canonicalCsv);
  const meta: ManualDataMeta = {
    savedAt: new Date().toISOString(),
    fileName: fileName ?? null,
    chars: validation.canonicalCsv.length,
    rawPath,
    dataHash: registration.source.data_hash,
    schemaHash: registration.source.schema_hash,
    normalizedBytes: validation.normalizedSizeBytes,
    sourceContractVersion: V8_INPUT_CONTRACT_VERSION,
  };
  const next: CloudFile<ManualDataMeta> = { text: "", meta };
  await writeFile("kr", next);
  file = next;
  rawText = validation.canonicalCsv;
  cache = parsed;
  metaHydration = Promise.resolve();
  rawHydration = Promise.resolve();
  return { meta, parsed, registration };
}

export async function clearManualData() {
  const sources = await listRegisteredSources("screening", ["active"]);
  await Promise.all(sources.map((source) => removeRegisteredSource(source.id)));
  const rawPath = file?.meta.rawPath ?? (await ownerPath(RAW_SCREENING_RELATIVE_PATH));
  await Promise.allSettled([removeFile("kr"), removeObjects([rawPath])]);
  file = null;
  rawText = null;
  cache = null;
  metaHydration = null;
  rawHydration = null;
}

export function getManualDataset(): ManualParseResult | null {
  if (cache) return cache;
  const text = getManualDataText();
  if (!text?.trim()) return null;
  return (cache = parseManualMarketData(text));
}

export const MANUAL_DATA_MISSING_MESSAGE =
  "저장된 시세 데이터가 없습니다. 데이터 탭에서 CSV를 업로드하고 스크리닝을 시작해 주세요.";