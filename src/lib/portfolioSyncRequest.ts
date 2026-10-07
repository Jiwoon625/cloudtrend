export const PORTFOLIO_SYNC_TIMEOUT_MS = 180_000;
export const PORTFOLIO_SYNC_TIMEOUT_MESSAGE =
  "전략·시세 동기화 응답을 기다리는 시간이 초과되었습니다. 서버 작업은 계속될 수 있으므로 동기화를 다시 누르지 말고 원장을 새로고침해 결과를 확인해 주세요.";

/** Bound only explicit model synchronization. Never wrap or replay actual execution writes. */
export async function waitForPortfolioSync<T>(
  sync: () => Promise<T>,
  timeoutMs = PORTFOLIO_SYNC_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      sync(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(PORTFOLIO_SYNC_TIMEOUT_MESSAGE)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
