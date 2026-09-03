// 사용자가 직접 입력한 시세 데이터 보관소.
// 원문 텍스트는 IndexedDB에 저장한다(localStorage 5MB 제한 회피). 메모리 미러를 두어
// 기존의 동기 API(getManualDataText/getManualDataset)를 그대로 유지한다.
import { parseManualMarketData, type ManualParseResult } from "@/lib/engine/manualDataset";
import { idbDel, idbGet, idbSet } from "@/lib/idbStore";

const KEY = "trendscore.manualMarketData.v1";
const META_KEY = "trendscore.manualMarketData.meta.v1";

export interface ManualDataMeta {
  savedAt: string;
  fileName: string | null;
  chars: number;
}

let memText: string | null = null;
let memMeta: ManualDataMeta | null = null;
let hydrated = false;
let hydrating: Promise<void> | null = null;

/** IndexedDB(및 예전 localStorage)에서 저장된 입력을 메모리로 불러온다. */
export function hydrateManualData(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (hydrated) return Promise.resolve();
  if (!hydrating) {
    hydrating = (async () => {
      const [text, meta] = await Promise.all([
        idbGet<string>(KEY),
        idbGet<ManualDataMeta>(META_KEY),
      ]);
      if (text) {
        memText = text;
        memMeta = meta ?? null;
      } else {
        // 예전 버전(localStorage)에 저장된 데이터가 있으면 옮겨온다.
        const legacy = window.localStorage.getItem(KEY);
        if (legacy) {
          const rawMeta = window.localStorage.getItem(META_KEY);
          memText = legacy;
          memMeta = rawMeta ? (JSON.parse(rawMeta) as ManualDataMeta) : null;
          await idbSet(KEY, legacy);
          if (memMeta) await idbSet(META_KEY, memMeta);
          window.localStorage.removeItem(KEY);
          window.localStorage.removeItem(META_KEY);
        }
      }
      hydrated = true;
    })();
  }
  return hydrating;
}

export function getManualDataText(): string | null {
  return memText;
}

export function getManualDataMeta(): ManualDataMeta | null {
  return memMeta;
}

export async function saveManualDataText(
  text: string,
  fileName?: string | null,
): Promise<ManualDataMeta> {
  const meta: ManualDataMeta = {
    savedAt: new Date().toISOString(),
    fileName: fileName ?? null,
    chars: text.length,
  };
  memText = text;
  memMeta = meta;
  cache = null;
  hydrated = true;
  await idbSet(KEY, text);
  await idbSet(META_KEY, meta);
  return meta;
}

export async function clearManualData(): Promise<void> {
  memText = null;
  memMeta = null;
  cache = null;
  hydrated = true;
  window.localStorage.removeItem(KEY);
  window.localStorage.removeItem(META_KEY);
  await Promise.all([idbDel(KEY), idbDel(META_KEY)]);
}

let cache: { text: string; result: ManualParseResult } | null = null;

/** 저장된 입력 데이터를 파싱한다. 저장된 데이터가 없으면 null. 형식 오류는 Error. */
export function getManualDataset(): ManualParseResult | null {
  const text = getManualDataText();
  if (!text || text.trim().length === 0) return null;
  if (cache && cache.text === text) return cache.result;
  const result = parseManualMarketData(text);
  cache = { text, result };
  return result;
}

export const MANUAL_DATA_MISSING_MESSAGE =
  "직접 입력한 시세 데이터가 없습니다. 대시보드 첫 화면에서 토스증권 Open API로 조회한 데이터를 붙여넣거나 CSV로 업로드한 뒤 “스크리닝 시작”을 눌러 주세요.";
