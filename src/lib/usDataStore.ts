// TrendScore US — 이용자가 직접 입력한 미국 시장 데이터 보관소(브라우저 localStorage).
// 한국 시장 입력(trendscore.manualMarketData.v1)과 완전히 분리해 서로 영향을 주지 않는다.
import { parseUsMarketData, type UsParseResult } from "@/lib/engine/usDataset";

const KEY = "trendscore.usMarketData.v1";
const META_KEY = "trendscore.usMarketData.meta.v1";

export interface UsDataMeta {
  savedAt: string;
  fileName: string | null;
  chars: number;
}

export function getUsDataText(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}

export function getUsDataMeta(): UsDataMeta | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UsDataMeta;
  } catch {
    return null;
  }
}

export function saveUsDataText(text: string, fileName?: string | null): UsDataMeta {
  const meta: UsDataMeta = {
    savedAt: new Date().toISOString(),
    fileName: fileName ?? null,
    chars: text.length,
  };
  window.localStorage.setItem(KEY, text);
  window.localStorage.setItem(META_KEY, JSON.stringify(meta));
  cache = null;
  return meta;
}

export function clearUsData(): void {
  window.localStorage.removeItem(KEY);
  window.localStorage.removeItem(META_KEY);
  cache = null;
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
