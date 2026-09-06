// 대용량 입력 데이터 보관용 IndexedDB 키-값 저장소.
// localStorage는 브라우저별로 약 5MB 제한이 있어 수백 종목 일봉 CSV를 담지 못한다.
// IndexedDB는 보통 수백 MB~수 GB(디스크 여유의 일부)까지 저장할 수 있다.
const DB_NAME = "cloudtrend";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    return Promise.reject(new Error("IndexedDB를 사용할 수 없습니다."));
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = window.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB 열기 실패"));
    });
  }
  return dbPromise;
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB 요청 실패"));
      }),
  );
}

export async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const value = await tx<unknown>("readonly", (s) => s.get(key) as IDBRequest<unknown>);
    return (value as T | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  await tx("readwrite", (s) => s.put(value, key) as IDBRequest<unknown>);
}

export async function idbDel(key: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(key) as IDBRequest<undefined>);
  } catch {
    /* 무시 */
  }
}

/** 브라우저에 영구 저장 권한을 요청한다(할당량 축소·자동 정리 방지). */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** 브라우저가 알려주는 저장 용량(사용량/할당량). 지원하지 않으면 null. */

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
