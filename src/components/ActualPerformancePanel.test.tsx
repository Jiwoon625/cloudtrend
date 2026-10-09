import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActualPerformancePanel } from "./ActualPerformancePanel";
import {
  confirmActualPerformanceBaseline,
  appendActualPerformanceObservation,
  pendingActualPerformance,
  type PerformanceBaseline,
} from "@/lib/ledger/actualPerformance";

describe("actual performance restart presentation", () => {
  it("shows pending evidence without invented capital, FX, NAV or zero return", () => {
    const html = renderToStaticMarkup(<ActualPerformancePanel />);
    expect(html).toContain("2026-10-12 신규 운용분 성과");
    expect(html).toContain("준비 중 · 배정 현금 확정 대기");
    expect(html).toContain("미확정");
    expect(html).toContain("실제 배정한 부분만 한 번");
    expect(html).not.toContain("0.00%");
    expect(html).not.toContain("1339.2");
    expect(html).not.toContain("100,000,000");
    expect(html).not.toContain("<button");
  });
  it("distinguishes loading/error from pending setup and never substitutes legacy P&L", () => {
    const loading = renderToStaticMarkup(<ActualPerformancePanel loading />);
    expect(loading).toContain("확인 중");
    expect(loading).not.toContain("대조 대기");
    const failed = renderToStaticMarkup(<ActualPerformancePanel error={new Error("synthetic")} />);
    expect(failed).toContain("기준자료를 확인하지 못했습니다");
    expect(failed).not.toContain("대조 대기");
  });
  it("fails closed on an invalid stored series", () => {
    const series = pendingActualPerformance();
    (series as { id: string }).id = "unrecognized";
    const html = renderToStaticMarkup(<ActualPerformancePanel series={series} />);
    expect(html).toContain("기준자료를 확인하지 못했습니다");
    expect(html).not.toContain("0.00%");
  });
});

function syntheticSeries() {
  const source = {
    system: "broker" as const,
    recordId: "synthetic-ui-only",
    revision: "1",
    contentHash: `sha256:${"b".repeat(64)}`,
  };
  const cash = "1000000000000000000000";
  const baseline: PerformanceBaseline = {
    scope: "POST_START_ALLOCATED_CAPITAL",
    baseCurrency: "KRW",
    scopeConfirmed: true,
    accountScope: [{ accountId: "synthetic", currency: "KRW" }],
    pricePolicy: "EXPLICIT_DATED_MARKS_BEFORE_START",
    valuation: {
      date: "2026-10-12",
      recordedAt: "2026-10-11T12:00:00Z",
      source,
      complete: true,
      fx: [],
      accounts: [
        {
          accountId: "synthetic",
          currency: "KRW",
          cash,
          knownCashDelta: "0",
          unsettledCash: "0",
          positions: [],
          equity: cash,
          issues: [],
        },
      ],
    },
    confirmedAt: "2026-10-11T12:00:00Z",
    sourceRevisions: { domestic: 1, us: 1 },
    betaArchive: { asOfDate: "2026-10-09", source, summaries: { "합성 베타 손익": "7 KRW" } },
  };
  return confirmActualPerformanceBaseline(pendingActualPerformance(), baseline);
}
describe("confirmed actual performance display", () => {
  it("keeps a confirmed opening distinct from the first daily result and renders exact large money", () => {
    const html = renderToStaticMarkup(<ActualPerformancePanel series={syntheticSeries()} />);
    expect(html).toContain("첫 일별 평가 대기");
    expect(html).toContain("1,000,000,000,000,000,000,000 KRW");
    expect(html).not.toContain("베타 종료 요약");
    expect(html).not.toContain("7 KRW");
    expect(syntheticSeries().baseline?.betaArchive.summaries).toEqual({
      "합성 베타 손익": "7 KRW",
    });
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("0.00%");
  });
  it("renders only separately recorded daily observations as new performance", () => {
    const series = syntheticSeries();
    const recorded = appendActualPerformanceObservation(series, {
      valuation: { ...series.baseline!.valuation, recordedAt: "2026-10-12T23:00:00Z" },
      allocationConfirmed: true,
      tradeAllocations: [],
      cashAdjustments: [],
      previousDate: "2026-10-12",
      intervalComplete: true,
      flowsComplete: true,
      flows: [],
    });
    const html = renderToStaticMarkup(<ActualPerformancePanel series={recorded} />);
    expect(html).toContain("대조된 일별 성과");
    expect(html).toContain("새 구간 일별 평가 기록");
    expect(html).toContain("0%");
    expect(html).toContain("외부 입출금 조정 손익");
  });
});
