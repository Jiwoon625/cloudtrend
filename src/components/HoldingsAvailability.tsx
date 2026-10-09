/** Shared unknown/error state for the actual-or-active-Shadow holding union. */
export function HoldingsAvailability({
  ready,
  failed,
  retry,
}: {
  ready: boolean;
  failed: boolean;
  retry: () => unknown;
}) {
  if (ready) return null;
  return (
    <div role={failed ? "alert" : "status"} className="rounded-lg border p-3 text-xs">
      {failed
        ? "보유 자료 조회 실패 · 보유 및 청산 판정 미확인"
        : "보유 자료 확인 중 · 청산 판정 대기"}
      {failed ? (
        <button className="ml-2 text-primary underline" onClick={() => void retry()}>
          다시 시도
        </button>
      ) : null}
    </div>
  );
}
