import { parseManualMarketData, type ManualParseResult } from "@/lib/engine/manualDataset";
import {
  MAX_FILE_BYTES,
  ownerPath,
  readFile,
  readObject,
  removeObjects,
  writeObject,
  type CloudFile,
} from "@/lib/cloud";

export interface BacktestDataMeta {
  savedAt: string;
  fileName: string | null;
  bytes: number;
}
export interface BacktestFileEntry extends BacktestDataMeta {
  /** 저장 경로의 파일 이름(확장자 제외). 삭제·조회 키로 쓴다. */
  id: string;
}
interface BacktestIndex {
  files: BacktestFileEntry[];
}

const INDEX_NAME = "backtest/index.json";
const LEGACY_ID = "__legacy__";

let entries: BacktestFileEntry[] = [];
let hydration: Promise<void> | null = null;
let cache: { key: string; parsed: ManualParseResult } | null = null;
/** 이미 내려받은 파일 본문 캐시(경로 → 텍스트). */
const texts = new Map<string, string>();

function filePath(id: string) {
  return id === LEGACY_ID ? "backtest.json" : `backtest/${id}.json`;
}

function sortEntries(list: BacktestFileEntry[]) {
  return [...list].sort((a, b) => a.savedAt.localeCompare(b.savedAt));
}

async function loadIndex(): Promise<BacktestFileEntry[]> {
  const index = await readObject<BacktestIndex>(await ownerPath(INDEX_NAME));
  const list = index?.files ?? [];
  // 예전 단일 파일(backtest.json)도 목록에 포함한다.
  if (!list.some((f) => f.id === LEGACY_ID)) {
    const legacy = await readFile<BacktestDataMeta>("backtest");
    if (legacy)
      list.push({
        id: LEGACY_ID,
        savedAt: legacy.meta?.savedAt ?? new Date(0).toISOString(),
        fileName: legacy.meta?.fileName ?? "기존 파일",
        bytes: legacy.meta?.bytes ?? new Blob([legacy.text]).size,
      });
  }
  return sortEntries(list);
}

async function saveIndex() {
  const files = entries.filter((f) => f.id !== LEGACY_ID);
  await writeObject(await ownerPath(INDEX_NAME), { files } satisfies BacktestIndex);
}

export function hydrateBacktestData(): Promise<void> {
  return (hydration ??= loadIndex()
    .then((list) => {
      entries = list;
    })
    .catch((e) => {
      hydration = null;
      throw e;
    }));
}

export function getBacktestFiles(): BacktestFileEntry[] {
  return entries;
}

/** 이전 단일 파일 UI 호환용: 가장 최근 파일 정보. */
export function getBacktestDataMeta(): BacktestDataMeta | null {
  return entries.at(-1) ?? null;
}

export function getBacktestTotalBytes(): number {
  return entries.reduce((sum, f) => sum + f.bytes, 0);
}

export async function addBacktestFile(
  source: Blob | string,
  fileName?: string | null,
): Promise<BacktestFileEntry> {
  const text = typeof source === "string" ? source : await source.text();
  const bytes = new Blob([text]).size;
  if (bytes > MAX_FILE_BYTES)
    throw new Error("파일 1개 크기는 45MB 이하여야 합니다. 파일을 나눠 여러 개로 올려 주세요.");
  await hydrateBacktestData();
  const entry: BacktestFileEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: new Date().toISOString(),
    fileName: fileName ?? null,
    bytes,
  };
  const value: CloudFile<BacktestDataMeta> = {
    text,
    meta: { savedAt: entry.savedAt, fileName: entry.fileName, bytes: entry.bytes },
  };
  await writeObject(await ownerPath(filePath(entry.id)), value);
  entries = sortEntries([...entries, entry]);
  await saveIndex();
  texts.set(entry.id, text);
  cache = null;
  return entry;
}

export async function removeBacktestFile(id: string) {
  await hydrateBacktestData();
  await removeObjects([await ownerPath(filePath(id))]);
  entries = entries.filter((f) => f.id !== id);
  texts.delete(id);
  cache = null;
  await saveIndex();
}

export async function clearBacktestData() {
  await hydrateBacktestData();
  const paths = await Promise.all(entries.map((f) => ownerPath(filePath(f.id))));
  await removeObjects(paths);
  entries = [];
  texts.clear();
  cache = null;
  await saveIndex();
}

async function fileText(id: string): Promise<string | null> {
  const cached = texts.get(id);
  if (cached !== undefined) return cached;
  const value = await readObject<CloudFile<BacktestDataMeta>>(await ownerPath(filePath(id)));
  if (!value?.text) return null;
  texts.set(id, value.text);
  return value.text;
}

/** 계정에 저장된 모든 백테스트 파일을 하나의 데이터셋으로 합쳐서 돌려준다. */
export async function loadBacktestDataset(): Promise<ManualParseResult | null> {
  await hydrateBacktestData();
  if (entries.length === 0) return null;
  const key = entries.map((f) => `${f.id}:${f.bytes}`).join("|");
  if (cache?.key === key) return cache.parsed;
  const loaded = (await Promise.all(entries.map((f) => fileText(f.id)))).filter(
    (t): t is string => !!t && t.trim().length > 0,
  );
  if (loaded.length === 0) return null;
  const parsed = parseManualMarketData(loaded);
  cache = { key, parsed };
  return parsed;
}
