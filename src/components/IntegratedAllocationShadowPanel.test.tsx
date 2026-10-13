import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntegratedAllocationShadowContent,
  LazyAllocationWarnings,
} from "./IntegratedAllocationShadowPanel";
import {
  createIntegratedAllocationShadow,
  type AllocationRecord,
} from "@/lib/integratedAllocationShadow";
import { allocationWarningEvidenceServer } from "@/lib/integratedAllocationShadow.functions";
import type { AllocationWarningEvidence } from "@/lib/allocationWarningPresentation";

// Hook/event contract harness: this suite does not claim a mounted browser lifecycle.
const lazy = vi.hoisted(() => ({
  scope: "",
  open: new Map<string, boolean>(),
  queries: [] as Array<{
    queryKey: unknown[];
    enabled: boolean;
    staleTime: number;
    gcTime: number;
    retry: boolean;
    queryFn: () => Promise<unknown>;
  }>,
  results: new Map<
    string,
    { data?: Record<string, AllocationWarningEvidence>; isFetching: boolean }
  >(),
  retry: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: boolean) => {
      const scope = lazy.scope;
      return [lazy.open.get(scope) ?? initial, (value: boolean) => lazy.open.set(scope, value)];
    },
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: (typeof lazy.queries)[number]) => {
    lazy.queries.push(options);
    return {
      ...lazy.results.get(JSON.stringify(options.queryKey)),
      isFetching: false,
      refetch: lazy.retry,
    };
  },
}));
vi.mock("@/lib/cloud", () => ({ supabase: {} }));
vi.mock("@/lib/integratedAllocationShadow.functions", () => ({
  integratedAllocationShadowServer: vi.fn(),
  allocationWarningEvidenceServer: vi.fn(),
}));
const hash = `sha256:${"a".repeat(64)}` as const;
describe("integrated allocation Shadow display", () => {
  it("filters month reviews by calendar month end, including leap years", async () => {
    const ledger = await createIntegratedAllocationShadow("O1", { codeHash: hash });
    ledger.receipts.push({
      id: "month:2026-10",
      inputHash: hash,
      record: {
        id: "month:2026-10",
        type: "MONTH_REVIEW",
        date: "2026-10",
        sourceHash: hash,
        fills: [],
        cancelledBuys: [],
        transfers: [],
        issues: [],
      },
    });
    const render = (from: string, to: string) =>
      renderToStaticMarkup(
        <IntegratedAllocationShadowContent ledger={ledger} period={{ from, to }} />,
      );
    expect(render("2024-04-15", "2026-10-31")).toContain(
      "2026-10-31 집계월 말일 · 다음 달 비중 판단",
    );
    expect(render("", "2026-10-30")).toContain("선택 기간 기록 없음");
    expect(render("2026-11-01", "")).toContain("선택 기간 기록 없음");
    ledger.receipts[0]!.record.date = "2028-02";
    expect(render("2028-02-29", "2028-02-29")).toContain("2028-02-29 집계월 말일");
    expect(render("", "2028-02-28")).toContain("선택 기간 기록 없음");
  });
  it("separates new calendar-month O1 from its historical initial seed and research", async () => {
    const ledger = await createIntegratedAllocationShadow("O1", { codeHash: hash });
    const html = renderToStaticMarkup(<IntegratedAllocationShadowContent ledger={ledger} />);
    expect(html).toContain("3,000만원");
    expect(html.match(/33.33%/g)).toHaveLength(3);
    expect(html).toContain("부분월");
    expect(html).toContain("원본 O1 연구 성과와 구분");
    expect(html).toContain("첫 세션 대기");
    expect(html).not.toContain("독립 기준 장부의 수요");
  });
  it("uses actual calendar-date range for the history, leaving latest holdings explicitly scoped", async () => {
    const ledger = await createIntegratedAllocationShadow("S07", { codeHash: hash });
    const record = {
      id: "a",
      type: "SESSION" as const,
      date: "2024-04-16",
      sourceHash: hash,
      fills: [
        {
          market: "K" as const,
          symbol: "A",
          side: "BUY" as const,
          quantity: "1",
          price: "100",
          grossKrw: "100",
          feeKrw: "0.15",
          reason: "test",
        },
      ],
      cancelledBuys: [],
      transfers: [],
      issues: [],
    };
    ledger.receipts.push({ id: "a", inputHash: hash, record });
    const excluded = renderToStaticMarkup(
      <IntegratedAllocationShadowContent
        ledger={ledger}
        period={{ from: "2026-10-14", to: "2026-10-15" }}
      />,
    );
    expect(excluded).toContain("선택 기간 기록 없음");
    expect(excluded).not.toContain("A BUY");
    const included = renderToStaticMarkup(
      <IntegratedAllocationShadowContent
        ledger={ledger}
        period={{ from: "2024-04-16", to: "2024-04-16" }}
      />,
    );
    expect(included).toContain("A BUY 1주");
    expect(included).toContain("최신 완료 세션 기준");
    expect(included).toContain("60/20/20 정적 초기배분");
  });
});

it("collapses long warning receipts behind a short count and preserves original codes", async () => {
  const ledger = await createIntegratedAllocationShadow("O1", { codeHash: hash });
  ledger.receipts.push({
    id: "warn",
    inputHash: hash,
    record: {
      id: "session:E:2024-04-15",
      type: "SESSION",
      date: "2024-04-15",
      sourceHash: hash,
      fills: [],
      transfers: [],
      cancelledBuys: [],
      issues: ["SIGNAL_DATA_UNAVAILABLE:SYN005"],
    },
  });
  const before = JSON.stringify(ledger);
  const html = renderToStaticMarkup(<IntegratedAllocationShadowContent ledger={ledger} />);
  expect(html).toContain("자료 확인 1건");
  expect(html).toContain("<details>");
  expect(html).not.toContain("<details open");
  expect(html).toContain("저장 원문");
  expect(html).toContain("SIGNAL_DATA_UNAVAILABLE:SYN005");
  expect(JSON.stringify(ledger)).toBe(before);
});

describe("lazy allocation warning hook and event contract", () => {
  const owner = "11111111-2222-4333-8444-555555555555";
  const record = (date = "2024-04-15"): AllocationRecord => ({
    id: `session:E:${date}`,
    type: "SESSION",
    date,
    sourceHash: hash,
    fills: [],
    cancelledBuys: [],
    transfers: [],
    issues: ["SIGNAL_DATA_UNAVAILABLE:SYN005"],
  });
  const getToken = vi.fn(async (_owner: string) => "verified-token");
  function view(overrides: Partial<Parameters<typeof LazyAllocationWarnings>[0]> = {}) {
    const props = {
      owner,
      kind: "O1" as const,
      stateHash: hash,
      record: record(),
      getToken,
      ...overrides,
    };
    lazy.scope = JSON.stringify([props.owner, props.kind, props.stateHash, props.record.id]);
    return LazyAllocationWarnings(props);
  }
  const config = () => lazy.queries.at(-1)!;
  const toggle = (tree: ReturnType<typeof view>, open: boolean) =>
    tree.props.onToggle({ currentTarget: { open } });
  beforeEach(() => {
    lazy.open.clear();
    lazy.queries.length = 0;
    lazy.results.clear();
    lazy.retry.mockReset();
    getToken.mockClear();
    vi.mocked(allocationWarningEvidenceServer).mockReset().mockResolvedValue({});
  });

  it("keeps reads disabled until expansion and closes without an extra read", async () => {
    const closed = view();
    const closedHtml = renderToStaticMarkup(closed);
    expect(closedHtml).toContain("자료 확인 1건");
    expect(closedHtml).not.toContain("SIGNAL_DATA_UNAVAILABLE");
    expect(closedHtml).not.toContain("저장 원문");
    expect(closedHtml).not.toContain("분류 근거 미확인");
    expect(config().enabled).toBe(false);
    expect(getToken).not.toHaveBeenCalled();
    expect(allocationWarningEvidenceServer).not.toHaveBeenCalled();
    toggle(closed, true);
    const opened = view();
    expect(config()).toMatchObject({ enabled: true, staleTime: Infinity, gcTime: 0, retry: false });
    await config().queryFn();
    expect(getToken).toHaveBeenCalledWith(owner);
    expect(allocationWarningEvidenceServer).toHaveBeenCalledExactlyOnceWith({
      data: { accessToken: "verified-token", kind: "O1", receiptId: record().id },
    });
    toggle(opened, false);
    view();
    expect(config().enabled).toBe(false);
    expect(allocationWarningEvidenceServer).toHaveBeenCalledTimes(1);
  });

  it("isolates owner, book, head and receipt keys and retains independent evidence", () => {
    toggle(view(), true);
    view();
    const firstKey = config().queryKey;
    const firstEvidence = {
      date: record().date,
      sourceHash: hash,
      rows: [{ symbol: "SYN005", name: "saved first receipt", issues: ["검증된 ETF 분류 없음"] }],
    };
    lazy.results.set(JSON.stringify(firstKey), {
      data: { [record().id]: firstEvidence },
      isFetching: false,
    });
    for (const patch of [
      { owner: "different-owner" },
      { kind: "S07" as const },
      { stateHash: "different-head" },
      { record: record("2024-04-16") },
    ]) {
      view(patch);
      expect(config().enabled).toBe(false);
      expect(config().queryKey).not.toEqual(firstKey);
    }
    toggle(view({ record: record("2024-04-16") }), true);
    view({ record: record("2024-04-16") });
    expect(config().enabled).toBe(true);
    const first = view();
    expect(config().enabled).toBe(true);
    expect(renderToStaticMarkup(first)).toContain("saved first receipt");
  });

  it("keeps original warnings on failed/absent evidence and offers explicit retry", () => {
    toggle(view(), true);
    const opened = view();
    const html = renderToStaticMarkup(opened);
    expect(html).toContain("자료 확인 1건");
    expect(html).toContain("SIGNAL_DATA_UNAVAILABLE:SYN005");
    expect(html).toContain("분류 근거 미확인");
    expect(html).toContain("근거 다시 확인");
    const retry = React.Children.toArray(opened.props.children).find(
      (child) => React.isValidElement(child) && child.type === "button",
    ) as React.ReactElement<{ onClick: () => void }>;
    retry.props.onClick();
    expect(lazy.retry).toHaveBeenCalledTimes(1);
    expect(allocationWarningEvidenceServer).not.toHaveBeenCalled();
  });

  it("does not read annotation for non-ETF receipts and never retries automatically", () => {
    const other = { ...record(), id: "session:K:2024-04-15" };
    toggle(view({ record: other }), true);
    const opened = view({ record: other });
    expect(config().enabled).toBe(false);
    expect(config().retry).toBe(false);
    expect(renderToStaticMarkup(opened)).not.toContain("근거 다시 확인");
    expect(allocationWarningEvidenceServer).not.toHaveBeenCalled();
  });

  it("never invokes the server if owner token verification fails", async () => {
    toggle(view(), true);
    view({
      getToken: async () => {
        throw new Error("owner changed");
      },
    });
    await expect(config().queryFn()).rejects.toThrow("owner changed");
    expect(allocationWarningEvidenceServer).not.toHaveBeenCalled();
  });
});
