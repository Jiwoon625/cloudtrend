import { parseUsMarketData, type UsParseResult } from "@/lib/engine/usDataset";
import { readFile, writeFile, removeFile, type CloudFile } from "@/lib/cloud";
export interface UsDataMeta {
  savedAt: string;
  fileName: string | null;
  chars: number;
}
let file: CloudFile<UsDataMeta> | null = null;
let hydration: Promise<void> | null = null;
let cache: UsParseResult | null = null;
export function hydrateUsData(): Promise<void> {
  return (hydration ??= readFile<UsDataMeta>("us")
    .then((v) => {
      file = v;
    })
    .catch((e) => {
      hydration = null;
      throw e;
    }));
}
export function getUsDataText() {
  return file?.text ?? null;
}
export function getUsDataMeta() {
  return file?.meta ?? null;
}
export async function saveUsDataText(text: string, fileName?: string | null): Promise<UsDataMeta> {
  const next = {
    text,
    meta: { savedAt: new Date().toISOString(), fileName: fileName ?? null, chars: text.length },
  };
  await writeFile("us", next);
  file = next;
  cache = null;
  hydration = Promise.resolve();
  return next.meta;
}
export async function clearUsData() {
  await removeFile("us");
  file = null;
  cache = null;
}
export function getUsDataset(): UsParseResult | null {
  if (!file?.text.trim()) return null;
  return (cache ??= parseUsMarketData(file.text));
}
export const US_DATA_MISSING_MESSAGE =
  "저장된 시세 데이터가 없습니다. 데이터 탭에서 CSV를 업로드하고 스크리닝을 시작해 주세요.";
