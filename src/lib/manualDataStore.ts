import { parseManualMarketData, type ManualParseResult } from "@/lib/engine/manualDataset";
import { readFile, writeFile, removeFile, type CloudFile } from "@/lib/cloud";
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
}
let file: CloudFile<ManualDataMeta> | null = null;
let hydration: Promise<void> | null = null;
let cache: ManualParseResult | null = null;
export function hydrateManualData(): Promise<void> {
  return (hydration ??= readFile<ManualDataMeta>("kr")
    .then((v) => {
      file = v;
    })
    .catch((e) => {
      hydration = null;
      throw e;
    }));
}
export function getManualDataText() {
  return file?.text ?? null;
}
export function getManualDataMeta() {
  return file?.meta ?? null;
}
export async function saveManualDataText(
  text: string,
  fileName?: string | null,
): Promise<ManualDataMeta> {
  const next = {
    text,
    meta: { savedAt: new Date().toISOString(), fileName: fileName ?? null, chars: text.length },
  };
  await writeFile("kr", next);
  file = next;
  cache = null;
  hydration = Promise.resolve();
  return next.meta;
}

/** 원본 파일을 검증·등록하고 기존 웹용 kr.json도 같은 정규화 CSV로 갱신한다. */
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
  const parsed = parseManualMarketData(validation.canonicalCsv);
  const previous = file;
  const next: CloudFile<ManualDataMeta> = {
    text: validation.canonicalCsv,
    meta: {
      savedAt: new Date().toISOString(),
      fileName: fileName ?? null,
      chars: validation.canonicalCsv.length,
    },
  };
  await writeFile("kr", next);
  let registration: SourceRegistrationResult;
  try {
    registration = await registerSourceBlob({
      blob,
      filename,
      sourceType: "screening",
      mode: "replace",
      origin: "web",
    });
  } catch (error) {
    if (previous) await writeFile("kr", previous);
    else await removeFile("kr");
    throw error;
  }
  file = next;
  cache = parsed;
  hydration = Promise.resolve();
  return { meta: next.meta, parsed, registration };
}

export async function clearManualData() {
  const sources = await listRegisteredSources("screening", ["active"]);
  await Promise.all(sources.map((source) => removeRegisteredSource(source.id)));
  await removeFile("kr");
  file = null;
  cache = null;
}
export function getManualDataset(): ManualParseResult | null {
  if (!file?.text.trim()) return null;
  return (cache ??= parseManualMarketData(file.text));
}
export const MANUAL_DATA_MISSING_MESSAGE =
  "저장된 시세 데이터가 없습니다. 데이터 탭에서 CSV를 업로드하고 스크리닝을 시작해 주세요.";
