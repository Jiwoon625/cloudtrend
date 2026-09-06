// 백테스트 전용 장기 일봉 데이터 보관소.
// "데이터·산식" 탭의 스크리닝 데이터와 완전히 분리되어 있고,
// 원문은 문자열이 아닌 Blob으로 IndexedDB에 저장한다(대용량에서 메모리·직렬화 부담이 훨씬 작다).
import { parseManualMarketData, type ManualParseResult } from "@/lib/engine/manualDataset";
import { idbDel, idbGet, idbSet, requestPersistentStorage } from "@/lib/idbStore";

const BLOB_KEY = "cloudtrend.backtestMarketData.blob.v1";
const META_KEY = "cloudtrend.backtestMarketData.meta.v1";

export interface BacktestDataMeta {
  savedAt: string;
  fileName: string | null;
  bytes: number;
}

let memMeta: BacktestDataMeta | null = null;
let hydrated = false;
let hydrating: Promise<void> | null = null;
let cache: ManualParseResult | null = null;

export function hydrateBacktestData(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (hydrated) return Promise.resolve();
  if (!hydrating) {
    hydrating = (async () => {
      memMeta = await idbGet<BacktestDataMeta>(META_KEY);
      hydrated = true;
    })();
  }
  return hydrating;
}

export function getBacktestDataMeta(): BacktestDataMeta | null {
  return memMeta;
}

/** 파일(또는 붙여넣은 텍스트)을 백테스트 전용 데이터로 저장한다. */
export async function saveBacktestData(
  source: Blob | string,
  fileName?: string | null,
): Promise<BacktestDataMeta> {
  const blob = typeof source === "string" ? new Blob([source], { type: "text/csv" }) : source;
  await requestPersistentStorage();
  const meta: BacktestDataMeta = {
    savedAt: new Date().toISOString(),
    fileName: fileName ?? null,
    bytes: blob.size,
  };
  await idbSet(BLOB_KEY, blob);
  await idbSet(META_KEY, meta);
  memMeta = meta;
  hydrated = true;
  cache = null;
  return meta;
}

export async function clearBacktestData(): Promise<void> {
  memMeta = null;
  hydrated = true;
  cache = null;
  await Promise.all([idbDel(BLOB_KEY), idbDel(META_KEY)]);
}

/** 저장된 백테스트 데이터를 파싱한다. 저장된 데이터가 없으면 null. */
export async function loadBacktestDataset(): Promise<ManualParseResult | null> {
  await hydrateBacktestData();
  if (cache) return cache;
  const blob = await idbGet<Blob>(BLOB_KEY);
  if (!blob) return null;
  const text = await blob.text();
  const parsed = parseManualMarketData(text);
  cache = parsed;
  return parsed;
}
