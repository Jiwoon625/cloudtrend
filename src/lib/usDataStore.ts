// CloudTrend US — 이용자가 직접 입력한 미국 시장 데이터 보관소.
// 한국 시장 입력과 완전히 분리된 키를 쓰며, 원문은 IndexedDB에 저장한다(대용량 지원).
import { parseUsMarketData, type UsParseResult } from "@/lib/engine/usDataset";
import { idbDel, idbGet, idbSet } from "@/lib/idbStore";

const KEY = "trendscore.usMarketData.v1";
const META_KEY = "trendscore.usMarketData.meta.v1";

export interface UsDataMeta {
  savedAt: string;
  fileName: string | null;
  chars: number;
}

let memText: string | null = null;
let memMeta: UsDataMeta | null = null;
let hydrated = false;
let hydrating: Promise<void> | null = null;

export function hydrateUsData(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (hydrated) return Promise.resolve();
  if (!hydrating) {
    hydrating = (async () => {
      const [text, meta] = await Promise.all([idbGet<string>(KEY), idbGet<UsDataMeta>(META_KEY)]);
      if (text) {
        memText = text;
        memMeta = meta ?? null;
      } else {
        const legacy = window.localStorage.getItem(KEY);
        if (legacy) {
          const rawMeta = window.localStorage.getItem(META_KEY);
          memText = legacy;
          memMeta = rawMeta ? (JSON.parse(rawMeta) as UsDataMeta) : null;
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

export function getUsDataText(): string | null {
  return memText;
}

export function getUsDataMeta(): UsDataMeta | null {
  return memMeta;
}

export async function saveUsDataText(
  text: string,
  fileName?: string | null,
): Promise<UsDataMeta> {
  const meta: UsDataMeta = {
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

export async function clearUsData(): Promise<void> {
  memText = null;
  memMeta = null;
  cache = null;
  hydrated = true;
  window.localStorage.removeItem(KEY);
  window.localStorage.removeItem(META_KEY);
  await Promise.all([idbDel(KEY), idbDel(META_KEY)]);
}

let cache: { text: string; result: UsParseResult } | null = null;

/** 저장된 미국 시장 입력을 파싱한다. 없으면 null, 형식 오류는 Error. */
export function getUsDataset(): UsParseResult | null {
  const text = getUsDataText();
  if (!text || text.trim().length === 0) return null;
  if (cache && cache.text === text) return cache.result;
  const result = parseUsMarketData(text);
  cache = { text, result };
  return result;
}

export const US_DATA_MISSING_MESSAGE =
  "미국 시장 입력 데이터가 없습니다. “US 데이터” 탭에서 토스증권 Open API로 조회한 미국 종목 일봉을 붙여넣거나 CSV로 업로드한 뒤 “US 스크리닝 시작”을 눌러 주세요.";
