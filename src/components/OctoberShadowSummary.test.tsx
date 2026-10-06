import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OctoberShadowSummaryContent } from "./OctoberShadowSummary";
import { summarizeOctoberShadowBook } from "@/lib/octoberShadowSummary.server";
import { ADOPTED_SERIES_KINDS, ADOPTED_SERIES_VERSION } from "@/lib/ledger/modelSeries";
import { fixtureSeries, registry, sessionRow, usRun } from "../../tests/october-shadow-fixtures";
vi.mock("@/lib/octoberShadowSummary.functions", () => ({ octoberShadowSummaryServer: vi.fn() }));
vi.mock("@/lib/cloud", () => ({ supabase: {} }));
const checkedAt = "2026-10-14T21:00:00Z";
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
      version: ADOPTED_SERIES_VERSION,
      viewVersion: "october-shadow-holdings-tax-v1",
      readyForPortfolioConsolidation: true,
      checkedAt,
      books,
    });
    expect((html.match(/초기화 완료 · 첫 실제 세션 대기/g) ?? []).length).toBe(8);
    expect(html).toContain("KOSPI 하루확인·불황 시 RSAccel 필터");
    expect(html).toContain("$73,551.04");
    expect(html).toContain("6.016원");
    expect(html).toContain("0 / 0");
    expect(html).toContain("초기화는 거래일 기록이 아닙니다");
    expect(html).toContain("첫 세션 대기");
    expect(html).not.toContain("실제 소유자 · 과세대상 계좌 합산");
  });
  it("shows persisted first date and independently verified zero tax after a real model session", async () => {
    const series = await fixtureSeries();
    const book = await summarizeOctoberShadowBook(
      "US_A0",
      registry(series),
      [sessionRow(await usRun(series))],
      true,
      checkedAt,
    );
    const html = render({
      version: ADOPTED_SERIES_VERSION,
      viewVersion: "october-shadow-holdings-tax-v1",
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
      entryDate: "2026-10-13",
    },
  ];
  const html = render({
    version: ADOPTED_SERIES_VERSION,
    viewVersion: "october-shadow-holdings-tax-v1",
    readyForPortfolioConsolidation: false,
    checkedAt,
    books: [book],
  });
  expect(html).toContain("Synthetic Holding");
  expect(html).toContain("$1,000.00");
  expect(html).toContain("목표 20종목 고정 매입 예산");
  expect(html).not.toContain("매수 기록 저장");
});

it("shows allocator as an uninitialized separate CM6 placeholder without a ninth registry", () => {
  const html = render(null);
  expect(html).toContain("자산배분 통합 Shadow");
  expect(html).toContain("배분전략 확정 대기 · CM6");
  expect(html).toContain("가상 총자금 1억원");
  expect(html).toContain("8개 독립 장부의 자금을 합산하지 않습니다");
});
