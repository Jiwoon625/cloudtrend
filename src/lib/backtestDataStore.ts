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
import {
  listRegisteredSources,
  registerSourceBlob,
  removeRegisteredSource,
} from "@/lib/sourceRegistry";
import { compareSourceRows, validateSourceBlob, validateSourceText } from "@/lib/sourceData";

export interface BacktestDataMeta {
  savedAt: string;
  fileName: string | null;
  bytes: number;
}
export interface BacktestFileEntry extends BacktestDataMeta {
  /** 저장 경로의 파일 이름(확장자 제외). 삭제·조회 키로 쓴다. */
  id: string;
  /** 신규 원천데이터 registry ID. 기존 파일에는 없을 수 있다. */
  sourceId?: string;
  dataHash?: string;
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

/** 재현성 번들에 기록할 입력 파일 목록. 원문이나 인증정보는 포함하지 않는다. */
export function getBacktestDataVersionFiles(): BacktestFileEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export async function addBacktestFile(
  source: Blob | string,
  fileName?: string | null,
): Promise<BacktestFileEntry> {
  const filename = fileName ?? "붙여넣기.csv";
  const blob = typeof source === "string" ? new Blob([source], { type: "text/csv" }) : source;
  const bytes = blob.size;
  if (bytes > MAX_FILE_BYTES)
    throw new Error("파일 1개 크기는 45MB 이하여야 합니다. 파일을 나눠 여러 개로 올려 주세요.");
  const validation = await validateSourceBlob(blob, filename);
  if (!validation.valid)
    throw new Error(
      `원천데이터 검증 실패: ${validation.errors
        .slice(0, 5)
        .map((item) => item.message)
        .join(" / ")}`,
    );
  await hydrateBacktestData();
  const existingValidated = await Promise.all(
    entries.map(async (entry) => {
      const currentText = await fileText(entry.id);
      if (!currentText?.trim())
        throw new Error(`기존 백테스트 파일을 불러오지 못했습니다: ${entry.fileName ?? entry.id}`);
      const current = await validateSourceText(currentText, entry.fileName ?? `${entry.id}.csv`);
      if (!current.valid)
        throw new Error(`기존 백테스트 파일 검증 실패: ${entry.fileName ?? entry.id}`);
      return { sourceId: entry.sourceId ?? `legacy:${entry.id}`, rows: current.rows };
    }),
  );
  const overlap = compareSourceRows(validation.rows, existingValidated);
  if (overlap.conflictingRows > 0) {
    const examples = overlap.examples
      .filter((value) => value.kind === "conflict")
      .slice(0, 3)
      .map((value) => value.key)
      .join(", ");
    throw new Error(
      `기존 장기자료와 값이 다른 종목·거래일이 ${overlap.conflictingRows}건 있습니다` +
        `${examples ? ` (${examples})` : ""}. 전체 교체 후 다시 올려 주세요.`,
    );
  }
  const registration = await registerSourceBlob({
    blob,
    filename,
    sourceType: "backtest",
    mode: "add",
    origin: "web",
  });
  const alreadyIndexed = entries.find((value) => value.id === registration.source.id);
  if (alreadyIndexed) return alreadyIndexed;
  const entry: BacktestFileEntry = {
    id: registration.source.id,
    savedAt: new Date().toISOString(),
    fileName: fileName ?? null,
    bytes: validation.normalizedSizeBytes,
    sourceId: registration.source.id,
    dataHash: validation.dataHash,
  };
  const value: CloudFile<BacktestDataMeta> = {
    text: validation.canonicalCsv,
    meta: { savedAt: entry.savedAt, fileName: entry.fileName, bytes: entry.bytes },
  };
  try {
    await writeObject(await ownerPath(filePath(entry.id)), value);
  } catch (error) {
    if (!registration.reused) await removeRegisteredSource(registration.source.id);
    throw error;
  }
  const previousEntries = entries;
  entries = sortEntries([...entries, entry]);
  try {
    await saveIndex();
  } catch (error) {
    entries = previousEntries;
    await removeObjects([await ownerPath(filePath(entry.id))]);
    if (!registration.reused) await removeRegisteredSource(registration.source.id);
    throw error;
  }
  texts.set(entry.id, validation.canonicalCsv);
  cache = null;
  return entry;
}

export async function removeBacktestFile(id: string) {
  await hydrateBacktestData();
  const entry = entries.find((value) => value.id === id);
  if (entry?.sourceId) await removeRegisteredSource(entry.sourceId);
  await removeObjects([await ownerPath(filePath(id))]);
  entries = entries.filter((f) => f.id !== id);
  texts.delete(id);
  cache = null;
  await saveIndex();
}

export async function clearBacktestData() {
  await hydrateBacktestData();
  const registered = await listRegisteredSources("backtest", ["active"]);
  await Promise.all(registered.map((source) => removeRegisteredSource(source.id)));
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

  // 인덱스에 등록된 파일이 하나라도 실제 저장소에서 누락되면 부분 데이터로
  // 백테스트를 계속하지 않는다. 과거에는 null 파일을 filter로 조용히 버려
  // 같은 설정에서도 Universe/평균 봉수가 달라질 수 있었다.
  const loaded = await Promise.all(
    entries.map(async (entry) => ({ entry, text: await fileText(entry.id) })),
  );
  const missing = loaded.filter(({ text }) => !text || text.trim().length === 0);
  if (missing.length > 0) {
    cache = null;
    const names = missing
      .slice(0, 5)
      .map(({ entry }) => entry.fileName ?? entry.id)
      .join(", ");
    const suffix = missing.length > 5 ? ` 외 ${missing.length - 5}개` : "";
    throw new Error(
      `백테스트 장기 데이터 ${missing.length}개를 불러오지 못했습니다: ${names}${suffix}. ` +
        "부분 데이터로 계산하지 않았습니다. 파일 목록을 새로고침한 뒤 누락 파일을 다시 업로드해 주세요.",
    );
  }

  const parsed = parseManualMarketData(loaded.map(({ text }) => text!));
  cache = { key, parsed };
  return parsed;
}
