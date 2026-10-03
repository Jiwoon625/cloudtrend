import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeLedgerReload,
  createLedgerEditSession,
  createLedgerWriteGuard,
  LEDGER_RECONCILE_MESSAGE,
  runLedgerWrite,
} from "./ledgerUiMutation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(revision = 3) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const guard = createLedgerWriteGuard();
  const session = createLedgerEditSession(revision);
  const onBusy = vi.fn();
  const onError = vi.fn();
  const queryKey = ["portfolio-ledgers"];
  return { client, guard, session, onBusy, onError, queryKey };
}

describe("ledger UI mutation safety", () => {
  it("locks synchronously before the first await so repeated same-tick clicks send one request", async () => {
    const options = setup();
    const pending = deferred<{ revision: number }>();
    const request = vi.fn(() => pending.promise);
    const first = runLedgerWrite({ ...options, request });
    expect(options.guard.pending).toBe(true);
    expect(await runLedgerWrite({ ...options, request })).toBe(false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    pending.resolve({ revision: 4 });
    expect(await first).toBe(true);
    expect(options.guard.pending).toBe(false);
    expect(options.onBusy.mock.calls).toEqual([[true], [false]]);
    options.client.clear();
  });

  it("does not rebase an open draft when another view or a background refresh changes the revision", async () => {
    const options = setup(3);
    options.client.setQueryData(options.queryKey, { revision: 20 });
    const request = vi.fn(async (revision: number) => {
      expect(revision).toBe(3);
      throw new Error("원장이 변경됐습니다.");
    });
    expect(await runLedgerWrite({ ...options, request })).toBe(false);
    expect(options.session.revision).toBe(3);
    expect(options.session.needsReview).toBe(true);
    expect(options.client.getQueryData(options.queryKey)).toEqual({ revision: 20 });
    expect(options.client.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
    options.client.clear();
  });

  it("keeps an uncertain draft blocked after reload, requiring explicit reconciliation and a new editor session", async () => {
    const options = setup();
    const request = vi.fn(async () => {
      // Simulate the server committing a new execution before the response was lost.
      throw new Error("Network response lost");
    });
    expect(await runLedgerWrite({ ...options, request })).toBe(false);
    expect(options.onError).toHaveBeenCalledWith(
      `Network response lost ${LEDGER_RECONCILE_MESSAGE}`,
    );
    expect(options.guard.needsReload).toBe(true);
    expect(await runLedgerWrite({ ...options, request })).toBe(false);
    acknowledgeLedgerReload(options.guard, false);
    expect(options.guard.needsReload).toBe(true);
    options.client.setQueryData(options.queryKey, {
      revision: 4,
      executions: [{ id: "committed" }],
    });
    acknowledgeLedgerReload(options.guard, true);
    expect(options.guard.needsReload).toBe(false);
    expect(options.session.revision).toBe(3);
    expect(await runLedgerWrite({ ...options, request })).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    const newRequest = vi.fn(async () => ({ revision: 5 }));
    expect(
      await runLedgerWrite({
        ...options,
        session: createLedgerEditSession(4),
        request: newRequest,
      }),
    ).toBe(true);
    options.client.clear();
  });

  it("does not clear pending or uncertain state from a read finishing during a mutation", () => {
    const options = setup();
    options.guard.pending = true;
    options.guard.needsReload = true;
    acknowledgeLedgerReload(options.guard, true);
    expect(options.guard).toEqual({ pending: true, needsReload: true });
    options.client.clear();
  });

  it("cancels reads started before and during the write and invalidates every actual-ledger view", async () => {
    const options = setup();
    const oldRead = deferred<{ revision: number }>();
    const oldPromise = options.client
      .fetchQuery({ queryKey: options.queryKey, queryFn: () => oldRead.promise })
      .catch(() => undefined);
    const secondRead = deferred<{ revision: number }>();
    let secondPromise: Promise<unknown> | undefined;
    const cancel = vi.spyOn(options.client, "cancelQueries");
    const invalidate = vi.spyOn(options.client, "invalidateQueries");
    const request = vi.fn(async () => {
      secondPromise = options.client
        .fetchQuery({ queryKey: options.queryKey, queryFn: () => secondRead.promise })
        .catch(() => undefined);
      return { revision: 4, executions: [{ id: "new" }] };
    });
    expect(await runLedgerWrite({ ...options, request })).toBe(true);
    oldRead.resolve({ revision: 1 });
    secondRead.resolve({ revision: 2 });
    await Promise.all([oldPromise, secondPromise]);
    expect(options.client.getQueryData(options.queryKey)).toEqual({
      revision: 4,
      executions: [{ id: "new" }],
    });
    expect(cancel).toHaveBeenCalledTimes(8);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["portfolio-ledgers"],
      ["us-actual-ledger"],
      ["portfolio-ledgers-overview"],
      ["dashboard-operations"],
    ]);
    options.client.clear();
  });

  it("never overwrites a newer cached revision with a late successful response", async () => {
    const options = setup();
    const request = vi.fn(async () => {
      options.client.setQueryData(options.queryKey, { revision: 7, source: "newer" });
      return { revision: 4 };
    });
    expect(await runLedgerWrite({ ...options, request })).toBe(true);
    expect(options.client.getQueryData(options.queryKey)).toEqual({ revision: 7, source: "newer" });
    options.client.clear();
  });

  it("refuses to write without a loaded editor revision", async () => {
    const options = setup();
    const request = vi.fn(async () => ({ revision: 1 }));
    expect(
      await runLedgerWrite({ ...options, session: createLedgerEditSession(undefined), request }),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledOnce();
    options.client.clear();
  });
});
