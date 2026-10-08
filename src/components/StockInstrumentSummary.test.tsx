import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AnalysisResult, ScreeningRow } from "@/lib/engine/pipeline";
import { OPERATIONAL_SIGNAL_VERSION } from "@/lib/engine/operationalStrategy";
import type { DomesticPositionContext } from "@/lib/positionSignalContext";
import { StockInstrumentSummary } from "./StockInstrumentSummary";
import { Route } from "@/routes/instrument.$symbol";

const state = vi.hoisted(() => ({
  row: null as ScreeningRow | null,
  positions: { heldSymbols: [], lastSellDateBySymbol: {} } as DomesticPositionContext,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  lazy: () => () => <section aria-label="상세 차트">상세 차트</section>,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => ({ symbol: state.row!.instrument.symbol }),
  }),
  notFound: () => new Error("not found"),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: state.positions }),
  useSuspenseQuery: () => ({
    data: {
      analysis: {
        asOfDate: "2026-10-08",
        tradeDates: ["2026-10-06", "2026-10-07", "2026-10-08"],
        rows: [state.row],
        strategyVersion: "fixture-v8",
        dataVersion: "fixture-data",
        dataProvider: "stored-fixture",
      } as AnalysisResult,
    },
  }),
}));
vi.mock("@/lib/analysisQuery", () => ({
  analysisQueryOptions: {},
  withThreeDecimalClv: (block: unknown) => block,
}));
vi.mock("@/lib/portfolioPositionContext", () => ({ loadDomesticPositionContext: vi.fn() }));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/StrategyDescription", () => ({
  StrategyDescription: () => <p>전략 설명</p>,
}));

const date = "2026-10-08";
const tradeDates = ["2026-10-06", "2026-10-07", date];
const pendingReason = "기준일 시가총액 미확인 · 판단 보류";
function row(overrides: Partial<ScreeningRow> = {}): ScreeningRow {
  const block = { points: 8, maxPoints: 10, availableMaxPoints: 10, rows: [] };
  return {
    instrument: {
      symbol: "000001",
      name: "저장 지표 검증 종목",
      market: "KOSPI",
      instrumentType: "STOCK",
      sectorName: "반도체",
      indexMemberships: [],
    },
    snapshot: {
      tradeDate: date,
      close: 35000,
      volumeRatio20: 175.5,
      tradingValueRatio20: 180,
      distanceFrom52wHigh: -4.2,
      closeLocationValue: null,
      ichimoku: { cloudTop: 33000, cloudBottom: 30000, tenkan: 34000, kijun: 33000 },
      bollinger: { bb: { width: 0.2 } },
      ma20: 32000,
      ma60: 30000,
      ma120: 28000,
      maAligned: true,
      extensionFromMa20: 3,
      atr14: 1000,
      atrExtension: 1.5,
      foreignNet5d: 1000,
      foreignNet20d: 2000,
      foreignNet60d: 3000,
      institutionNet20d: 4000,
      high52w: 36534,
    },
    technical: block,
    vf: block,
    priority: { ...block, points: 3.25, maxPoints: 5, availableMaxPoints: 5 },
    quality: { ...block, points: 70, maxPoints: 100, availableMaxPoints: 100 },
    operatingScore10: 8,
    previousOperatingScore10: 5.5,
    previousOperatingScoreDate: "2026-10-07",
    scoreDelta1d: 25,
    grade: "A",
    rs20: 3,
    rs60: 1.75,
    marketCap: 1_230_000_000_000,
    dataCompletenessRatio: 1,
    hardFilterPassed: true,
    hardFilterStatus: "PASS",
    pendingRules: [],
    failedRules: [],
    warnings: [],
    sectorPriceLeadership: null,
    exitSignal: null,
    operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
    kosdaq80Onset: false,
    benchmarkCode: "KOSPI",
    benchmarkFallback: false,
    ...overrides,
  } as unknown as ScreeningRow;
}
const render = (input: ScreeningRow, positions = state.positions) =>
  renderToStaticMarkup(
    <StockInstrumentSummary
      row={input}
      asOfDate={date}
      tradeDates={tradeDates}
      positionContext={positions}
    />,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const statusText = (html: string) =>
  text(html.match(/<div aria-label="주식 상태">(.*?)<\/div>/s)?.[1] ?? "");
const metrics = (html: string) =>
  Object.fromEntries(
    [...html.matchAll(/<dt\b[^>]*>(.*?)<\/dt><dd\b[^>]*>(.*?)<\/dd>/gs)].map((match) => [
      text(match[1]!),
      text(match[2]!),
    ]),
  );
const renderRoute = (input: ScreeningRow) => {
  state.row = input;
  return renderToStaticMarkup(React.createElement(Route.options.component as React.ComponentType));
};
beforeEach(() => {
  state.positions = { heldSymbols: [], lastSellDateBySymbol: {} };
});

describe("stock instrument summary", () => {
  it("shows every moved metric from the stored row without mutating the screening result", () => {
    const input = row();
    const before = structuredClone(input);
    const html = render(input);
    expect(metrics(html)).toMatchObject({
      시장: "KOSPI",
      종가: "35,000원",
      기술점수: "8.0 / 10",
      "우선점수 · 참고": "3.25 / 5.0",
      "모델등급 · 기술 기준": "A등급",
      "거래량 비율(20일)": "175.5%",
      RS20: "+3.00%",
      RSAccel: "+1.25%p",
      "52주 고점 거리": "-4.2%",
      시가총액: "1.23조 원",
    });
    expect(text(html)).toContain("8.0점 신규 돌파 충족 · 5.5 → 8");
    expect(input).toEqual(before);
  });

  it("keeps known failure and final rejection visible alongside pending market-cap data", () => {
    const html = render(
      row({
        hardFilterPassed: false,
        hardFilterStatus: "FAIL",
        failedRules: ["유동성 부족"],
        pendingRules: [pendingReason],
        marketCap: null,
      }),
    );
    expect(statusText(html)).toContain("진입 제외");
    expect(metrics(html)["시가총액"]).toBe("데이터 없음");
    expect(text(html)).toContain("확인된 미충족: 유동성 부족");
    expect(text(html)).toContain(`자료 확인 대기: ${pendingReason}`);
    expect(text(html)).toContain("확인된 조건 미충족 · 신규 진입 제외");
    expect(text(html)).not.toContain("최종 진입 미확정");
  });

  it("retains KOSPI confirmation and market-regime failures when cap is pending", () => {
    const gate = (day: string) => ({
      date: day,
      status: "RISK_OFF",
      incomplete: false,
      evaluatedCount: 4,
      issues: [],
    });
    const input = row({
      operatingScore10: 8.5,
      previousOperatingScore10: 8,
      scoreDelta1d: 5,
      hardFilterPassed: false,
      hardFilterStatus: "PENDING",
      pendingRules: [pendingReason],
      marketCap: null,
      kospiEntry: {
        version: OPERATIONAL_SIGNAL_VERSION,
        date,
        originDate: "2026-10-07",
        confirmationDate: date,
        state: "rejected",
        issues: ["확인일 RSAccel 0 이하", "확인일 시장 RISK_OFF"],
        rsAccel: -1,
        score: 8.5,
        originScore: 8,
        eligible: false,
        marketGate: { origin: gate("2026-10-07"), confirmation: gate(date) },
      } as unknown as ScreeningRow["kospiEntry"],
    });
    const html = render(input);
    expect(statusText(html)).toContain("진입 제외");
    for (const evidence of [
      "확인일 8점 유지 충족",
      "확인일 RSAccel &gt; 0 미충족",
      "Onset일 시장 RISK_OFF · 미충족",
      "확인일 시장 RISK_OFF · 미충족",
      pendingReason,
      "확인된 조건 미충족 · 신규 진입 제외",
    ])
      expect(html).toContain(evidence);
  });

  it.each([null, NaN, Infinity])(
    "does not manufacture score, grade or cap when missing: %s",
    (score) => {
      const html = render(
        row({
          operatingScore10: score,
          marketCap: null,
          hardFilterPassed: false,
          hardFilterStatus: "PENDING",
          pendingRules: [pendingReason],
        }),
      );
      expect(metrics(html)).toMatchObject({
        기술점수: "산정 불가",
        "모델등급 · 기술 기준": "산정 불가",
        시가총액: "데이터 없음",
      });
      expect(html).not.toMatch(/NaN|Infinity|A등급/);
      expect(html).toContain("기술청산 판단 미확인");
      expect(html).toContain("최종 진입 미확정 · 필수 자료 확인 대기");
    },
  );

  it("labels an unheld 9.5 crossing conditionally rather than as a sell instruction", () => {
    const input = row({
      operatingScore10: 9.5,
      previousOperatingScore10: 8.5,
      scoreDelta1d: 10,
      exitSignal: "UP95",
    });
    const html = render(input);
    expect(html).toContain("보유 시 기술청산 조건 충족 · 9.5점 상향돌파");
    expect(statusText(html)).not.toContain("청산");
    expect(html).not.toMatch(/청산 대기|매도 지시|다음 시가 매도/);
    const held = render(input, {
      heldSymbols: [input.instrument.symbol],
      lastSellDateBySymbol: {},
    });
    expect(statusText(held)).toContain("보유 · 청산 조건 충족");
  });

  it("does not turn stale or nonadjacent data into current evidence", () => {
    const input = row();
    input.snapshot.tradeDate = "2026-10-07";
    expect(metrics(render(input))).toMatchObject({
      종가: "기준일 가격 미확인",
      기술점수: "산정 불가",
      "거래량 비율(20일)": "데이터 없음",
      시가총액: "데이터 없음",
    });
    const gap = render(row({ previousOperatingScoreDate: "2026-10-06" }));
    expect(gap).not.toContain("8.0 신규 돌파 ·");
    expect(gap).toContain("8.0점 신규 돌파 미확인");
  });

  it("shows a real zero score and treats RSAccel as KOSPI-specific", () => {
    const input = row({ operatingScore10: 0, grade: "C" });
    input.instrument.market = "KOSDAQ";
    expect(metrics(render(input))).toMatchObject({
      기술점수: "0.0 / 10",
      RSAccel: "해당 없음",
    });
  });
});

describe("instrument route integration", () => {
  it("marks unheld exit warnings as observed conditions without changing held or ETF copy", () => {
    const input = row({
      operatingScore10: 9.5,
      previousOperatingScore10: 8.5,
      scoreDelta1d: 10,
      exitSignal: "UP95",
    });
    const html = renderRoute(input);
    expect(html).toContain("미보유 · 관측 조건 참고 · 상단 Exit · 9.5점 상향돌파");
    expect(html).toContain("보유 시 기술청산 조건 충족 · 9.5점 상향돌파");
    state.positions.heldSymbols = [input.instrument.symbol];
    const held = renderRoute(input);
    expect(held).not.toContain("관측 조건 참고");
    expect(held).toContain("보유 · 청산 조건 충족");
    input.instrument.instrumentType = "ETF";
    input.technicalNormalized = 84;
    state.positions.heldSymbols = [];
    expect(renderRoute(input)).not.toContain("관측 조건 참고");
  });

  it("puts the full stock evidence and onset profile above charts with no duplicate metric cards", () => {
    const input = row({
      hardFilterPassed: false,
      hardFilterStatus: "FAIL",
      failedRules: ["유동성 부족"],
      pendingRules: [pendingReason],
      marketCap: null,
      onsetProfile: {
        version: "v8-onset-path-v1",
        type: "A",
        label: "구조개선형",
        originDate: date,
        addedFeatures: [{ key: "MA", label: "MA 정배열", points: 1, category: "structural" }],
        addedPoints: 1,
        ma20Extension: 3,
      },
    });
    const before = structuredClone(input);
    const html = renderRoute(input);
    const aboveChart = html.slice(0, html.indexOf('aria-label="상세 차트"'));
    for (const evidence of [
      "판단 요약",
      "상세 지표",
      "우선점수 · 참고",
      "모델등급 · 기술 기준",
      "거래량 비율(20일)",
      "RS20",
      "RSAccel",
      "52주 고점 거리",
      "시가총액",
      "8.0점 신규 돌파 충족",
      "확인된 미충족: 유동성 부족",
      pendingReason,
      "확인된 조건 미충족 · 신규 진입 제외",
      "Onset 발생 경로",
      "구조개선형",
    ])
      expect(aboveChart).toContain(evidence);
    expect(html.indexOf("확인된 조건 미충족 · 신규 진입 제외")).toBeLessThan(
      html.indexOf(">상세 지표<"),
    );
    expect(html.indexOf("구조개선형")).toBeLessThan(html.indexOf(">상세 지표<"));
    expect(html.match(/>거래량 비율\(20일\)</g)).toHaveLength(1);
    expect(html.match(/>RS20</g)).toHaveLength(1);
    expect(html.match(/>Onset 발생 경로</g)).toHaveLength(1);
    expect(html).not.toContain("계산 근거 로그 (JSON)");
    expect(input).toEqual(before);
  });

  it("preserves the ETF detail branch and its 100-point technical score", () => {
    const input = row({
      vf: null,
      technicalNormalized: 82,
      etfStrategy: { technical: 84 } as NonNullable<ScreeningRow["etfStrategy"]>,
      hardFilterPassed: false,
      hardFilterStatus: "PENDING",
      pendingRules: ["ETF 상품건전성 미확인"],
      actionLabelText: "ETF 관찰",
    });
    input.instrument.instrumentType = "ETF";
    expect(render(input)).toBe("");
    const html = renderRoute(input);
    expect(html).not.toContain("판단 요약");
    expect(html).not.toContain("계산된 조건과 최종 진입 판단");
    expect(html).not.toContain("KOSPI 신규 후보 확인 기록");
    for (const evidence of [
      "현재가",
      "84.0 / 100",
      "우선점수",
      "모델등급",
      "ETF 관찰",
      "판단 보류:",
      "ETF 상품건전성 미확인",
      "ETF 상품건전성 (100점)",
      "ETF 기술점수는 84.0/100점입니다",
    ])
      expect(html).toContain(evidence);
    const belowChart = html.slice(html.indexOf('aria-label="상세 차트"'));
    expect(belowChart).toContain("거래량 비율(20일)");
    expect(belowChart).toContain("RS20");
  });
});
