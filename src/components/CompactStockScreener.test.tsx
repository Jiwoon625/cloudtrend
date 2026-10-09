import React, { type ReactNode, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScreenerTable } from "./ScreenerTable";
import { ScreenerView } from "./ScreenerView";
import { CompactStockStatus } from "./CompactStockStatus";
import type { AnalysisResult, ScreeningRow } from "@/lib/engine/pipeline";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, positionsFailed: false }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.values)) hooks.values[i] = initial;
    return [
      hooks.values[i],
      (next: unknown) => {
        hooks.values[i] = typeof next === "function" ? next(hooks.values[i]) : next;
      },
    ];
  },
  useMemo: (build: () => unknown) => build(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { heldSymbols: [], lastSellDateBySymbol: {} },
    isSuccess: !hooks.positionsFailed,
    isError: hooks.positionsFailed,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/portfolioPositionContext", () => ({ loadDomesticPositionContext: vi.fn() }));
const date = "2026-10-08";
function row(symbol = "000001", score = 9.5): ScreeningRow {
  return {
    instrument: {
      symbol,
      name: `종목 ${symbol}`,
      market: "KOSPI",
      instrumentType: "STOCK",
      sectorName: "반도체",
      indexMemberships: [],
    },
    snapshot: { tradeDate: date, close: 10000, volumeRatio20: 160, distanceFrom52wHigh: -2 },
    technical: { points: score, maxPoints: 10, availableMaxPoints: 10 },
    vf: null,
    priority: { points: 4, maxPoints: 5, availableMaxPoints: 4 },
    operatingScore10: score,
    previousOperatingScore10: 7,
    scoreDelta1d: (score - 7) * 10,
    grade: "A",
    rs20: 4,
    rs60: 2,
    marketCap: null,
    sectorPriceLeadership: null,
    warnings: ["HEAD_FAKE"],
    hardFilterPassed: false,
    hardFilterStatus: "PENDING",
    pendingRules: ["기준일 시가총액 미확인 · 판단 보류"],
    failedRules: [],
    dataCompletenessRatio: 1,
    exitSignal: null,
  } as unknown as ScreeningRow;
}
const baseProps = {
  positionContext: { heldSymbols: [], lastSellDateBySymbol: {} },
  signalDate: date,
  compactStock: true,
};
const removed = [
  "시장",
  "우선점수",
  "모델등급",
  "거래량 비율",
  "RS20",
  "RSAccel",
  "52주 고점 거리",
  "시가총액",
];
beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
});
function nodes(
  node: ReactNode,
): ReactElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (
    !React.isValidElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>(node)
  )
    return [];
  return [node, ...nodes(node.props.children)];
}
function render(rows = [row()]) {
  hooks.cursor = 0;
  const tree = ScreenerTable({ ...baseProps, rows });
  return { html: renderToStaticMarkup(tree), tree, nodes: nodes(tree) };
}
describe("compact stock screener", () => {
  it("shows an explicit empty result for a holding exit filter without matches", () => {
    const html = renderToStaticMarkup(<ScreenerTable rows={[]} {...baseProps} />);
    expect(html).toContain("조건에 맞는 종목이 없습니다.");
  });
  it("displays legacy score deltas on the same ten-point scale as the score", () => {
    const html = renderToStaticMarkup(<ScreenerTable rows={[row()]} {...baseProps} />);
    expect(html).toContain("전 거래일 대비 +2.5점");
    expect(html).not.toContain("전 거래일 대비 +25.0점");
  });
  it("keeps exactly six core headers and removes retired column toggles", () => {
    const html = render().html;
    expect((html.match(/<th(?:\s|>)/g) ?? []).length).toBe(6);
    for (const label of removed) expect(html).not.toContain(`>${label}<`);
    for (const label of ["종목명", "섹터", "종가", "기술점수", "점수 변동(1D)", "상태"])
      expect(html).toContain(label);
    expect(html).not.toContain("종목 공통 확인 기록");
    expect(html).not.toContain("Onset 기록");
    expect(html).not.toContain("기준일 시가총액 미확인");
    expect(html).toContain("주의 · Head Fake");
  });
  it("bounds each status to two single-line spans with a fixed 36px height", () => {
    const html = renderToStaticMarkup(
      <CompactStockStatus
        status={{
          primary: "8.0 신규 돌파 · 진입 제외",
          secondary: "시장 RISK_OFF · 자료 대기",
          tone: "danger",
        }}
      />,
    );
    expect((html.match(/<span/g) ?? []).length).toBe(2);
    expect(html).toContain("h-9 w-40 max-w-40 sm:w-56 sm:max-w-56");
    expect(html).toContain("leading-[18px]");
    expect((html.match(/truncate/g) ?? []).length).toBe(2);
  });
  it("keeps identity and the full status viewport-accessible down to a 320px phone", () => {
    const html = render().html;
    expect(html).toContain("min-w-[640px] sm:min-w-[720px]");
    // 320px viewport minus 16px page padding on either side.
    // Sticky identity: 96px + 8px cell padding; status: 160px + 8px.
    expect(96 + 8 + 160 + 8).toBeLessThanOrEqual(320 - 32 - 2);
    expect(html).not.toContain("min-w-[1200px]");
    expect(html).toContain("overflow-auto");
    expect(html).toContain("sticky left-0 z-10 bg-card");
    expect(html).toContain("left-0 z-20 w-24 sm:w-36");
  });
  it("keeps full legacy table behavior for callers outside compact stock mode", () => {
    const html = renderToStaticMarkup(<ScreenerTable rows={[row()]} signalDate={date} />);
    for (const label of removed) expect(html).toContain(label);
    expect(html).toContain("min-w-[1200px]");
    expect(html).toContain("계산된 조건별 판단");
  });
  it("keeps the KRX publication explanation above the list once", () => {
    const analysis = {
      asOfDate: date,
      rows: [row(), row("000002")],
      tradeDates: ["2026-10-07", date],
      marketGate: { status: "RISK_OFF", metCount: 0 },
    } as AnalysisResult;
    const html = renderToStaticMarkup(<ScreenerView mode="STOCK" analysis={analysis} />);
    expect((html.match(/08:00 KST/g) ?? []).length).toBe(1);
    expect(html).toContain("주식 핵심 목록");
    expect(html).not.toContain("기준일 시가총액 미확인 · 판단 보류");
  });
  it("keeps the same fixed core columns and accessible sorting as other screeners", () => {
    const view = render();
    expect((view.html.match(/<th(?:\s|>)/g) ?? []).length).toBe(6);
    expect(view.html).toContain('aria-sort="none"');
    expect(
      view.nodes.some((node) => node.type === "button" && node.props.children === "상태"),
    ).toBe(false);
    for (const label of removed) expect(view.html).not.toContain(`>${label}<`);
  });
  it("marks failed KR holdings unknown with retry and disables the exit preset", () => {
    hooks.positionsFailed = true;
    const analysis = {
      asOfDate: date,
      rows: [row()],
      tradeDates: [date],
      marketGate: { status: "RISK_OFF", metCount: 0 },
    } as AnalysisResult;
    const html = renderToStaticMarkup(<ScreenerView mode="STOCK" analysis={analysis} />);
    expect(html).toContain("보유 자료 조회 실패");
    expect(html).toContain("보유 청산 (미확인)");
    expect(html).toContain("다시 시도");
    hooks.positionsFailed = false;
  });
  it("preserves technical sorting through repeated ascending/descending clicks", () => {
    const rows = [row("LOW", 7), row("HIGH", 9.5)];
    let view = render(rows);
    const toggle = () => {
      view.nodes.find(
        (node) =>
          node.type === "button" &&
          Array.isArray(node.props.children) &&
          node.props.children[0] === "기술점수",
      )!.props.onClick!();
      view = render(rows);
    };
    toggle();
    expect(view.html.indexOf("종목 HIGH")).toBeLessThan(view.html.indexOf("종목 LOW"));
    toggle();
    expect(view.html.indexOf("종목 LOW")).toBeLessThan(view.html.indexOf("종목 HIGH"));
  });
});
