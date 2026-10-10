import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OperatingBacktestMetrics } from "../src/components/OperatingBacktestMetrics";
import {
  OPERATING_BACKTESTS,
  formatBacktestRatio,
  formatBacktestPercentagePoints,
  isBenchmarkComparisonReady,
  isOperatingBacktestReleaseReady,
  isPortfolioAnnualReturnsReady,
  type PortfolioAnnualReturns,
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
      expect(html).not.toContain("전체 시장의 청산완료 매매 수익률과 계좌 최대낙폭 검증 후 표시");
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

describe("annual portfolio returns and full-period benchmark comparisons", () => {
  it("adds exactly three portfolio cells directly after the existing three cells", () => {
    const html = render("미국 A0");
    expect((html.match(/<dl /g) ?? []).length).toBe(2);
    expect((html.match(/<dt /g) ?? []).length).toBe(6);
    expect(html).toContain("매매 평균수익률");
    expect(html).toContain("계좌 MDD");
    expect(html).toContain("포트폴리오 평균수익률");
    expect(html).toContain("포트폴리오 중앙값");
    expect(html).toContain("전체기간 지수 대비");
    expect(html).not.toContain("포트폴리오 MDD");
    expect(html.indexOf('aria-label="포트폴리오 성과"')).toBeGreaterThan(html.indexOf("계좌 MDD"));
  });

  it("uses complete calendar years and their arithmetic mean and median, never CAGR", () => {
    const expected = [
      ["KOSPI", 2018, 8, "9.31%", "10.69%"],
      ["KOSDAQ", 2018, 8, "20.26%", "17.81%"],
      ["미국 A0", 2016, 10, "27.86%", "22.29%"],
      ["ETF V0.2", 2018, 8, "6.69%", "5.25%"],
      ["한국 통합", 2018, 8, "22.99%", "25.17%"],
    ] as const;
    for (const [market, firstYear, count, mean, median] of expected) {
      const row = OPERATING_BACKTESTS.books.find((book) => book.markets.includes(market))!;
      const annual = row.portfolioAnnualReturns!;
      expect(isPortfolioAnnualReturnsReady(annual, row.book)).toBe(true);
      expect(annual.years.map((point) => point.year)).toEqual(
        Array.from({ length: count }, (_, index) => firstYear + index),
      );
      expect(annual.meanReturn).not.toBe(row.cagr);
      expect(render(market)).toContain(mean);
      expect(render(market)).toContain(median);
      expect(render(market)).toContain(`${firstYear}–2025 연간수익률`);
      expect(render(market)).toContain("부분연도 제외");
    }
  });

  it("rejects partial-year inclusion, nonfinite, duplicate, missing and mismatched annual summaries", () => {
    const annual = OPERATING_BACKTESTS.books[0]!.portfolioAnnualReturns!;
    const invalid = [
      null,
      { ...annual, status: "pending" },
      { ...annual, definition: "CAGR" },
      { ...annual, weighting: "CLOSED_TRADE_COUNT" },
      { ...annual, partialYearsExcluded: false },
      { ...annual, years: [] },
      { ...annual, years: null },
      { ...annual, years: [annual.years[0], annual.years[0]] },
      { ...annual, years: annual.years.slice(1) },
      { ...annual, meanReturn: null },
      { ...annual, meanReturn: Number.NaN },
      { ...annual, medianReturn: Number.POSITIVE_INFINITY },
      { ...annual, meanReturn: annual.meanReturn! + 0.01 },
      { ...annual, medianReturn: annual.medianReturn! + 0.01 },
    ];
    for (const value of invalid)
      expect(
        isPortfolioAnnualReturnsReady(
          value as PortfolioAnnualReturns | null,
          "KOSPI_STANDALONE_DIAGNOSTIC",
        ),
      ).toBe(false);
  });

  it("uses same-period cumulative return difference in percentage points, not a wealth ratio", () => {
    const us = OPERATING_BACKTESTS.books.find((row) => row.book === "US_A0")!;
    const comparison = us.benchmarkComparison!;
    expect(isBenchmarkComparisonReady(us)).toBe(true);
    expect(comparison.startDate).toBe("2016-01-04");
    expect(comparison.endDate).toBe("2026-09-25");
    expect(comparison.portfolioCumulativeReturn).toBe(8.501738466218406);
    expect(comparison.benchmarkCumulativeReturn).toBe(3.5660384059858403);
    expect(comparison.excessReturn).toBeCloseTo(4.935700060232565, 12);
    const html = render("미국 A0");
    expect(html).toContain("+493.57%p");
    expect(html).toContain("SPY · 전체기간 누적수익률 차이(%p)");
    expect(html).toContain("부분연도를 포함한 전체 연구기간");
    expect(html).toContain("배당 총수익률 완전성은 인증하지 않았습니다");
  });

  it("rejects recomputed summaries that add partial years or drop complete years", () => {
    const annual = OPERATING_BACKTESTS.books[0]!.portfolioAnnualReturns!;
    const wrongYearSets = [
      [{ year: 2017, netReturn: 0.9 }, ...annual.years],
      [...annual.years, { year: 2026, netReturn: -0.9 }],
      annual.years.slice(1),
      annual.years.slice(0, -1),
    ];
    for (const years of wrongYearSets) {
      const sorted = years.map((row) => row.netReturn).sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      const recomputed = {
        ...annual,
        years,
        meanReturn: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
        medianReturn:
          sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
      };
      expect(isPortfolioAnnualReturnsReady(recomputed, "KOSPI_STANDALONE_DIAGNOSTIC")).toBe(false);
    }
    expect(isPortfolioAnnualReturnsReady(annual, "UNKNOWN_BOOK")).toBe(false);
  });

  it("withholds mismatched benchmark dates, currency and formula instead of displaying zero", () => {
    const us = OPERATING_BACKTESTS.books.find((row) => row.book === "US_A0")!;
    for (const patch of [
      { status: "pending" },
      { definition: "RELATIVE_WEALTH_RETURN" },
      { currency: "KRW" },
      { startDate: "2018-01-02" },
      { endDate: "2025-12-31" },
      { label: " " },
      { label: null },
      { limitation: "" },
      { portfolioCumulativeReturn: Number.NaN },
      { benchmarkCumulativeReturn: Number.POSITIVE_INFINITY },
      { excessReturn: 0 },
    ]) {
      const changed = {
        ...us,
        benchmarkComparison: { ...us.benchmarkComparison!, ...patch },
      } as typeof us;
      expect(isBenchmarkComparisonReady(changed)).toBe(false);
      const release = {
        ...OPERATING_BACKTESTS,
        books: OPERATING_BACKTESTS.books.map((row) => (row.book === us.book ? changed : row)),
      };
      expect(render("미국 A0", release)).not.toContain("+493.57%p");
      expect(render("미국 A0", release)).toContain("동일기간 지수 비교 검증 후 표시");
    }
    expect(isBenchmarkComparisonReady({ ...us, benchmarkComparison: null })).toBe(false);
    expect(formatBacktestPercentagePoints(0)).toBe("0.00%p");
    expect(formatBacktestPercentagePoints(-0.1234)).toBe("-12.34%p");
  });

  it("compares Korean books with their own exact full-period market-index endpoints", () => {
    for (const [market, label, expected, start, end] of [
      ["KOSPI", "KOSPI", "-48.88%p", 2355.0, 6909.91],
      ["KOSDAQ", "KOSDAQ", "+481.52%p", 640.85, 820.64],
      ["ETF V0.2", "KOSPI", "-110.14%p", 2075.17, 6909.91],
      ["한국 통합", "KOSPI", "+312.10%p", 2355.0, 6909.91],
    ] as const) {
      const row = OPERATING_BACKTESTS.books.find((book) => book.markets.includes(market))!;
      expect(isBenchmarkComparisonReady(row)).toBe(true);
      expect(row.benchmarkComparison!.benchmarkCumulativeReturn).toBeCloseTo(end / start - 1, 12);
      expect(render(market)).toContain(expected);
      expect(render(market)).toContain(`${label} · 전체기간 누적수익률 차이(%p)`);
      expect(render(market)).toContain("배당을 재투자한 총수익지수는 아닙니다");
      expect(render(market)).not.toContain("동일기간 지수 비교 검증 후 표시");
    }
  });

  it("publishes all five verified annual and benchmark summaries without pending placeholders", () => {
    for (const row of OPERATING_BACKTESTS.books) {
      expect(isPortfolioAnnualReturnsReady(row.portfolioAnnualReturns, row.book)).toBe(true);
      expect(isBenchmarkComparisonReady(row)).toBe(true);
      const html = render(row.markets[0]!);
      expect(html).not.toContain("동일기간 지수 비교 검증 후 표시");
      expect(html).not.toContain(">—</dd>");
    }
    const combined = OPERATING_BACKTESTS.books.find((row) => row.book === "KR_COMBINED_ADOPTED")!;
    expect(combined.benchmarkComparison!.portfolioCumulativeReturn).toBe(5.05515324609);
    expect(combined.benchmarkComparison!.excessReturn).toBeCloseTo(3.121008872416964, 12);
  });
});
