import React, { type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DomesticAssessmentPanel } from "./DomesticAssessmentPanel";
import { StockAssessmentDetails } from "./StockAssessmentDetails";
import { stockAssessmentDisplay } from "@/lib/stockAssessmentDisplay";
import type { ScreeningRow } from "@/lib/engine/pipeline";
import type { DashboardMarketSignals } from "@/lib/dashboardOperations";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (next: unknown) => {
        hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
      },
    ];
  },
}));
beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
});
function nodes(node: ReactNode): ReactElement<{
  children?: ReactNode;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
}>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (
    !React.isValidElement<{
      children?: ReactNode;
      onClick?: () => void;
      onChange?: (event: { target: { value: string } }) => void;
    }>(node)
  )
    return [];
  return [node, ...nodes(node.props.children)];
}
function renderPanel(input: DashboardMarketSignals[]) {
  hooks.cursor = 0;
  const tree = DomesticAssessmentPanel({ markets: input });
  return { tree, html: renderToStaticMarkup(tree), elements: nodes(tree) };
}
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
const assessment = stockAssessmentDisplay(
  {
    instrument: { market: "KOSDAQ" },
    snapshot: { tradeDate: "2026-10-08", close: 30000, volumeRatio20: 170 },
    operatingScore10: 8,
    previousOperatingScore10: 5.5,
    scoreDelta1d: 25,
    grade: "A",
    hardFilterPassed: false,
    hardFilterStatus: "PENDING",
    pendingRules: ["시가총액 미확인"],
    failedRules: [],
  } as unknown as ScreeningRow,
  "2026-10-08",
);
const markets = [
  {
    market: "KOSDAQ",
    date: "2026-10-08",
    holdingsKnown: true,
    onsets: [],
    exits: [],
    assessments: [
      {
        symbol: "036930",
        name: "주성엔지니어링",
        market: "KOSDAQ",
        date: "2026-10-08",
        price: 30000,
        held: true,
        reason: "보유 · 추가 진입 제외",
        assessment,
      },
      {
        symbol: "000001",
        name: "미보유 종목",
        market: "KOSDAQ",
        date: "2026-10-08",
        price: 30000,
        held: false,
        reason: "미보유",
        assessment,
      },
    ],
  },
] as unknown as DashboardMarketSignals[];
describe("evening assessment UI", () => {
  it("shows existing score/crossing/exit evidence and separates the final entry boundary", () => {
    const html = renderToStaticMarkup(<StockAssessmentDetails assessment={assessment} held />);
    for (const text of [
      "8/10",
      "A등급",
      "5.5 → 8",
      "기술청산 조건 없음",
      "자료 확인 대기",
      "시가총액 미확인",
      "최종 진입 미확정",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("다음 시가 진입");
  });
  it("lists all pending/failed technical rows and independent grade counts on the dashboard", () => {
    const html = renderToStaticMarkup(<DomesticAssessmentPanel markets={markets} />);
    expect(html).toContain("기술 A 2 / B 0");
    expect(html).toContain("주성엔지니어링");
    expect(html).toContain("미보유 종목");
    expect(html).toContain("08:00 KST");
  });
  it("shows only actual held rows in the portfolio", () => {
    const html = renderToStaticMarkup(<DomesticAssessmentPanel markets={markets} heldOnly />);
    expect(html).toContain("보유종목 조건별 판단");
    expect(html).toContain("주성엔지니어링");
    expect(html).not.toContain("미보유 종목");
    expect(html).toContain("보유 · 추가 진입 제외");
  });
  it("does not treat missing projection as zero confirmed judgments", () => {
    const missing = { ...markets[0]! };
    delete missing.assessments;
    const html = renderToStaticMarkup(<DomesticAssessmentPanel markets={[missing]} />);
    expect(html).toContain("조건별 판단 자료 미확인");
  });
});

it("resets pagination for search and market changes, then supports repeated back/next", () => {
  const many = [
    {
      ...markets[0]!,
      assessments: Array.from({ length: 61 }, (_, index) => ({
        ...markets[0]!.assessments![0]!,
        symbol: `S${index}`,
        name: `종목 ${index}`,
      })),
    },
  ];
  let view = renderPanel(many);
  expect(view.html).toContain("1/3페이지");
  const click = (label: string) => {
    view.elements.find((e) => e.type === "button" && e.props.children === label)!.props.onClick!();
    view = renderPanel(many);
  };
  click("다음");
  expect(view.html).toContain("2/3페이지");
  click("다음");
  expect(view.html).toContain("3/3페이지");
  view.elements.find((e) => e.type === "input")!.props.onChange!({ target: { value: "S40" } });
  view = renderPanel(many);
  expect(view.html).toContain("1/1페이지");
  expect(view.html).toContain("종목 40");
  view.elements.find((e) => e.type === "input")!.props.onChange!({ target: { value: "" } });
  view = renderPanel(many);
  click("다음");
  click("이전");
  expect(view.html).toContain("1/3페이지");
  view.elements.find((e) => e.type === "select")!.props.onChange!({ target: { value: "KOSPI" } });
  view = renderPanel(many);
  expect(view.html).toContain("표시할 조건별 판단이 없습니다");
  view.elements.find((e) => e.type === "select")!.props.onChange!({ target: { value: "ALL" } });
  view = renderPanel(many);
  expect(view.html).toContain("1/3페이지");
});

it("defaults review to focused current candidates and transitions when saved KRX evidence arrives", () => {
  const current = structuredClone(markets);
  current[0]!.date = "2026-10-12";
  current[0]!.assessments!.forEach((r) => {
    r.date = "2026-10-12";
  });
  let html = renderToStaticMarkup(<DomesticAssessmentPanel markets={current} review />);
  expect(html).toContain("당일 원신호 · 진입 판단 구분");
  expect(html).toContain("미보유 종목");
  expect(html).toContain("주성엔지니어링");
  expect(html).toContain("최종 진입 미확정");
  current[0]!.assessments![1]!.assessment = {
    ...assessment,
    pending: [],
    finalEntry: "저장된 운영 진입 조건 충족 · 보유·체결 조건 별도 확인",
  };
  html = renderToStaticMarkup(<DomesticAssessmentPanel markets={current} review />);
  expect(html).toContain("저장된 운영 진입 조건 충족");
  expect(html).toContain("시가총액 미확인");
});
it("does not promote pre-start saved evidence to default review candidates", () => {
  const html = renderToStaticMarkup(<DomesticAssessmentPanel markets={markets} review />);
  expect(html).toContain("기준일에 확인된 원신호가 없습니다");
  expect(html).not.toContain("미보유 종목");
});

it("uses neutral pending text only in the daily raw-signal review without changing evidence", () => {
  const current = structuredClone(markets);
  current[0]!.date = "2026-10-12";
  current[0]!.assessments!.forEach((row) => {
    row.date = "2026-10-12";
  });
  const before = structuredClone(current);
  const reviewHtml = renderToStaticMarkup(<DomesticAssessmentPanel markets={current} review />);
  expect(reviewHtml).toContain('<p class="text-foreground">자료 확인 대기: 시가총액 미확인</p>');
  expect(reviewHtml).not.toContain('<p class="text-warn">자료 확인 대기:');
  expect(reviewHtml).toContain("확인된 원신호 2종목");
  expect(reviewHtml).toContain("최종 진입 미확정");
  const standardHtml = renderToStaticMarkup(<DomesticAssessmentPanel markets={current} />);
  expect(standardHtml).toContain('<p class="text-warn">자료 확인 대기: 시가총액 미확인</p>');
  expect(current).toEqual(before);
});

it("switches review scope without changing strategy evidence and resets pagination", () => {
  const many = [
    {
      ...markets[0]!,
      date: "2026-10-12",
      assessments: Array.from({ length: 125 }, (_, index) => ({
        ...markets[0]!.assessments![1]!,
        date: "2026-10-12",
        symbol: `R${index}`,
        name: `검토 ${index}`,
      })),
    },
  ];
  const renderReview = () => {
    hooks.cursor = 0;
    const tree = DomesticAssessmentPanel({ markets: many, review: true });
    return { elements: nodes(tree), html: renderToStaticMarkup(tree) };
  };
  let view = renderReview();
  view.elements.find((e) => e.type === "button" && e.props.children === "다음")!.props.onClick!();
  view = renderReview();
  expect(view.html).toContain("2/5페이지");
  view.elements.filter((e) => e.type === "select")[0]!.props.onChange!({
    target: { value: "all" },
  });
  view = renderReview();
  expect(view.html).toContain("1/5페이지");
  view.elements.filter((e) => e.type === "select")[0]!.props.onChange!({
    target: { value: "candidates" },
  });
  view = renderReview();
  expect(view.html).toContain("1/5페이지");
  expect(many[0]!.assessments[0]!.assessment?.pending).toEqual(["시가총액 미확인"]);
});

it("omits the legacy new label only from dashboard evidence, preserving stored meaning", () => {
  const current = structuredClone(markets);
  current[0]!.date = "2026-10-12";
  current[0]!.assessments!.forEach((r) => {
    r.date = "2026-10-12";
  });
  const before = structuredClone(current);
  const html = renderToStaticMarkup(<DomesticAssessmentPanel markets={current} review />);
  expect(html).not.toContain("신규");
  expect(html).toContain("8.0점 돌파");
  expect(current).toEqual(before);
});

it("does not present a domestic source outage or unknown holdings as zero confirmed candidates", () => {
  const unavailable = [{ ...markets[0]!, date: null, assessments: [] }];
  const html = renderToStaticMarkup(<DomesticAssessmentPanel markets={unavailable} review />);
  expect(html).toContain("국내 기준일·조건별 판단 자료 미확인");
  expect(html).not.toContain("기준일에 확인된 원신호가 없습니다");
  const unknown = [{ ...markets[0]!, holdingsKnown: false }];
  const unknownHtml = renderToStaticMarkup(<DomesticAssessmentPanel markets={unknown} review />);
  expect(unknownHtml).toContain("실제 보유정보 확인 대기");
  expect(unknownHtml).not.toContain("기준일에 확인된 원신호가 없습니다");
});

it("shows the ETF pre-start exclusion when browsing all saved evidence", () => {
  hooks.values[3] = "all";
  const etf = {
    ...markets[0]!.assessments![1]!,
    market: "ETF" as const,
    date: "2026-10-12",
    assessment: undefined,
    operationalEntryNotice: null,
    etfEntry: { entryState: "data_pending", originDate: "2026-10-08" },
    etfAssessment: {
      current: true,
      krxPending: true,
      isStrategyTarget: true,
      score: null,
      rawOnset: null,
      previousScore: null,
      previousDate: null,
      technical: 50,
      priority: null,
      health: null,
      environment: null,
      annualVolatility: null,
      entryWeight: null,
      averageTradingValue20: null,
      underlyingClose: null,
      underlyingMa60: null,
      underlyingJudgment: "unconfirmed" as const,
      provenanceLabel: "2026-10-12 저장 근거",
    },
  };
  const input = [
    { ...markets[0]!, market: "ETF" as const, date: "2026-10-12", assessments: [etf] },
  ];
  const html = renderToStaticMarkup(<DomesticAssessmentPanel markets={input} review />);
  expect(html).toContain("시작 전 원신호 · 운용 승계 안 함");
  expect(html).not.toContain("신규");
});

it("separates the October 12 actual onset from 717 technical references and 54 missing technical plus four pre-start origins", () => {
  const date = "2026-10-12";
  const base = markets[0]!.assessments![1]!;
  const stocks = Array.from({ length: 7 }, (_, i) => ({
    ...base,
    market: "KOSPI" as const,
    date,
    symbol: `S${i}`,
    name: `기술유지 ${i}`,
    assessment: { ...assessment, rawOnset: false, previousScore: i ? 8 : 9.5 },
  }));
  const onset = {
    ...base,
    market: "KOSPI" as const,
    date,
    symbol: "028670",
    name: "팬오션",
    assessment: {
      ...assessment,
      rawOnset: true,
      failed: ["RISK_OFF"],
      finalEntry: "시장 조건 탈락 · 진입 제외",
    },
  };
  const etfs = Array.from({ length: 768 }, (_, i) => ({
    ...base,
    market: "ETF" as const,
    date,
    symbol: `E${i}`,
    name: `ETF참고 ${i}`,
    etfEntry:
      i >= 710 && i < 714 ? { entryState: "data_pending", originDate: "2026-10-08" } : undefined,
    assessment: undefined,
    etfAssessment: {
      current: true,
      krxPending: true,
      isStrategyTarget: true,
      technical: i < 714 ? 50 : null,
      rawOnset: null,
      score: null,
      priority: null,
      health: null,
      environment: null,
      underlyingClose: null,
      underlyingMa60: null,
      underlyingJudgment: "unconfirmed",
      provenanceLabel: date,
    },
  }));
  const input = [
    { ...markets[0]!, market: "KOSPI", date, assessments: [...stocks, onset] },
    { ...markets[0]!, market: "KOSDAQ", date, assessments: [] },
    { ...markets[0]!, market: "ETF", date, assessments: etfs },
  ] as unknown as DashboardMarketSignals[];
  const before = structuredClone(input);
  const show = () => {
    hooks.cursor = 0;
    const tree = DomesticAssessmentPanel({ markets: input, review: true });
    return { html: renderToStaticMarkup(tree), elements: nodes(tree) };
  };
  let view = show();
  expect(view.html).toContain("팬오션");
  expect(view.html).toContain("시장 조건 탈락 · 진입 제외");
  expect(view.html).toContain("판단 미확정 768종목");
  expect(view.html).not.toContain("기술유지 0");
  expect(view.html).not.toContain("717");
  view.elements.filter((e) => e.type === "select")[0]!.props.onChange!({
    target: { value: "reference" },
  });
  view = show();
  expect(view.html).toContain("기술조건 참고 717종목");
  expect(view.html).toContain("기술유지 0");
  view.elements.filter((e) => e.type === "select")[1]!.props.onChange!({
    target: { value: "KOSDAQ" },
  });
  view = show();
  expect(view.html).toContain("기술조건 참고 0종목");
  expect(input).toEqual(before);
});
