import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DashboardSignalCounts, DashboardSignalLists } from "./DashboardOperations";
import type {
  DashboardMarket,
  DashboardOperations,
  DashboardSignal,
} from "@/lib/dashboardOperations";
import type { DashboardSummary } from "@/lib/screeningCacheContract";

// Select each real component state for server-rendered assertions. Browser QA covers clicks.
const state = vi.hoisted(() => ({ tab: "onsets", market: "ALL" }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) =>
      actual.useState(
        initial === "onsets" ? state.tab : initial === "ALL" ? state.market : initial,
      ),
  };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode;
    to: string;
    params?: { symbol: string };
  }) => <a href={params ? to.replace("$symbol", params.symbol) : to}>{children}</a>,
}));
vi.mock("@/lib/dashboardOperations.functions", () => ({
  dashboardOperationsServer: vi.fn(),
  dashboardEtfHoldingsServer: vi.fn(),
}));
vi.mock("@/lib/cloud", () => ({ supabase: {} }));
const date = "2026-10-02";
const signal = (market: DashboardMarket, number: number, kind = "pending"): DashboardSignal => ({
  symbol: `${market}${number}`,
  name: `${market} ${kind} ${number}`,
  market,
  date,
  sector: "검증",
  price: 10000,
  score: market === "ETF" ? 81 : 8.5,
  priority: 1,
  reason: kind === "pending" ? "다음 거래일 종가 확인 대기" : "확인 완료",
});
const data = (kospi: number | null, etf: number | null): DashboardOperations => ({
  markets: (["KOSPI", "KOSDAQ", "ETF", "US"] as const).map((market) => {
    const pendingCount = market === "KOSPI" ? kospi : market === "ETF" ? etf : 0;
    return {
      market,
      date,
      holdingsKnown: true,
      onsetCount: 1,
      exitCount: 0,
      pendingCount,
      pending: Array.from({ length: pendingCount ?? 0 }, (_, n) => signal(market, n)),
      onsets: [signal(market, 99, "ready")],
      exits: [],
    };
  }),
  usPortfolio: null,
  etfHoldings: null,
  warnings: [],
});
const query = (value: DashboardOperations | undefined, extra = {}) =>
  ({
    data: value,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
    ...extra,
  }) as unknown as Parameters<typeof DashboardSignalLists>[0]["query"];
const counts = { incomplete: 0 } as DashboardSummary["counts"];
const renderCounts = (value: DashboardOperations | undefined, extra = {}) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <DashboardSignalCounts query={query(value, extra)} counts={counts} />
    </QueryClientProvider>,
  );
const renderList = (value: DashboardOperations | undefined, extra = {}) =>
  renderToStaticMarkup(<DashboardSignalLists query={query(value, extra)} />);

beforeEach(() => {
  state.tab = "onsets";
  state.market = "ALL";
});
describe("combined dashboard confirmation counts", () => {
  it.each([
    [3, 1],
    [0, 1],
    [3, 0],
    [0, 0],
  ])("renders KOSPI/ETF %i/%i without swapping or hiding zeros", (kospi, etf) => {
    const html = renderCounts(data(kospi!, etf!));
    expect(html).toContain("확인대기(KOSPI/ETF)");
    expect(html).toContain(`>${kospi}/${etf}</span>`);
    expect(html).toContain(`aria-label="KOSPI ${kospi}종목, ETF ${etf}종목"`);
    expect(html).not.toContain("KOSPI 하루 확인 대기");
  });
  it("keeps unknown signal counts separate from zero", () => {
    expect(renderCounts(data(null, 1))).toContain(">—/1</span>");
    expect(renderCounts(data(3, null))).toContain(">3/—</span>");
    expect(renderCounts(undefined, { isPending: true })).toContain(">—/—</span>");
    expect(renderCounts(undefined, { isError: true })).toContain("신호 조회 실패");
  });
});
describe("combined dashboard confirmation list", () => {
  beforeEach(() => {
    state.tab = "pending";
  });
  it("merges KOSPI and ETF once, labels each market and score scale, and links each symbol", () => {
    const html = renderList(data(3, 1));
    expect(html).toContain("확인대기 (4)");
    expect(html).toContain("조건달성종목 · KOSPI / ETF");
    for (const market of ["KOSPI", "ETF"] as const) {
      expect(html).toContain(`>${market}</td>`);
      expect(html).toContain(`href="/instrument/${market}0"`);
      expect(html.match(new RegExp(`${market} pending 0`, "g"))).toHaveLength(1);
    }
    expect(html).toContain("8.5 / 10");
    expect(html).toContain("81.0 / 100");
    expect(html).not.toContain("ready 99");
    expect(html).not.toContain("KOSPI 확인 대기");
    expect(html).toContain("flex flex-wrap gap-2");
    expect(html).toContain("overflow-x-auto");
  });
  it.each(["KOSPI", "ETF"])("filters confirmation rows to %s", (market) => {
    state.market = market;
    const html = renderList(data(3, 1));
    expect(html).toContain(`${market} pending 0`);
    expect(html).not.toContain(`${market === "KOSPI" ? "ETF" : "KOSPI"} pending 0`);
    expect(html).toContain('option value="ETF"');
    expect(html).not.toContain('option value="KOSDAQ"');
  });
  it.each([
    [0, 1],
    [3, 0],
    [0, 0],
  ])("handles confirmation list %i/%i", (kospi, etf) => {
    const html = renderList(data(kospi!, etf!));
    expect(html).toContain(`확인대기 (${kospi! + etf!})`);
    expect(html.includes("KOSPI pending 0")).toBe(kospi! > 0);
    expect(html.includes("ETF pending 0")).toBe(etf! > 0);
    if (kospi === 0 && etf === 0) expect(html).toContain("해당 확인대기 종목이 없습니다.");
  });
  it("does not count unknown markets as confirmed empty", () => {
    const partial = renderList(data(null, 1));
    expect(partial).toContain("일부 시장은 신호 또는 보유정보가 미확인입니다.");
    expect(partial).toContain("ETF pending 0");
    const missing = data(0, 0);
    missing.markets = missing.markets.filter((m) => m.market !== "ETF");
    expect(renderList(missing)).toContain(
      "확인된 신호가 없습니다. 미확인 시장의 데이터를 확인해 주세요.",
    );
    expect(renderList(undefined, { isPending: true })).toContain("저장된 신호를 불러오는 중입니다");
    expect(renderList(undefined, { isError: true })).toContain("신호를 불러오지 못했습니다.");
  });
  it("paginates the merged list rather than truncating market counts", () => {
    const html = renderList(data(24, 3));
    expect(html).toContain("확인대기 (27)");
    expect(html).toContain("ETF pending 0");
    expect(html).not.toContain("ETF pending 1");
    expect(html).toContain("27종목 · 1 / 2");
  });
  it("keeps ETF pending out of entry-ready and exit lists", () => {
    for (const tab of ["onsets", "exits"]) {
      state.tab = tab;
      const html = renderList(data(3, 1));
      expect(html).not.toContain("pending 0");
      expect(html).not.toContain("ETF ready 99");
      expect(html).not.toContain('option value="ETF"');
    }
  });
});
