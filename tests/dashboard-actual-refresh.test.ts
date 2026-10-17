import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  DASHBOARD_OPERATIONS_QUERY,
  invalidateActualPositionViews,
} from "../src/lib/dashboardActualRefresh";

it("invalidates an unmounted dashboard after a successful actual save without starting a hidden fetch", async () => {
  const client = new QueryClient();
  const fetch = vi.fn().mockResolvedValue({ onsets: [] });
  const dashboard = [...DASHBOARD_OPERATIONS_QUERY, "digest"];
  await client.fetchQuery({ queryKey: dashboard, queryFn: fetch, staleTime: Infinity });
  client.setQueryData(["domestic-position-context"], { heldSymbols: [] });
  client.setQueryData(["october-shadow-summary"], { books: [] });
  await invalidateActualPositionViews(client);
  expect(client.getQueryState(dashboard)?.isInvalidated).toBe(true);
  expect(client.getQueryState(["domestic-position-context"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["october-shadow-summary"])?.isInvalidated).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  await client.fetchQuery({ queryKey: dashboard, queryFn: fetch, staleTime: Infinity });
  expect(fetch).toHaveBeenCalledTimes(2);
  client.clear();
});

it("wires successful actual saves and focus reads without Shadow invalidating actual actions", () => {
  const editor = readFileSync(
    new URL("../src/components/NewActualPortfolio.tsx", import.meta.url),
    "utf8",
  );
  expect(editor).toContain("await invalidateActualPositionViews(qc, true)");
  expect(editor.indexOf("await invalidateActualPositionViews(qc, true)")).toBeGreaterThan(
    editor.indexOf("} finally {"),
  );
  const view = readFileSync(
    new URL("../src/components/DashboardOperations.tsx", import.meta.url),
    "utf8",
  );
  expect(view).toContain("refetchOnWindowFocus: true");
  expect(view).not.toContain('"october-shadow-summary"');
});

it("discards an older in-flight position read when an actual fill is saved", async () => {
  const client = new QueryClient();
  const key = [...DASHBOARD_OPERATIONS_QUERY, "digest"];
  let finish!: (value: { state: string }) => void;
  const old = client
    .fetchQuery({
      queryKey: key,
      queryFn: () =>
        new Promise<{ state: string }>((resolve) => {
          finish = resolve;
        }),
    })
    .catch(() => null);
  await invalidateActualPositionViews(client);
  const updated = await client.fetchQuery({
    queryKey: key,
    queryFn: async () => ({ state: "actual-held" }),
  });
  finish({ state: "old-unbought" });
  await old;
  await Promise.resolve();
  expect(updated.state).toBe("actual-held");
  expect(client.getQueryData(key)).toEqual({ state: "actual-held" });
  client.clear();
});

it("refreshes an already visible dashboard after a mutation settles, but no hidden reader", async () => {
  const client = new QueryClient();
  let current = "unheld";
  const fetch = vi.fn(async () => ({ current }));
  const observer = new QueryObserver(client, {
    queryKey: DASHBOARD_OPERATIONS_QUERY,
    queryFn: fetch,
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  await observer.refetch();
  current = "held";
  await invalidateActualPositionViews(client, true);
  expect(client.getQueryData(DASHBOARD_OPERATIONS_QUERY)).toEqual({ current: "held" });
  unsubscribe();
  const count = fetch.mock.calls.length;
  await invalidateActualPositionViews(client, true);
  expect(fetch).toHaveBeenCalledTimes(count);
  client.clear();
});
