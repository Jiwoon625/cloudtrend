import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** A draft keeps the revision it was opened against, even after a background read. */
export type LedgerEditSession = { revision: number | undefined; needsReview: boolean };
export type LedgerWriteGuard = { pending: boolean; needsReload: boolean };
export const createLedgerWriteGuard = (): LedgerWriteGuard => ({
  pending: false,
  needsReload: false,
});
export const createLedgerEditSession = (revision: number | undefined): LedgerEditSession => ({
  revision,
  needsReview: false,
});
export const LEDGER_RECONCILE_MESSAGE =
  "저장 결과가 확실하지 않습니다. 입력 내용은 유지했습니다. 새로고침 후 거래내역·설정을 대조하고, 이 입력을 닫은 뒤 다시 열어 주세요. 확인 없이 다시 입력하면 중복 체결이 생길 수 있습니다.";
export const LEDGER_CASH_NOTE =
  "현금·평가자산은 설정한 운용자금 기준 계산값입니다. 기초 현금·입출금·결제 내역이 확인되지 않아 증권사 잔고나 주문 가능 금액으로 사용할 수 없습니다.";

const LEDGER_READ_KEYS = [
  ["portfolio-ledgers"],
  ["us-actual-ledger"],
  ["portfolio-ledgers-overview"],
  ["dashboard-operations"],
];

/** Both cancellations matter: another view may start a read while the write is in flight. */
export async function cancelLedgerReads(client: QueryClient) {
  await Promise.all(LEDGER_READ_KEYS.map((queryKey) => client.cancelQueries({ queryKey })));
}
export async function invalidateLedgerReads(
  client: QueryClient,
  refetchType: "active" | "none" = "active",
) {
  await Promise.all(
    LEDGER_READ_KEYS.map((queryKey) => client.invalidateQueries({ queryKey, refetchType })),
  );
}

/** No automatic replay: the legacy API has no idempotency key for new executions. */
export async function runLedgerWrite<T extends { revision: number }>({
  guard,
  session,
  client,
  queryKey,
  request,
  onBusy,
  onError,
  waitForReadRefresh = true,
}: {
  guard: LedgerWriteGuard;
  session: LedgerEditSession;
  client: QueryClient;
  queryKey: QueryKey;
  request: (revision: number) => Promise<T>;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
  waitForReadRefresh?: boolean;
}): Promise<boolean> {
  if (guard.pending || guard.needsReload || session.needsReview) return false;
  if (session.revision === undefined) {
    onError("원장을 먼저 새로고침한 뒤 입력을 다시 열어 주세요.");
    return false;
  }
  // Synchronous, before any await or React render: two same-tick clicks send one write.
  guard.pending = true;
  onBusy(true);
  try {
    await cancelLedgerReads(client);
    const next = await request(session.revision);
    await cancelLedgerReads(client);
    client.setQueryData<T>(queryKey, (previous) =>
      previous && previous.revision > next.revision ? previous : next,
    );
    const refreshing = invalidateLedgerReads(client);
    // A confirmed derived-data sync is complete even when another view's read is slow.
    // Each query still owns its loading/error state; real execution writes keep existing behavior.
    if (waitForReadRefresh) await refreshing;
    else void refreshing.catch(() => undefined);
    return true;
  } catch (error) {
    // A rejected/lost response is not proof that the server did not commit.
    guard.needsReload = true;
    session.needsReview = true;
    const detail = error instanceof Error ? error.message : "저장 응답을 확인하지 못했습니다.";
    onError(`${detail} ${LEDGER_RECONCILE_MESSAGE}`);
    // Keep the visible draft for review, but never leave a lost-response cache fresh forever.
    // A later Back/remount will load the canonical result; no write is automatically retried.
    await cancelLedgerReads(client);
    await invalidateLedgerReads(client, "none");
    return false;
  } finally {
    guard.pending = false;
    onBusy(false);
  }
}

/** An explicit successful read permits new drafts, never silently rebases an old one. */
export function acknowledgeLedgerReload(guard: LedgerWriteGuard, succeeded: boolean) {
  if (!guard.pending && succeeded) guard.needsReload = false;
}
