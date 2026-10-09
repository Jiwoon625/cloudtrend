import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OctoberShadowSummaryContent } from "./OctoberShadowSummary";
import { summarizeOctoberShadowBook } from "@/lib/octoberShadowSummary.server";
import { ADOPTED_SERIES_KINDS, RESTART_SERIES_VERSION } from "@/lib/ledger/modelSeries";
import { registry } from "../../tests/october-shadow-fixtures";
import { restartSeries as fixtureSeries, restartBook } from "../../tests/website-restart-fixtures";
vi.mock("@/lib/octoberShadowSummary.functions", () => ({ octoberShadowSummaryServer: vi.fn() }));
vi.mock("@/lib/cloud", () => ({ supabase: {} }));
const checkedAt = "2026-10-12T21:00:00Z";
const render = (
  summary: Parameters<typeof OctoberShadowSummaryContent>[0]["summary"],
  options = {},
) =>
  renderToStaticMarkup(
    <OctoberShadowSummaryContent
      summary={summary}
      loading={false}
      error={null}
      refresh={() => {}}
      {...options}
    />,
  );
describe("October Shadow registry cards", () => {
  it("shows all eight waiting books separately, including exact residual and unambiguous label", async () => {
    const books = await Promise.all(
      ADOPTED_SERIES_KINDS.map(async (kind) =>
        summarizeOctoberShadowBook(kind, registry(await fixtureSeries(kind)), [], true, checkedAt),
      ),
    );
    const html = render({
      version: RESTART_SERIES_VERSION,
      viewVersion: "october-shadow-holdings-tax-v2",
      replayStatus: [],
      readyForPortfolioConsolidation: true,
      checkedAt,
      books,
    });
    expect((html.match(/초기화 완료 · 첫 실제 세션 대기/g) ?? []).length).toBe(8);
    expect(html).toContain("KOSPI 하루확인·불황 시 RSAccel 필터");
    expect(html).toContain("$74,671.44");
    expect(html).not.toContain("계좌별 초기 투자금액 ÷ 고정 목표 20종목");
    expect(html).not.toContain("정기 리밸런싱과 신규 진입 자금 마련용 부분매도는 하지 않으며");
    expect(html).toContain("7.552원");
    expect(html).toContain("0 / 0");
    expect(html).toContain("초기화는 거래일 기록이 아닙니다");
    expect(html).toContain("첫 세션 대기");
    expect(html).not.toContain("실제 소유자 · 과세대상 계좌 합산");
  });
  it("shows retrospective replay and a deferred input reason separately from signal date", async () => {
    const books = await Promise.all(
      ADOPTED_SERIES_KINDS.map(async (kind) =>
        summarizeOctoberShadowBook(kind, registry(await fixtureSeries(kind)), [], true, checkedAt),
      ),
    );
    const html = render({
      version: RESTART_SERIES_VERSION,
      viewVersion: "october-shadow-holdings-tax-v2",
      readyForPortfolioConsolidation: true,
      checkedAt,
      replayStatus: [
        {
          market: "KR",
          signalDate: "2026-10-12",
          calculatedAt: "2026-10-14T00:00:00Z",
          sourceCapturedAt: "2026-10-14T00:00:00Z",
          modelDecisionAt: "2026-10-13T08:10:00+09:00",
          executionAt: "2026-10-13T09:00:00+09:00",
          replayMode: "RETROSPECTIVE",
          status: "WAITING_INPUT",
          reason: "해당 거래일 종목 행이 없습니다.",
        },
      ],
      books,
    });
    expect(html).toContain("한국 Shadow replay");
    expect(html).toContain("신호 기준일 2026-10-12");
    expect(html).toContain("사후 복원 계산");
    expect(html).toContain("자료 대기");
    expect(html).toContain("보류 사유: 해당 거래일 종목 행이 없습니다.");
  });

  it("shows persisted first date and independently verified zero tax after a real model session", async () => {
    const book = await restartBook("US_A0", true);
    const html = render({
      version: RESTART_SERIES_VERSION,
      viewVersion: "october-shadow-holdings-tax-v2",
      replayStatus: [],
      readyForPortfolioConsolidation: true,
      checkedAt,
      books: [book],
    });
    expect(html).toContain("실제 세션 기록 연결됨");
    expect(html).toContain("최초 실제 기록 세션</dt><dd>2026-10-12");
    expect(html).toContain("가상 납세자");
  });
  it("renders loading, retry button disabled during fetching, and explicit read failure", () => {
    const loading = render(null, { loading: true, refreshing: true });
    expect(loading).toContain('role="status"');
    expect(loading).toContain('disabled=""');
    const failure = render(null, { error: "세션 조회 실패" });
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("세션 조회 실패");
    expect(failure).not.toContain("초기화 완료");
  });
});

it("shows the independent holdings table and fixed-budget rule without actual-account actions", async () => {
  const series = await fixtureSeries();
  const book = await summarizeOctoberShadowBook("US_A0", registry(series), [], true, checkedAt);
  book.holdings = [
    {
      symbol: "SYNTH",
      name: "Synthetic Holding",
      quantity: "10",
      price: "100",
      value: "1000",
      entryDate: "2026-10-12",
    },
  ];
  const html = render({
    version: RESTART_SERIES_VERSION,
    viewVersion: "october-shadow-holdings-tax-v2",
    replayStatus: [],
    readyForPortfolioConsolidation: false,
    checkedAt,
    books: [book],
  });
  expect(html).toContain("Synthetic Holding");
  expect(html).toContain("$1,000.00");
  expect(html).not.toContain("10월 5일 신규 장부:");
  expect(html).not.toContain("매수 기록 저장");
});

it("shows allocator as an uninitialized separate CM6 placeholder without a ninth registry", () => {
  const html = render(null);
  expect(html).toContain("자산배분 통합 Shadow");
  expect(html).toContain("배분전략 확정 대기 · CM6");
  expect(html).toContain("총 계획금액과 시장 배분을 확인한 뒤");
  expect(html).toContain("8개 독립 장부의 자금을 합산하지 않습니다");
});

it("renders only the selected book and excludes beta replay from a restart view", async () => {
  const books = await Promise.all(
    ADOPTED_SERIES_KINDS.map(async (kind) =>
      summarizeOctoberShadowBook(kind, registry(await fixtureSeries(kind)), [], true, checkedAt),
    ),
  );
  const html = renderToStaticMarkup(
    <OctoberShadowSummaryContent
      selectedKind="US_A0"
      loading={false}
      error={null}
      refresh={() => {}}
      summary={{
        version: "adopted-shadow-2026-10-12-v1",
        viewVersion: "october-shadow-holdings-tax-v2",
        readyForPortfolioConsolidation: true,
        checkedAt,
        books,
        replayStatus: [
          {
            market: "KR",
            signalDate: "2026-10-08",
            calculatedAt: checkedAt,
            sourceCapturedAt: null,
            modelDecisionAt: checkedAt,
            executionAt: null,
            replayMode: "RETROSPECTIVE",
            status: "WAITING_INPUT",
            reason: "BETA_ONLY",
          },
        ],
      }}
    />,
  );
  expect((html.match(/<article/g) ?? []).length).toBe(1);
  expect(html).toContain("미국 A0 고정예산");
  expect(html).not.toContain("BETA_ONLY");
  expect(html).not.toContain("KOSDAQ 현행전략");
});

it("does not render a beta payload even if a stale cache provides one", async () => {
  const book = await restartBook();
  book.nav = "987654321";
  const html = render({
    version: "adopted-shadow-2026-10-05-v1",
    viewVersion: "october-shadow-holdings-tax-v2",
    checkedAt,
    readyForPortfolioConsolidation: true,
    books: [book],
    replayStatus: [],
  });
  expect(html).not.toContain("987,654,321");
  expect(html).not.toContain("2026-10-05");
  expect(html).not.toContain("초기화 완료");
});
