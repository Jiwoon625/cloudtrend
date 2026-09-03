// 사용자가 직접 입력한 시세 데이터 보관소(브라우저 localStorage).
// 원문 텍스트만 저장하고, 필요할 때 파싱해 MarketDataset을 만든다.
import { parseManualMarketData, type ManualParseResult } from "@/lib/engine/manualDataset";

const KEY = "trendscore.manualMarketData.v1";
const META_KEY = "trendscore.manualMarketData.meta.v1";

export interface ManualDataMeta {
  savedAt: string;
  fileName: string | null;
  chars: number;
}

export function getManualDataText(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}

export function getManualDataMeta(): ManualDataMeta | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ManualDataMeta;
  } catch {
    return null;
  }
}

export function saveManualDataText(text: string, fileName?: string | null): ManualDataMeta {
  const meta: ManualDataMeta = {
    savedAt: new Date().toISOString(),
    fileName: fileName ?? null,
    chars: text.length,
  };
  window.localStorage.setItem(KEY, text);
  window.localStorage.setItem(META_KEY, JSON.stringify(meta));
  cache = null;
  return meta;
}

export function clearManualData(): void {
  window.localStorage.removeItem(KEY);
  window.localStorage.removeItem(META_KEY);
  cache = null;
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
