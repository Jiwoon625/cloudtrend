import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UsOrderPreview } from "./UsOrderPreview";
import { UsDashboardPortfolio } from "./DashboardOperations";
import { Route } from "@/routes/us.portfolio";
import { UsPortfolioView } from "./UsPortfolioView";
import type { DashboardOperations } from "@/lib/dashboardOperations";
import type {
  UsOrderPlan,
  UsOrderPreviewBundle,
  UsOrderPreviewRow,
} from "@/lib/engine/usProspectiveOrderPreview";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  redirect: (options: unknown) => options,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/lib/dashboardOperations.functions", () => ({
  dashboardOperationsServer: vi.fn(),
  dashboardEtfHoldingsServer: vi.fn(),
}));
vi.mock("@/lib/cloud", () => ({ supabase: {} }));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/lib/usProspectiveCloud", () => ({
  loadUsPortfolioSnapshots: vi.fn(),
  loadUsPortfolioTrades: vi.fn(),
  loadUsStrategyRegistry: vi.fn(),
}));

const row = (changes: Partial<UsOrderPreviewRow> = {}): UsOrderPreviewRow => ({
  symbol: "BUY1",
  name: "매수 검증 종목",
  reason: "QUARTER_EQUAL_WEIGHT",
  side: "BUY",
  currentShares: 10,
  targetShares: 25,
  targetWeight: 0.25,
  estimatedShares: 15,
  remainingShares: 0,
  referencePrice: 100,
  priceDate: "2026-12-30",
  estimatedNotionalUsd: 1500,
  status: "ESTIMATED",
  limitReason: null,
  ...changes,
});
const plan = (changes: Partial<UsOrderPlan> = {}): UsOrderPlan => ({
  kind: "QUARTER",
  sourceDate: "2026-12-30",
  quarter: "2027Q1",
  confirmationDate: "2026-12-31",
  executionDate: "2027-01-04",
  status: "PROVISIONAL",
  navUsd: 10000,
  cashBeforeUsd: 3000,
  cashAfterUsd: 1496.25,
  feesUsd: 3.75,
  rows: [row()],
  warnings: [],
  ...changes,
});
const bundle = (changes: Partial<UsOrderPreviewBundle> = {}): UsOrderPreviewBundle => ({
  version: 1,
  sourceDate: "2026-12-30",
  nextQuarter: plan(),
  nextSession: plan({
    kind: "PENDING",
    quarter: null,
    confirmationDate: "2026-12-30",
    executionDate: "2026-12-31",
    status: "READY",
    rows: [
      row({
        symbol: "FUND1",
        name: "진입 자금 마련 검증 종목",
        reason: "ENTRY_MINIMUM_PROPORTIONAL_FUNDING",
        side: "SELL",
        currentShares: 50,
        targetShares: 45,
        estimatedShares: 5,
        estimatedNotionalUsd: 500,
      }),
    ],
  }),
  ...changes,
});
const render = (
  value: UsOrderPreviewBundle | null = bundle(),
  extra: Partial<Parameters<typeof UsOrderPreview>[0]> = {},
) => renderToStaticMarkup(<UsOrderPreview bundle={value} todayUs="2026-12-30" {...extra} />);

afterEach(() => vi.useRealTimers());

describe("US saved model order preview", () => {
  it("shows dates, model quantities, prices, weights, cash and costs without implying actual fills", () => {
    const html = render();
    for (const text of [
      "다음 분기 비중조정 · 2027Q1",
      "다음 정규장 대기 조정",
      "2026-12-30",
      "2026-12-31",
      "2027-01-04",
      "10주 → 25주",
      "15주 추정",
      "25.0%",
      "$100.00",
      "$1,500.00",
      "$10,000.00",
      "$3,000.00",
      "$1,496.25",
      "$3.75",
      "분기 동일비중 조정",
      "실계좌 권장수량: 미산출",
      "실제 현금·주문예산",
      "실제 체결 내역이 아닙니다",
      "모델 기본자금 $100,000을 실계좌 수량으로 환산하지 않습니다",
      "모든 날짜는 미국 거래일 기준",
      "휴장일에는 체결하지 않으며",
      "아래 두 계획은 합산하지 않습니다",
    ])
      expect(html).toContain(text);
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("min-w-0");
  });

  it("includes pending funding reductions as their own quantity plan", () => {
    const html = render();
    expect(html).toContain("FUND1");
    expect(html).toContain("50주 → 45주");
    expect(html).toContain("5주 추정");
    expect(html).toContain("신규 진입 자금 마련 · 기존 보유 축소");
    expect(html).toContain("일부 축소");
    expect(html).toContain("신규 진입·전량 청산 신호 집계와 별도입니다");
  });

  it("distinguishes zero adjustment, full exit and partial capacity constraints", () => {
    const html = render(
      bundle({
        nextQuarter: plan({
          rows: [
            row({
              symbol: "HOLD1",
              side: "HOLD",
              targetShares: 10,
              estimatedShares: 0,
              estimatedNotionalUsd: 0,
              status: "NO_CHANGE",
            }),
            row({
              symbol: "EXIT1",
              side: "EXIT",
              targetShares: 0,
              targetWeight: 0,
              estimatedShares: 4,
              remainingShares: 6,
              status: "PARTIAL",
              reason: "A0_BETA_ANCHOR_3D",
              limitReason: "직전 ADV20 1% 한도",
            }),
          ],
        }),
      }),
    );
    expect(html).toContain("0주 추정");
    expect(html).toContain("조정 없음");
    expect(html).toContain("전량 청산");
    expect(html).toContain("10주 → 0주");
    expect(html).toContain("4주 추정");
    expect(html).toContain("추정 미반영 6주");
    expect(html).toContain("직전 ADV20 1% 한도");
    expect(html).toContain("제약 반영 · 일부 수량");
    expect(html).toContain("Beta 상위 40% 밖 3거래일 연속 청산");
    expect(html).toContain("0.0%");
    expect(html).toContain("$0.00");
  });

  it("never shows missing prices or blocked quantities as zeros or HOLD", () => {
    const html = render(
      bundle({
        nextQuarter: plan({
          status: "BLOCKED",
          navUsd: null,
          cashAfterUsd: null,
          feesUsd: null,
          warnings: ["같은 기준일 가격 확인 필요"],
          rows: [
            row({
              side: "HOLD",
              targetShares: null,
              estimatedShares: null,
              remainingShares: null,
              referencePrice: null,
              priceDate: null,
              estimatedNotionalUsd: null,
              status: "BLOCKED",
              limitReason: "확정일 가격·잔고 확인 필요",
            }),
          ],
        }),
      }),
    );
    expect(html).toContain("산출 불가 · 자료 확인 필요");
    expect(html).toContain("조정 방향 미확인");
    expect(html).toContain("수량 산출 불가");
    expect(html).toContain("가격일 미확인");
    expect(html).toContain("10주 → 미확인");
    expect(html).toContain("같은 기준일 가격 확인 필요");
    expect(html).not.toContain("0주 추정");
    expect(html).not.toContain("NaN");
  });

  it("makes empty valid plans different from unavailable or loading plans", () => {
    const html = render(
      bundle({
        nextQuarter: plan({ rows: [] }),
        nextSession: plan({ kind: "PENDING", quarter: null, rows: [] }),
      }),
    );
    expect(html).toContain("분기 조정 대상이 없습니다 (0종목)");
    expect(html).toContain("다음 정규장 대기 조정이 없습니다 (0종목)");
    expect(render(null)).toContain("조정 0건을 뜻하지 않습니다");
    expect(render(null, { isPending: true })).toContain(
      "저장된 모델 조정 계획을 불러오는 중입니다",
    );
    expect(render(null, { isPending: true })).not.toContain("(0종목)");
    const blocked = render(bundle({ nextQuarter: plan({ status: "BLOCKED", rows: [] }) }));
    expect(blocked).toContain("0주 조정을 뜻하지 않습니다");
    expect(blocked).not.toContain("분기 조정 대상이 없습니다");
  });

  it("keeps preview failure separate from an empty order list", () => {
    const html = render(null, { error: "저장 자료 읽기 실패" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("모델 조정 미리보기 조회 실패: 저장 자료 읽기 실패");
    expect(html).toContain("조회 실패로 예정일과 수량을 확인할 수 없습니다");
    expect(html).not.toContain("(0종목)");
  });

  it("hides cached READY quantities after a failed refresh", () => {
    const html = render(bundle(), { error: "인증 또는 최신 자료 조회 실패" });
    expect(html).toContain("인증 또는 최신 자료 조회 실패");
    expect(html).toContain("조회 실패로 예정일과 수량을 확인할 수 없습니다");
    expect(html).not.toContain("BUY1");
    expect(html).not.toContain("FUND1");
    expect(html).not.toContain("직전 거래일 자료 반영");
    expect(html).not.toContain("15주 추정");
  });

  it("marks early projections provisional even if a stale READY label was supplied", () => {
    const html = render(bundle({ nextQuarter: plan({ status: "READY" }) }));
    expect(html).toContain("가정 미리보기 · 확정 전");
    expect(html).toContain("확정일까지 투자대상·보유·신호가 달라질 수 있습니다");
  });

  it("labels prior-session data ready as an estimate, not a confirmed future fill", () => {
    const value = bundle({ nextQuarter: plan({ sourceDate: "2026-12-31", status: "READY" }) });
    const html = render(value, { todayUs: "2027-01-01" });
    expect(html).toContain("직전 거래일 자료 반영 · 수량은 추정");
    expect(html).toContain("분기 첫 미국 정규장 시가를 기다립니다");
    expect(html).not.toContain("확정 수량");
  });

  it("shows January holiday plan until its first session and flags overdue saved plans afterward", () => {
    const quarter = plan({ sourceDate: "2026-12-31", status: "READY" });
    const value = bundle({ nextQuarter: quarter, nextSession: { ...quarter, kind: "PENDING" } });
    for (const todayUs of ["2027-01-01", "2027-01-04"]) {
      const html = render(value, { todayUs });
      expect(html).toContain("2027Q1");
      expect(html).toContain("2027-01-04");
      expect(html).not.toContain("예정일 경과");
    }
    const overdue = render(value, { todayUs: "2027-01-05" });
    expect(overdue).toContain("예정일 경과 · 이후 확정 자료 미반영");
    expect(overdue).toContain("현재 주문에 사용할 수 없는 과거 예상");
  });

  it("uses the New York date, not UTC or Korea, when checking overdue plans", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-05T01:00:00Z")); // Still January 4 in New York.
    const quarter = plan({ sourceDate: "2026-12-31", status: "READY" });
    const value = bundle({ nextQuarter: quarter, nextSession: { ...quarter, kind: "PENDING" } });
    expect(renderToStaticMarkup(<UsOrderPreview bundle={value} />)).not.toContain("예정일 경과");
    vi.setSystemTime(new Date("2027-01-05T06:00:00Z"));
    expect(renderToStaticMarkup(<UsOrderPreview bundle={value} />)).toContain("예정일 경과");
  });

  it("does not duplicate the quarterly rows when the next session is the quarter boundary", () => {
    const quarter = plan();
    const html = render(
      bundle({ nextQuarter: quarter, nextSession: { ...quarter, kind: "PENDING" } }),
    );
    expect(html.match(/BUY1/g)).toHaveLength(1);
    expect(html).toContain("위 분기 계획이 다음 정규장 대기 조정에도 적용됩니다");
    expect(html).not.toContain('aria-label="다음 정규장 대기 조정"');
  });

  it("shows B3 non-quarterly strategy explicitly and retains its pending adjustments", () => {
    const html = render(bundle({ nextQuarter: null }), { strategyLabel: "B3 Beta" });
    expect(html).toContain("이 모델은 정기 분기 비중조정을 사용하지 않습니다");
    expect(html).toContain("B3 Beta 모델 조정 미리보기");
    expect(html).toContain("FUND1");
    expect(html).not.toContain("다음 분기 비중조정 · 미확인");
  });

  it("shows compact planned quantities immediately with remaining rows expandable", () => {
    const rows = Array.from({ length: 7 }, (_, i) => row({ symbol: `COMPACT${i}` }));
    const html = render(bundle({ nextQuarter: plan({ rows }) }), { compact: true });
    expect(html).toContain("추가 매수 15주 추정");
    expect(html).toContain("모델 보유 10주 → 목표 25주");
    expect(html).toContain("일부 축소 5주 추정");
    expect(html).toContain("나머지 2종목 수량 보기");
    expect(html.indexOf("COMPACT0")).toBeLessThan(html.indexOf("<details"));
    expect(html.indexOf("COMPACT6")).toBeGreaterThan(html.indexOf("<details"));
    expect(html).not.toContain("<table");
    expect(html).toContain("flex flex-wrap");
  });
});

describe("dashboard portfolio without the model preview card", () => {
  const query = (changes: Partial<DashboardOperations> = {}, flags = {}) =>
    ({
      data: {
        markets: [],
        usPortfolio: null,
        etfHoldings: null,
        warnings: [],
        usOrderPreview: bundle(),
        ...changes,
      },
      isPending: false,
      isError: false,
      ...flags,
    }) as Parameters<typeof UsDashboardPortfolio>[0]["query"];

  it("keeps the actual account summary and legacy link into the unified portfolio", () => {
    const html = renderToStaticMarkup(<UsDashboardPortfolio query={query()} />);
    expect(html).toContain('aria-label="미국주식 A0 포트폴리오"');
    expect(html).toContain("실제 체결 원장 기준 · USD");
    expect(html).toContain('href="/us/portfolio"');
    expect(html).toContain("포트폴리오 상세 보기 →");
    expect(html).toContain("min-w-0");
    expect(html).not.toContain("모델 조정 미리보기");
    expect(html).not.toContain("다음 분기 비중조정");
    expect(html).not.toContain("다음 정규장 대기 조정");
    expect(html).not.toContain("BUY1");
    expect(html).not.toContain("FUND1");
  });

  it.each([
    [{}, "미확인"],
    [{ isPending: true }, "불러오는 중…"],
    [{ isError: true }, "조회 실패"],
  ])("does not restore the preview for missing, loading, or failed data: %o", (flags, fallback) => {
    const html = renderToStaticMarkup(
      <UsDashboardPortfolio
        query={query(
          { usOrderPreview: null, warnings: ["US 주문 미리보기: 저장 자료 조회 실패"] },
          flags,
        )}
      />,
    );
    expect(html).toContain(fallback);
    expect(html).toContain('href="/us/portfolio"');
    expect(html).not.toContain("모델 조정 미리보기");
    expect(html).not.toContain("다음 분기 비중조정");
    expect(html).not.toContain("저장 자료 조회 실패");
  });
});

describe("portfolio saved snapshot preview integration", () => {
  const renderPortfolio = (previewError: string | null = null) => {
    const client = new QueryClient();
    client.setQueryData(["us-strategy-registry"], []);
    client.setQueryData(["us-portfolio-trades"], []);
    client.setQueryData(
      ["us-portfolio-snapshots"],
      [
        {
          strategy_id: "A0_QUARTER_PRIMARY",
          date: "2026-12-30",
          nav_usd: 10000,
          cash_usd: 3000,
          benchmark_nav: 100000,
          cumulative_return: 0,
          turnover: 0,
          fees_usd: 0,
          positions_count: 0,
          state: { positions: {}, orderPreview: bundle(), orderPreviewError: previewError },
        },
      ],
    );
    const Page = UsPortfolioView;
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>,
    );
  };

  it("retains historical model data but removes adjustment plans from portfolio history", () => {
    const html = renderPortfolio();
    expect(html).toContain("모델 체결 원장");
    expect(html).toContain("정규화 NAV 추적");
    expect(html).not.toContain("모델 조정 미리보기");
    expect(html).not.toContain("BUY1");
    expect(html).not.toContain("FUND1");
  });
  it("redirects the separate US portfolio route to the unified US subtab", () => {
    const beforeLoad = (Route.options as unknown as { beforeLoad: () => void }).beforeLoad;
    expect(beforeLoad).toThrow(
      expect.objectContaining({ to: "/portfolio", search: { asset: "US" }, replace: true }),
    );
  });
});
