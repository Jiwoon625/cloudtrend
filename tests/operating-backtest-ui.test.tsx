import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OperatingBacktestMetrics } from "../src/components/OperatingBacktestMetrics";
import {
  OPERATING_BACKTESTS,
  formatBacktestRatio,
  isOperatingBacktestReleaseReady,
  type OperatingBacktestRelease,
} from "../src/lib/operatingBacktests";
import { Route } from "../src/routes/operating-rules";

vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

function verifiedFixture(): OperatingBacktestRelease {
  return {
    ...OPERATING_BACKTESTS,
    books: OPERATING_BACKTESTS.books.map((book, index) => ({
      ...book,
      status: "verified",
      startDate: "2016-01-04",
      endDate: "2026-09-25",
      policyVersion: "synthetic-annual-policy-v1",
      closedTradeCount: 1000 + index,
      returnDefinitionId: "CLOSED_ROUND_TRIP_NET_RETURN_V1",
      proxyClosedTradeCount: 3,
      excludedOpenPositionCount: 2,
      returnDefinition: "합성 검증: 비용 차감 후 청산완료 포지션별 매매 수익률",
      meanReturn: 0.12876 + index / 100,
      medianReturn: 0.06123 + index / 100,
      mdd: -0.21345 - index / 100,
      cagr: 0.789,
      limitations: ["합성 검증 자료 · 투자 결과 아님"],
    })),
  };
}

function pendingFixture(): OperatingBacktestRelease {
  return {
    ...OPERATING_BACKTESTS,
    books: OPERATING_BACKTESTS.books.map((book) =>
      book.currency === "KRW" && book.book !== "ETF_V02" ? { ...book, status: "pending" } : book,
    ),
  };
}

const render = (market: string, release = OPERATING_BACKTESTS) =>
  renderToStaticMarkup(<OperatingBacktestMetrics market={market} release={release} />);

describe("operating-rule backtest release gate", () => {
  it("keeps every market's numbers hidden until all required results are verified", () => {
    const pending = pendingFixture();
    expect(isOperatingBacktestReleaseReady(pending)).toBe(false);
    const html = render("미국 A0", pending);
    expect(html).toContain("평균수익률");
    expect(html).toContain("연초 예산 연구 기준 · 운영 엔진 연결 전");
    expect(html).toContain("중앙값");
    expect(html).toContain("MDD");
    expect(html).toContain("전체 시장의 청산완료 매매 수익률과 계좌 최대낙폭 검증 후 표시");
    expect(html).not.toContain("23.36%");
    expect(html).not.toContain("4.10%");
    expect(html).not.toContain("-4.56%");
    expect(html).not.toContain("41.35%");
    expect(html).not.toContain("CAGR");
  });

  it("requires every individual-market and combined diagnostic, not just the US result", () => {
    const complete = verifiedFixture();
    expect(isOperatingBacktestReleaseReady(complete)).toBe(true);
    for (const book of complete.books) {
      const missing = {
        ...complete,
        books: complete.books.filter((row) => row.book !== book.book),
      };
      expect(isOperatingBacktestReleaseReady(missing)).toBe(false);
    }
  });

  it("blocks incomplete, invalid and non-trade metrics instead of substituting CAGR", () => {
    const complete = verifiedFixture();
    const invalid = [
      { status: "pending" },
      { returnBasis: "calendar_year" },
      { returnDefinitionId: null },
      { returnDefinitionId: "SALE_FILL_RETURN" },
      { proxyClosedTradeCount: -1 },
      { proxyClosedTradeCount: 1001 },
      { excludedOpenPositionCount: null },
      { closedTradeCount: null },
      { closedTradeCount: 0 },
      { closedTradeCount: 1.5 },
      { returnDefinition: null },
      { policyVersion: null },
      { startDate: null },
      { endDate: null },
      { meanReturn: null },
      { meanReturn: Number.NaN },
      { medianReturn: Number.POSITIVE_INFINITY },
      { mdd: 0.1 },
      { mdd: -1.01 },
    ];
    for (const patch of invalid) {
      const release = {
        ...complete,
        books: complete.books.map((book, index) => (index === 0 ? { ...book, ...patch } : book)),
      } as OperatingBacktestRelease;
      expect(isOperatingBacktestReleaseReady(release)).toBe(false);
      expect(render("미국 A0", release)).not.toContain("14.88%");
    }
  });
});

describe("concise verified metrics", () => {
  it("shows fee-adjusted closed trades and portfolio MDD with one period line", () => {
    const html = render("KOSPI", verifiedFixture());
    expect(html).toContain("12.88%");
    expect(html).toContain("6.12%");
    expect(html).toContain("-21.34%");
    expect(html).toContain("2016-01-04–2026-09-25 · KRW 기준");
    expect(html).toContain("청산완료 매매 1,000건");
    expect(html).toContain("MDD는 전체 계좌");
    expect(html).toContain("비용 차감 후 청산완료 포지션별");
    expect(html).toContain("미청산 보유분 평가를 포함한 전체기간");
    expect(html).toContain("모델 가정 청산 3건 포함");
    expect(html).toContain("미청산 2개 포지션 제외");
    expect(html).toContain("researchannualpolicy");
    expect(html).toContain("운영 엔진 연결 전");
    expect(html).toContain("<details");
    expect(html).not.toContain("CAGR");
    expect(html).not.toContain("78.90%");
    expect(html).not.toContain("<table");
  });

  it("keeps KOSPI/KOSDAQ standalone values separate from the Korean combined account", () => {
    const complete = verifiedFixture();
    expect(render("KOSPI", complete)).toContain("KOSPI 단독 진단 · 30종목 한도");
    expect(render("KOSDAQ", complete)).toContain("KOSDAQ 단독 진단 · 30종목 한도");
    expect(render("한국 통합", complete)).toContain("한국 통합 포트폴리오 · 합산 30종목 한도");
    expect(render("KOSPI", complete)).not.toContain("한국 통합 포트폴리오");
    expect(render("KOSPI", complete)).toContain("12.88%");
    expect(render("KOSDAQ", complete)).toContain("13.88%");
    expect(render("한국 통합", complete)).toContain("16.88%");
  });

  it("adds metrics only below each operating summary and one separate combined reference", () => {
    const Page = (Route.options as unknown as { component: React.ComponentType }).component;
    const html = renderToStaticMarkup(<Page />);
    expect((html.match(/백테스트 전체기간 성과/g) ?? []).length).toBe(5);
    expect(html.indexOf("KOSPI 백테스트 성과")).toBeGreaterThan(html.indexOf("운영규칙 요약"));
    expect(html.lastIndexOf("백테스트 전체기간 성과")).toBeLessThan(html.indexOf("운영규칙 상세"));
    expect(render("KOSPI 하락장 RS")).toBe("");
    expect(render("미국 A2 / B3")).toBe("");
  });

  it("preserves verified US ratios without publishing private source fields or superseded figures", () => {
    const us = OPERATING_BACKTESTS.books.find((row) => row.book === "US_A0")!;
    expect(us.mdd).toBe(-0.4135412593592195);
    expect(us.meanReturn).toBe(0.04096327960678457);
    expect(us.medianReturn).toBe(-0.04562277723557182);
    expect(us.closedTradeCount).toBe(1155);
    expect(us.proxyClosedTradeCount).toBe(11);
    expect(us.excludedOpenPositionCount).toBe(15);
    expect(us.cagr).toBe(0.233603820004475);
    expect(us.policyVersion).toBe("US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1");
    const json = JSON.stringify(OPERATING_BACKTESTS);
    for (const forbidden of [
      "initialCapital",
      "finalNAV",
      "owner",
      "private",
      "/workspace/",
      "74671.44",
      "709508",
      "14.66",
      "34.54",
    ])
      expect(json).not.toContain(forbidden);
  });

  it("preserves the verified ETF results while withholding them until Korean results are verified", () => {
    const etf = OPERATING_BACKTESTS.books.find((row) => row.book === "ETF_V02")!;
    expect(etf.status).toBe("verified");
    expect(etf.meanReturn).toBe(0.027272459666202356);
    expect(etf.medianReturn).toBe(-0.011226504241809028);
    expect(etf.mdd).toBe(-0.17438172483129855);
    expect(etf.closedTradeCount).toBe(453);
    expect(etf.proxyClosedTradeCount).toBe(2);
    expect(etf.excludedOpenPositionCount).toBe(10);
    expect(etf.currency).toBe("KRW");
    expect(etf.startDate).toBe("2017-01-11");
    expect(etf.endDate).toBe("2026-09-11");
    expect(etf.policyVersion).toBe("adopted-etf-annual-nav-volatility-research-v2");
    const html = render("ETF V0.2", pendingFixture());
    expect(html).not.toContain("2.73%");
    expect(html).not.toContain("-1.12%");
    expect(html).not.toContain("-17.44%");
    expect(html).toContain("전체 시장의 청산완료 매매 수익률과 계좌 최대낙폭 검증 후 표시");
  });

  it("publishes the five independently verified book results with the correct distinct scopes", () => {
    expect(isOperatingBacktestReleaseReady(OPERATING_BACKTESTS)).toBe(true);
    const expected = [
      ["KOSPI", "2.63%", "3.76%", "-31.10%", "1,223"],
      ["KOSDAQ", "2.93%", "2.25%", "-16.42%", "2,234"],
      ["미국 A0", "4.10%", "-4.56%", "-41.35%", "1,155"],
      ["ETF V0.2", "2.73%", "-1.12%", "-17.44%", "453"],
      ["한국 통합", "2.79%", "2.27%", "-30.27%", "2,405"],
    ] as const;
    for (const [market, mean, median, mdd, count] of expected) {
      const html = render(market);
      for (const value of [mean, median, mdd, `청산완료 매매 ${count}건`]) {
        expect(html).toContain(value);
      }
      expect(html).not.toContain("검증 후 표시");
      expect(html).not.toContain("<table");
    }
    expect(render("KOSPI")).toContain("2017-08-21–2026-09-11 · KRW 기준");
    expect(render("ETF V0.2")).toContain("2017-01-11–2026-09-11 · KRW 기준");
    expect(render("미국 A0")).toContain("2016-01-04–2026-09-25 · USD 기준");
    expect(render("KOSPI")).toContain("단독 수익률을 합산할 수 없다");
  });

  it("preserves Korean adopted and diagnostic results without merging their independent accounts", () => {
    const values = [
      [
        "KR_COMBINED_ADOPTED",
        0.027933662775892498,
        0.02272861231998757,
        -0.3027325107085198,
        2405,
        10,
        12,
      ],
      [
        "KOSPI_STANDALONE_DIAGNOSTIC",
        0.026309985796581607,
        0.03762319483737357,
        -0.3109536857837458,
        1223,
        3,
        5,
      ],
      [
        "KOSDAQ_STANDALONE_DIAGNOSTIC",
        0.02926271765736959,
        0.022474887039211588,
        -0.1642146542109153,
        2234,
        14,
        5,
      ],
    ] as const;
    for (const [book, mean, median, mdd, closed, proxy, open] of values) {
      const row = OPERATING_BACKTESTS.books.find((row) => row.book === book)!;
      expect(row.status).toBe("verified");
      expect(row.meanReturn).toBe(mean);
      expect(row.medianReturn).toBe(median);
      expect(row.mdd).toBe(mdd);
      expect(row.closedTradeCount).toBe(closed);
      expect(row.proxyClosedTradeCount).toBe(proxy);
      expect(row.excludedOpenPositionCount).toBe(open);
      expect(row.policyVersion).toBe("kr-annual-signal-year-research-v2");
    }
  });

  it("formats ratios as percentages without turning missing values into zero", () => {
    expect(formatBacktestRatio(0)).toBe("0.00%");
    expect(formatBacktestRatio(-0.4135412593592195)).toBe("-41.35%");
    expect(render("미국 A0")).not.toContain("0.00%");
  });
});
