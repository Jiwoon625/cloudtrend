import { DomesticAssessmentPanel } from "../src/components/DomesticAssessmentPanel";
import { marketSignals, projectKrDashboard } from "../src/lib/dashboardOperations";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EtfScreener } from "../src/components/EtfScreener";
import { EtfInstrumentDetail } from "../src/components/EtfInstrumentDetail";
import { StockAssessmentDetails } from "../src/components/StockAssessmentDetails";
import { StockInstrumentSummary } from "../src/components/StockInstrumentSummary";
import { getCompactStockStatus } from "../src/lib/stockCompactStatus";
import {
  getPortfolioAwareDisplayStatus,
  isHeldExit,
  isPortfolioAwareOperationalEntry,
} from "../src/lib/statusDisplay";
import { ETF_POLICY } from "../src/lib/engine/etfStrategy";
import { OPERATIONAL_SIGNAL_VERSION } from "../src/lib/engine/operationalStrategy";
import { kospiEntryConfirmation } from "../src/lib/engine/kospiEntryConfirmation";
import { kospiGate } from "./kospi-policy-fixtures";
import type { AnalysisResult, ScreeningRow } from "../src/lib/engine/pipeline";
import { stockAssessmentDisplay } from "../src/lib/stockAssessmentDisplay";
import { BEFORE_OPERATIONAL_START, PRE_START_ORIGIN } from "../src/lib/operationalSignalStart";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("../src/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
const empty = { heldSymbols: [], lastSellDateBySymbol: {} };
const held = { ...empty, heldSymbols: ["000001"] };
function stock(date: string, market: "KOSPI" | "KOSDAQ" = "KOSDAQ"): ScreeningRow {
  return {
    instrument: {
      symbol: "000001",
      name: "검증종목",
      market,
      instrumentType: "STOCK",
      sectorName: "반도체",
      indexMemberships: [],
    },
    snapshot: { tradeDate: date, close: 10000, volumeRatio20: 150 },
    operatingScore10: 9,
    previousOperatingScore10: 7,
    scoreDelta1d: 20,
    technical: { points: 9, maxPoints: 10 },
    priority: { points: 1, maxPoints: 5 },
    grade: "A",
    hardFilterStatus: "PASS",
    hardFilterPassed: true,
    pendingRules: [],
    failedRules: [],
    warnings: [],
    operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
    kosdaq80Onset: true,
  } as unknown as ScreeningRow;
}
function etf(date: string, originDate: string): ScreeningRow {
  const r = stock(date);
  return {
    ...r,
    instrument: { ...r.instrument, market: "ETF", instrumentType: "ETF" },
    etfStrategy: {
      version: ETF_POLICY.version,
      date,
      originDate,
      confirmationDate: date,
      entryState: "confirmed",
      onset: true,
      rawOnset: true,
      dataStatus: "ready",
      eligible: true,
      score: 81,
      previousScore: 79,
      previousDate: originDate,
      technical: 80,
      priority: 50,
      health: 80,
      environment: 80,
      environmentSource: "own_index_lag1",
      sector: "MARKET_IDX",
      region: "US",
      issues: [],
      exit: "MA60",
      underlyingClose: 99,
      underlyingMa60: 100,
      averageTradingValue20: 1e10,
      annualVolatility: 0.2,
      entryWeight: 0.05,
    },
  } as ScreeningRow;
}
describe("latest website starts all operational signals on October 12", () => {
  it("keeps old KR source evidence but excludes old entry and held exit for either held source", () => {
    const r = stock("2026-10-09");
    const original = structuredClone(r);
    expect(stockAssessmentDisplay(r, "2026-10-09").rawOnset).toBe(true);
    expect(isPortfolioAwareOperationalEntry(r, empty, "2026-10-09")).toBe(false);
    expect(isHeldExit(r, held, "2026-10-09")).toBe(false);
    expect(getCompactStockStatus(r, held, "2026-10-09").primary).toBe(BEFORE_OPERATIONAL_START);
    expect(getPortfolioAwareDisplayStatus(r, held, "2026-10-09")).toBe(BEFORE_OPERATIONAL_START);
    const html = renderToStaticMarkup(
      <StockInstrumentSummary row={r} asOfDate="2026-10-09" positionContext={held} />,
    );
    expect(html).toContain(BEFORE_OPERATIONAL_START);
    expect(html).toContain("8.0점 신규 돌파 충족");
    expect(html).not.toContain("저장된 운영 진입 조건 충족");
    expect(r).toEqual(original);
  });
  it("does not suppress held exit evidence because an unrelated origin predates restart", () => {
    const r = stock("2026-10-12");
    const assessment = stockAssessmentDisplay(r, "2026-10-12");
    const html = renderToStaticMarkup(
      <StockAssessmentDetails
        assessment={assessment}
        held
        signalDate="2026-10-12"
        originDate="2026-10-09"
      />,
    );
    expect(html).toContain(assessment.exit);
    expect(html).toContain(PRE_START_ORIGIN);
  });
  it("includes October 12 KOSDAQ signals and retains A3 current-date held-exit policy", () => {
    const r = stock("2026-10-12");
    expect(isPortfolioAwareOperationalEntry(r, empty, "2026-10-12")).toBe(true);
    expect(isHeldExit(r, held, "2026-10-12")).toBe(true);
    expect(isHeldExit(r, held, "2026-10-13")).toBe(false);
    expect(getPortfolioAwareDisplayStatus(stock("2026-10-09"), empty, "2026-10-12")).toBe(
      "판단 미확인 · 기준일 가격 확인 필요",
    );
  });
  it("cannot revive October 9 KOSPI onset when confirmed October 12", () => {
    const r = stock("2026-10-12", "KOSPI");
    const obs = (date: string, score: number) => ({
      date,
      score,
      rsAccel: 1,
      eligible: true,
      observed: true,
      marketGate: kospiGate(date),
    });
    r.kospiEntry = kospiEntryConfirmation(
      obs("2026-10-12", 8.5),
      obs("2026-10-09", 8),
      obs("2026-10-08", 7),
    );
    expect(r.kospiEntry.state).toBe("confirmed");
    expect(isPortfolioAwareOperationalEntry(r, empty, "2026-10-12")).toBe(false);
    expect(getCompactStockStatus(r, empty, "2026-10-12").primary).toBe(PRE_START_ORIGIN);
    expect(getPortfolioAwareDisplayStatus(r, empty, "2026-10-12")).toBe(PRE_START_ORIGIN);
    const analysis = {
      rows: [r],
      asOfDate: "2026-10-12",
      tradeDates: ["2026-10-09", "2026-10-12"],
    } as AnalysisResult;
    const signals = marketSignals(
      projectKrDashboard(analysis),
      "KOSPI",
      [],
      [],
      null,
      "2026-10-12",
    );
    expect(signals.onsetCount).toBe(0);
    const html = renderToStaticMarkup(<DomesticAssessmentPanel markets={[signals]} />);
    expect(html).toContain(PRE_START_ORIGIN);
    expect(html).not.toContain("저장된 운영 진입 조건 충족");
  });
  it.each([
    ["2026-10-09", "2026-10-08", BEFORE_OPERATIONAL_START],
    ["2026-10-12", "2026-10-09", PRE_START_ORIGIN],
  ])("keeps ETF old evidence without actionable labels on %s", (date, origin, label) => {
    const r = etf(date!, origin!);
    const a = { rows: [r], asOfDate: date } as AnalysisResult;
    const list = renderToStaticMarkup(<EtfScreener analysis={a} positionContext={empty} />);
    const detail = renderToStaticMarkup(
      <EtfInstrumentDetail
        row={r}
        asOfDate={date!}
        calculatedAt="2026-10-11T00:00:00Z"
        held={false}
      />,
    );
    expect(list).toContain(label!);
    expect(detail).toContain(label!);
    expect(list).not.toContain("진입 준비 · 다음 시가 진입");
    expect(detail).not.toContain(">진입 준비 · 다음 시가 진입<");
    expect(detail).toContain("원신호");
    expect(r.etfStrategy?.onset).toBe(true);
  });
  it("does not expose ready labels for a confirmed ETF with missing origin", () => {
    const r = etf("2026-10-13", "2026-10-12");
    r.etfStrategy!.originDate = null;
    const analysis = { rows: [r], asOfDate: "2026-10-13" } as AnalysisResult;
    for (const html of [
      renderToStaticMarkup(<EtfScreener analysis={analysis} positionContext={empty} />),
      renderToStaticMarkup(
        <EtfInstrumentDetail
          row={r}
          asOfDate="2026-10-13"
          held={false}
          calculatedAt="2026-10-13T00:00:00Z"
        />,
      ),
    ]) {
      expect(html).toContain("원신호 시점 미확인 · 진입 제외");
      expect(html).not.toContain(">진입 준비 · 다음 시가 진입<");
      expect(html).not.toContain("진입 준비 · 다음 시가 진입");
    }
  });
  it("does not turn an October 9 ETF held exit into an October 12 instruction", () => {
    const r = etf("2026-10-09", "2026-10-08");
    const html = renderToStaticMarkup(
      <EtfInstrumentDetail
        row={r}
        asOfDate="2026-10-12"
        held
        calculatedAt="2026-10-12T00:00:00Z"
      />,
    );
    expect(html).toContain("보유 · 판단 미확인");
    expect(html).not.toContain(">청산 준비<");
  });
  it("permits ETF post-start confirmation without overwriting the stored strategy", () => {
    const r = etf("2026-10-13", "2026-10-12");
    const a = { rows: [r], asOfDate: "2026-10-13" } as AnalysisResult;
    expect(renderToStaticMarkup(<EtfScreener analysis={a} positionContext={empty} />)).toContain(
      "진입 준비 · 다음 시가 진입",
    );
    expect(
      renderToStaticMarkup(
        <EtfInstrumentDetail
          row={r}
          asOfDate="2026-10-13"
          calculatedAt="2026-10-13T00:00:00Z"
          held={false}
        />,
      ),
    ).toContain(">진입 준비 · 다음 시가 진입<");
  });
});
