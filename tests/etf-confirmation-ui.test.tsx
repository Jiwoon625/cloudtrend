import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EtfScreener } from "../src/components/EtfScreener";
import { ETF_POLICY } from "../src/lib/engine/etfStrategy";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import type { DualPortfolioState } from "../src/lib/portfolioLedgers";
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
const date = "2026-10-01";
function page(
  state: "pending" | "confirmed" | "rejected",
  ledger?: DualPortfolioState,
  dataPending = false,
) {
  const analysis = {
    asOfDate: date,
    rows: [
      {
        instrument: {
          symbol: "360750",
          name: "검증 ETF",
          instrumentType: "ETF",
          sectorName: "시장대표",
        },
        snapshot: { tradeDate: date, close: 10000 },
        etfStrategy: {
          dataStatus: dataPending ? "krx_batch_pending" : "ready",
          krxReferenceDate: dataPending ? "2026-09-30" : null,
          version: ETF_POLICY.version,
          date,
          eligible: true,
          score: state === "rejected" ? 79 : 81,
          previousScore: 81,
          previousDate: "2026-09-30",
          technical: 90,
          priority: 0,
          health: 100,
          environment: 100,
          environmentSource: "own_index_lag1",
          region: "US",
          sector: "MARKET_IDX",
          annualVolatility: 0.3,
          entryWeight: 0.05,
          underlyingClose: 100,
          underlyingMa60: 99,
          onset: state === "confirmed",
          entryState: state,
          originDate: "2026-09-30",
          confirmationDate: state === "pending" ? null : date,
          confirmationIssues: state === "rejected" ? ["확인일 M0 80 미만 또는 결측"] : [],
          averageTradingValue20: 2e9,
          exit: null,
          issues: [],
        },
      },
    ],
  } as unknown as AnalysisResult;
  return renderToStaticMarkup(<EtfScreener analysis={analysis} {...(ledger ? { ledger } : {})} />);
}
const book = {
  document: { executions: [] },
  etfActual: { positions: [] },
  etfTrackedSymbols: [],
} as unknown as DualPortfolioState;
describe("ETF screener rendered state contract", () => {
  it("labels batch arrival separately from a normal exit", () => {
    const html = page("confirmed", book, true);
    expect(html).toContain("KRX 금액·기초지수 자료가 일괄 미수신");
    expect(html).toContain("KRX 자료 대기 · 신호 판단 보류");
    expect(html).not.toContain('aria-label="360750 주문가격"');
  });
  it("shows pending dates without an order input", () => {
    const html = page("pending", book);
    expect(html).toContain("하루 확인 대기");
    expect(html).toContain("원신호 2026-09-30");
    expect(html).not.toContain('aria-label="360750 주문가격"');
  });
  it("shows confirmed next-open entry, liquidity, and order price", () => {
    const html = page("confirmed", book);
    expect(html).toContain("진입 준비 · 다음 시가 진입");
    expect(html).toContain("2,000,000,000");
    expect(html).not.toContain('aria-label="360750 주문가격"');
    expect(html).toContain("포트폴리오");
  });
  it("shows rejection reasons without a signal order input", () => {
    const html = page("rejected", book);
    expect(html).toContain("확인일 M0 80 미만 또는 결측");
    expect(html).not.toContain('aria-label="360750 주문가격"');
  });
  it("requires real holdings and suppresses held or consumed entries", () => {
    expect(page("confirmed")).toContain("보유정보 확인 필요");
    expect(page("confirmed")).not.toContain('aria-label="360750 주문가격"');
    expect(page("confirmed", { ...book, etfTrackedSymbols: ["360750"] })).toContain(
      "보유 · 추가 매수 없음",
    );
    const sold = {
      ...book,
      document: {
        executions: [
          { symbol: "360750", market: "ETF", side: "SELL", shares: 1, date: "2026-09-30" },
        ],
      },
    } as unknown as DualPortfolioState;
    expect(page("confirmed", sold)).toContain("청산한 신호 · 재진입 제외");
    expect(page("confirmed", sold)).not.toContain('aria-label="360750 주문가격"');
  });
});
