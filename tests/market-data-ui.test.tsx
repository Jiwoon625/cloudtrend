import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { MarketDataPage } from "../src/components/MarketDataPage";
import { UsModelExecutionJournal } from "../src/components/UsModelExecutionJournal";
import { UsPortfolioView, NavChart } from "../src/components/UsPortfolioView";
import { NavSeriesLegend } from "../src/components/NavSeriesLegend";
import { navSeriesStyle } from "../src/lib/navSeries";
import { Route as LegacyUsRoute } from "../src/routes/us.index";
import { summarizeUsDataQuality } from "../src/lib/usDataQuality";
import type {
  UsProspectiveCacheRow,
  UsPortfolioSnapshotRecord,
} from "../src/lib/usProspectiveCloud";

vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <main className="mx-auto max-w-[1500px] px-4 py-6">{children}</main>
  ),
}));
vi.mock("@/components/DataError", () => ({
  DataError: () => <p role="alert">한국 원본 조회 실패</p>,
}));
vi.mock("@/components/UsModelTaxEstimatePanel", () => ({
  UsModelTaxEstimatePanel: () => <section>양도소득세 추정</section>,
}));
vi.mock("@/lib/analysisQuery", () => ({ dataStatusQueryOptions: { queryKey: ["data-status"] } }));
vi.mock("@/lib/usProspectiveCloud", () => ({
  loadUsMarketDataSummary: vi.fn(),
  loadUsScreeningHistory: vi.fn(),
  loadUsPortfolioSnapshots: vi.fn(),
  loadUsPortfolioTrades: vi.fn(),
  loadUsStrategyRegistry: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  redirect: (options: unknown) => options,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => query(queryKey[0]!),
}));

const usRow = {
  symbol: "DEMO",
  date: "2026-10-02",
  open: 100,
  close: 102,
  marketCap: 1000000,
  sector: "Technology",
  coreRank: 0.95,
  betaRank: 0.9,
  tkRank: 0.9,
  ret120: 0.2,
  ret252: 0.3,
  adv20Usd: 10000,
  liquidityRank: 0.8,
} as UsProspectiveCacheRow;
const us = {
  dataHash: "synthetic-layout-fixture-hash",
  generatedAt: "2026-10-03T00:15:00Z",
  source: {
    provider: "Synthetic UI fixture",
    collectedAt: "2026-10-03T00:00:00Z",
    schemaVersion: "fixture-v1",
    metadata: {},
  },
  analysis: {
    date: "2026-10-02",
    ruleVersion: "fixture-rule",
    rowCount: 1,
    summary: {
      inputRows: 1,
      rankedRows: 1,
      spyClose: 500,
      a0Entries: 0,
      a0Exits: 0,
      a2Entries: 0,
      a2Exits: 0,
      b3Entries: 0,
      b3Exits: 0,
    },
  },
  quality: summarizeUsDataQuality([usRow], "2026-10-02"),
};
const kr = {
  source: { live: true, credentialsConfigured: true, fallbackReason: null },
  asOfDate: "2026-10-02",
  dataProvider: "Synthetic UI fixture",
  dataVersion: "fixture-v1",
  strategyVersion: "fixture-rule",
  isLive: true,
  notes: ["합성 UI 검증 자료 · 실제 투자 데이터 아님"],
  capabilities: {
    marketCap: true,
    fundamentals: false,
    etfFacts: false,
    sectors: true,
    investorFlow: true,
    volatilityIndex: false,
    exactTradingValue: true,
  },
  coverage: [
    {
      provider: "Synthetic UI fixture",
      kind: "종목 일봉(직접 입력)",
      count: 300,
      entities: 1,
      ok: true,
    },
  ],
  checks: {
    ohlcErrors: 0,
    negativeVolume: 0,
    duplicates: 0,
    futureDates: 0,
    insufficient: 0,
    abnormalMoves: 1,
  },
  barCoverage: [
    {
      symbol: "000001",
      name: "레이아웃 검증 종목",
      bars: 300,
      first: "2025-08-01",
      last: "2026-10-02",
    },
  ],
};
const ids = ["A0_QUARTER_PRIMARY", "A2_QUARTER_SHADOW", "B3_BETA_SHADOW", "SPY_BENCHMARK"];
const snapshots = ids.flatMap((id, i) =>
  ["2026-10-02", "2026-10-01", "2026-09-30"].map((date, day) => ({
    strategy_id: id,
    date,
    nav_usd: 100000 + (2 - day) * 1000 * (i + 1),
    cash_usd: 4000,
    fees_usd: 0,
    turnover: 0,
    positions_count: 1,
    benchmark_nav: 100000,
    cumulative_return: 0.01,
    state: {
      positions: {
        DEMO: {
          symbol: "DEMO",
          name: "검증 종목",
          sector: "IT",
          shares: 10,
          lastPrice: 102,
          entryDate: "2026-09-30",
          entryCoreRank: 0.95,
        },
      },
    },
  })),
) as UsPortfolioSnapshotRecord[];
let failed = new Set<string>();
function query(key: string) {
  return {
    isError: failed.has(key),
    isLoading: false,
    isPending: false,
    isFetching: false,
    error: failed.has(key) ? new Error("fixture error") : null,
    refetch: vi.fn(),
    data: failed.has(key)
      ? undefined
      : key === "data-status"
        ? kr
        : key === "us-market-data-summary"
          ? us
          : key === "us-screening-history"
            ? [{ date: "2026-10-02" }]
            : key === "us-portfolio-snapshots"
              ? snapshots
              : key === "us-portfolio-trades"
                ? [
                    {
                      trade_key: "fixture-trade",
                      strategy_id: ids[0],
                      signal_date: "2026-09-30",
                      execution_date: "2026-10-01",
                      symbol: "DEMO",
                      status: "EXECUTED",
                      side: "BUY",
                      model_price: 100,
                      model_shares: 10,
                      fee_usd: 2.5,
                      reason: "ENTRY",
                    },
                  ]
                : key === "us-strategy-registry"
                  ? ids.map((id) => ({
                      strategy_id: id,
                      role: id === ids[0] ? "PRIMARY" : "BENCHMARK",
                    }))
                  : null,
  };
}
beforeEach(() => {
  failed = new Set();
});
function qa(name: string, html: string) {
  const out = process.env["UI_QA_DIR"];
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}/${name}.fragment.html`, html);
  }
}

describe("market/data consolidation and mobile portfolio layout", () => {
  it("retains all KR and US sections and actual source metadata in one page", () => {
    const html = renderToStaticMarkup(<MarketDataPage />);
    for (const title of [
      "데이터상태",
      "공급자별 수집 현황",
      "자동 검증 결과",
      "항목별 제공 여부",
      "종목별 일봉 수집 구간",
      "최근 수집 · 신호 요약",
      "운용 규칙 · A0",
      "A0 · Anchor",
      "A2",
      "B3 Beta",
      "실제 자료수집 계약",
      "Prospective 누적 상태",
      "원본 데이터 해시",
      "엔진 결과 생성 시각",
      "미국 · 항목별 제공 범위와 검증",
    ])
      expect(html).toContain(title);
    expect(html).toContain('href="#kr-data"');
    expect(html).toContain('href="#us-data"');
    expect(html).toContain("시가총액");
    expect(html).toContain("120·252일 수익률");
    expect(html.match(/<main/g)).toHaveLength(1);
    expect(html.match(/<h1/g)).toHaveLength(1);
    qa("market-data", html);
  });
  it("retains independent US contents after a KR failure and does not label failure zero", () => {
    failed.add("data-status");
    failed.add("us-screening-history");
    const html = renderToStaticMarkup(<MarketDataPage />);
    expect(html).toContain("한국 원본 조회 실패");
    expect(html).toContain("미국 · 항목별 제공 범위와 검증");
    expect(html).toContain("조회 실패는 수집 0건을 뜻하지 않습니다");
    expect(html).toContain("확인 불가");
  });
  it("redirects the old US data bookmark into the same page's US section", () => {
    const beforeLoad = (LegacyUsRoute.options as unknown as { beforeLoad: () => void }).beforeLoad;
    expect(beforeLoad).toThrow(
      expect.objectContaining({ to: "/data-status", hash: "us-data", replace: true }),
    );
  });
  it("puts model holdings and trade ledger immediately after the summary and before tax/NAV/plans", () => {
    const html = renderToStaticMarkup(<UsPortfolioView />);
    const positions = [
      "모델과 벤치마크 요약",
      'aria-label="모델 보유종목"',
      'aria-label="모델 체결 원장"',
      "양도소득세 추정",
      "정규화 NAV 추적",
    ].map((text) => html.indexOf(text));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain("검증 종목");
    expect(html).toContain("모델비용 USD");
    expect(html).not.toContain("모델 조정 미리보기");
    expect(html).not.toContain("다음 분기 비중조정");
    qa("portfolio", html);
  });
  it("retains the A0 model execution reference without adding account writes", () => {
    const html = renderToStaticMarkup(<UsModelExecutionJournal />);
    expect(html).toContain("A0 모델 체결 원장");
    expect(html).toContain("DEMO");
    expect(html).toContain("실제 주문이나 체결 기록을 만들지 않습니다");
    expect(html).not.toContain("실제 원장에 저장");
    failed.add("us-portfolio-trades");
    const error = renderToStaticMarkup(<UsModelExecutionJournal />);
    expect(error).toContain("기록 0건을 뜻하지 않습니다");
    expect(error).not.toContain("선택한 전략의 모델 체결 기록이 없습니다");
  });
  it("uses stable distinct colors and matching accessible swatches for all plotted NAV series", () => {
    const series = new Map(ids.map((id) => [id, snapshots.filter((r) => r.strategy_id === id)]));
    const html = renderToStaticMarkup(<NavChart series={series} order={ids} />);
    expect(new Set(ids.map((id) => navSeriesStyle(id).color)).size).toBe(4);
    for (const id of ids)
      expect(html.match(new RegExp(`stroke="${navSeriesStyle(id).color}"`, "g"))).toHaveLength(2);
    expect(html).toContain('aria-label="NAV 차트 범례"');
    expect(html).toContain('stroke-dasharray="7 4"');
    expect(html).not.toContain("min-w-[720px]");
    qa("nav-series", `<main class="mx-auto max-w-[1500px] px-4 py-6">${html}</main>`);
    expect(renderToStaticMarkup(<NavChart series={new Map()} order={ids} />)).toContain(
      "기록 없음",
    );
    expect(
      renderToStaticMarkup(
        <NavSeriesLegend
          series={[
            { id: "KOSPI_SHADOW", label: "KOSPI Shadow" },
            { id: "KOSPI_BENCHMARK", label: "KOSPI 가격지수" },
          ]}
        />,
      ),
    ).toContain("KOSPI 가격지수");
  });
});
