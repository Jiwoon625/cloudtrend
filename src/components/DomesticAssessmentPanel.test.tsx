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
    const html = renderToStaticMarkup(<StockAssessmentDetails assessment={assessment} />);
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
      assessments: Array.from({ length: 41 }, (_, index) => ({
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
