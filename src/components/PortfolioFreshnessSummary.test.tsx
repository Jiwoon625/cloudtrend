import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PortfolioFreshnessSummary } from "./PortfolioFreshnessSummary";
import type { DualPortfolioState, StrategyLedger } from "@/lib/portfolioLedgers";
const strategy = {
  trades: [],
  candidates: [
    {
      key: "036930|2026-10-06",
      symbol: "036930",
      name: "주성엔지니어링",
      market: "KOSDAQ",
      signalDate: "2026-10-06",
      entryDate: null,
      price: null,
      decision: "다음 거래일 대기",
    },
    {
      key: "053800|2026-10-06",
      symbol: "053800",
      name: "안랩",
      market: "KOSDAQ",
      signalDate: "2026-10-06",
      entryDate: null,
      price: null,
      decision: "다음 거래일 대기",
    },
    {
      key: "078340|2026-10-06",
      symbol: "078340",
      name: "컴투스",
      market: "KOSDAQ",
      signalDate: "2026-10-06",
      entryDate: null,
      price: null,
      decision: "다음 거래일 대기",
    },
  ],
  summary: { latestDate: "2026-10-06" },
  calculatedAt: "2026-10-07T00:00:00Z",
} as unknown as StrategyLedger;
const state = {
  document: {
    strategy,
    executions: [
      {
        symbol: "036930",
        market: "KOSDAQ",
        signalKey: "036930|2026-10-06",
        side: "BUY",
        shares: 2,
        price: 100,
        date: "2026-10-07",
      },
    ],
  },
} as DualPortfolioState;
describe("dashboard portfolio freshness", () => {
  it("shows refreshed time separately from market as-of and separates model expectation from actual fills", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:30:00Z"));
    try {
      const html = renderToStaticMarkup(
        <PortfolioFreshnessSummary
          state={state}
          screeningDate="2026-10-06"
          pending={false}
          error={false}
        />,
      );
      expect(html).toContain("스크리닝 2026-10-06 · 포트폴리오 시세 기준일 일치");
      expect(html).toContain("2026-10-07");
      expect(html).toContain("오늘 3종목");
      for (const name of ["주성엔지니어링", "안랩", "컴투스"]) expect(html).toContain(name);
      expect(html).toContain("실제 체결 기록 있음");
      expect(html).toContain("시가 미확인");
      expect(html).toContain("입력이 같으면 저장 결과 재사용");
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not label a failed or unfinished refresh as current", () => {
    const loading = renderToStaticMarkup(
      <PortfolioFreshnessSummary
        state={state}
        screeningDate="2026-10-06"
        pending={true}
        error={false}
      />,
    );
    expect(loading).toContain("포트폴리오 확인 중");
    expect(loading).not.toContain("반영 완료");
    const failed = renderToStaticMarkup(
      <PortfolioFreshnessSummary
        state={state}
        screeningDate="2026-10-06"
        pending={false}
        error={true}
      />,
    );
    expect(failed).toContain("최신 상태 미확인");
    expect(failed).not.toContain("반영 완료");
  });
});
