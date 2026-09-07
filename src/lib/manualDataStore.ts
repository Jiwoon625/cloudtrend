import { parseManualMarketData, type ManualParseResult } from "@/lib/engine/manualDataset";
import { readFile, writeFile, removeFile, type CloudFile } from "@/lib/cloud";
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
export async function clearManualData() {
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
