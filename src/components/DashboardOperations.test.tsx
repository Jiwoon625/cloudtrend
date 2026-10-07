import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DashboardSignalCounts,
  DashboardSignalLists,
  DashboardStrategyRules,
} from "./DashboardOperations";
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

describe("concise dashboard strategy rules", () => {
  const markup = () => renderToStaticMarkup(<DashboardStrategyRules />);

  it("keeps KOSPI confirmation, market guards, exits and sector limit", () => {
    const html = markup();
    expect(html).toContain(">KOSPI</h3>");
    expect(html).toContain("ETF PL 84 우선 / Stock PL 80 대체");
    expect(html).toContain("8.0 신규 돌파 후 다음 거래일 종가에 8점 이상·RSAccel");
    expect(html).toContain("&gt; 0·9.5 상향돌파 없음 확인, 그다음 거래 가능 시가 진입");
    expect(html).toContain("돌파일·체결 직전 완료 거래일 모두 Risk-On 또는 Neutral 필수");
    expect(html).toContain("하락장·시장자료 미확인 시 제외, 새 돌파 필요");
    expect(html).toContain("9.5 상향돌파 또는 60거래일 만기 청산");
    expect(html).toContain("점수 하락 청산 없음 · 섹터 한도 10%");
  });

  it("keeps adopted KOSDAQ 9/3 exits, timing and held-signal priority", () => {
    const html = markup();
    expect(html).toContain(">KOSDAQ</h3>");
    expect(html).toContain("Stock PL 80 · 8.0 신규 돌파 진입");
    expect(html).toContain("9.0 상향 재돌파·3.0 하향 이탈·60거래일 만기 청산");
    expect(html).toContain("진입은 다음 거래일 시가 · 미보유 종목의 동시 돌파는 진입 우선");
    expect(html).toContain("섹터 한도 20%");
    expect(html).toContain("점수 청산은 다음 거래일 시가, 만기는 당일 종가");
    expect(html).toContain("보유 종목·청산한 동일 신호는 진입 제외, 보유 중 청산 우선");
  });

  it("removes repeated implementation history while preserving ETF and US copy", () => {
    const html = markup();
    const domesticText = html.split("ETF · M0")[0]!.replace(/<[^>]+>/g, "");
    expect(domesticText.length).toBeLessThan(500);
    expect(html).not.toContain("2026-10-02");
    expect(html).not.toContain("기존 운영 전략 유지");
    expect(html).not.toContain("되살리지 않으며");
    expect(html).toContain(
      "M0 80점 신규 돌파 진입 · 기초지수 MA60 하회 시 청산 · 데이터 오류 시 청산 점검.",
    );
    expect(html).toContain(
      "Core 상위 30% 밖 또는 산정 불가 시 청산. Beta 상위 40% 밖 3거래일 연속도 청산합니다.",
    );
  });
});

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
  it("keeps missing-input judgment separate from confirmation waiting and score completeness", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <DashboardSignalCounts
          query={query(data(3, 1))}
          counts={{ ...counts, pending: 7, incomplete: 2 }}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("주식 판단 보류");
    expect(html).toContain(">7</span>");
    expect(html).toContain("점수 산정 불가");
    expect(html).toContain(">2</span>");
    expect(html).toContain(">3/1</span>");
  });
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

describe("Korean sector-limit badges", () => {
  const withLimits = () => {
    const value = data(1, 1);
    for (const market of value.markets) {
      for (const row of [...market.onsets, ...(market.pending ?? [])]) {
        if (row.market !== "KOSPI" && row.market !== "KOSDAQ") continue;
        row.sectorLimit = {
          status: "blocked",
          count: 6,
          limit: row.market === "KOSPI" ? 3 : 6,
          cap: row.market === "KOSPI" ? 0.1 : 0.2,
          maxPositions: 30,
          asOfDate: date,
          issue: null,
        };
      }
    }
    return value;
  };
  it("keeps entry signals and scores visible with count/limit and explicit block text", () => {
    const html = renderList(withLimits());
    expect(html).toContain("섹터 제한 · 6/3종목");
    expect(html).toContain("섹터 제한 · 6/6종목");
    expect(html).toContain("추가 진입 제한");
    expect(html).toContain(`전략 장부 기준 ${date}`);
    expect(html).toContain("KOSPI 한도 10% · 국내 30슬롯");
    expect(html).toContain("KOSDAQ 한도 20% · 국내 30슬롯");
    expect(html).toContain("KOSPI ready 99");
    expect(html).toContain("KOSDAQ ready 99");
    expect(html).toContain("8.5 / 10");
    expect(html).toContain("진입 준비 (3)");
    expect(html).toContain("예정 청산은 미차감");
    expect(html).toContain("슬롯은 미예약");
    expect(html).toContain("진입을 보장하지 않습니다");
  });
  it("labels pending KOSPI without implying confirmation completion or restricting ETFs", () => {
    state.tab = "pending";
    const html = renderList(withLimits());
    expect(html).toContain("섹터 제한 · 6/3종목");
    expect(html.match(/data-sector-status=/g)).toHaveLength(1);
    expect(html).toContain("다음 거래일 종가 확인 대기");
    expect(html).toContain("ETF pending 0");
  });
  it("uses neutral snapshot room and preserves zero", () => {
    const value = withLimits();
    const badge = value.markets[0]!.onsets[0]!.sectorLimit!;
    badge.status = "room";
    badge.count = 0;
    const html = renderList(value);
    expect(html).toContain("섹터 여유 · 0/3종목");
    expect(html).not.toContain("진입 가능");
  });
  it("shows missing or stale data as unknown with the saved date", () => {
    expect(renderList(data(1, 1))).toContain("섹터 미확인 · —/—종목");
    const value = withLimits();
    const badge = value.markets[0]!.onsets[0]!.sectorLimit!;
    badge.status = "unknown";
    badge.asOfDate = "2026-09-30";
    badge.issue = "신호·장부 기준일 불일치";
    const html = renderList(value);
    expect(html).toContain("섹터 미확인 · 6/3종목");
    expect(html).toContain("신호·장부 기준일 불일치");
    expect(html).toContain("전략 장부 기준 2026-09-30");
  });
  it("keeps labels and Korean-sector notes off US-only and EXIT views", () => {
    state.market = "US";
    let html = renderList(withLimits());
    expect(html).not.toContain("data-sector-status");
    expect(html).not.toContain("섹터 보유 수는");
    state.market = "ALL";
    state.tab = "exits";
    const value = withLimits();
    value.markets[0]!.exits = value.markets[0]!.onsets;
    html = renderList(value);
    expect(html).not.toContain("data-sector-status");
    expect(html).not.toContain("섹터 보유 수는");
  });
});
