/**
 * Mutable pointers(`latest.json.gz`, `input-head/latest.json`)는 CDN을 우회해 읽어야 하므로
 * 매 호출이 uncached egress가 된다. 한 번의 차트 요청이 같은 포인터를 여러 번 읽거나
 * 동시 요청이 겹치면 같은 바이트를 반복해서 받게 되므로, 짧은 시간 동안만 결과를 재사용한다.
 *
 * - 값은 프로세스 메모리에만 두고 경로별로 TTL이 지나면 다시 읽는다(게시 직후 신선도 유지).
 * - 진행 중인 동일 읽기는 하나로 합쳐 동시 요청이 같은 다운로드를 공유하게 한다.
 * - null(객체 없음)도 함께 기억해, 게시 전 반복 조회가 매번 404 왕복을 만들지 않게 한다.
 */
interface Entry {
  at: number;
  value: unknown;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const MAX_ENTRIES = 128;

/** 이 값보다 오래된 항목은 다음 조회에서 버린다. 게시 주기(하루 2회)에 비해 충분히 짧다. */
export const FRESH_POINTER_TTL_MS = 20_000;

export async function readFreshPointerOnce<T>(
  key: string,
  read: () => Promise<T>,
  ttlMs = FRESH_POINTER_TTL_MS,
): Promise<T> {
  const cached = entries.get(key);
  if (cached && Date.now() - cached.at < ttlMs) return cached.value as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const promise = read()
    .then((value) => {
      entries.set(key, { at: Date.now(), value });
      if (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** 테스트가 프로세스 전역 상태를 초기화할 때 쓴다. */
export function resetFreshPointerCache() {
  entries.clear();
  inflight.clear();
}
