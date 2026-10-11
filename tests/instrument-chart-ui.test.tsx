import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { AnalysisPayload } from "../src/lib/market.functions";
const state = vi.hoisted(() => ({
  owner: "owner" as string | null,
  prices: {} as Record<string, unknown>,
  scored: {} as Record<string, unknown>,
  queries: [] as Array<Record<string, unknown>>,
  retryOwner: vi.fn(),
  refetch: vi.fn(),
  buttonClicks: [] as Array<() => void>,
}));
vi.mock("@/lib/instrumentChartCache", () => ({
  instrumentChartQueryRevision: () => 1,
  useInstrumentChartOwner: () => ({
    owner: state.owner,
    authError: state.owner ? null : "로그인이 필요합니다.",
    retryOwner: state.retryOwner,
  }),
}));
vi.mock("@/lib/scoringConfigStore", () => ({ useScoringConfig: () => [{ version: "fixture" }] }));
vi.mock("@/lib/screeningCache", () => ({
  INSTRUMENT_CHART_VERSION: "fixture",
  getCachedInstrumentPrices: vi.fn(),
  getCachedInstrumentChart: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: Record<string, unknown>) => {
    state.queries.push(options);
    return {
      isFetching: false,
      isError: false,
      data: undefined,
      refetch: state.refetch,
      ...((options["queryKey"] as string[]).at(-1) === "prices" ? state.prices : state.scored),
    };
  },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => {
    state.buttonClicks.push(onClick);
    return <button onClick={onClick}>{children}</button>;
  },
}));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ children, data }: { children: React.ReactNode; data: unknown[] }) => (
    <div data-chart-points={data.length}>{children}</div>
  ),
  Bar: () => null,
  Brush: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  Line: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));
import InstrumentCharts from "../src/components/InstrumentCharts";
const payload = {
  analysis: {
    calculatedAt: "same",
    rows: [{ instrument: { symbol: "TEST", instrumentType: "STOCK" }, snapshot: { high52w: 100 } }],
  },
} as AnalysisPayload;
const prices = { chart: [{ tradeDate: "2026-10-09", close: 90, volume: 10 }], history: [] };
const render = () => renderToStaticMarkup(<InstrumentCharts symbol="TEST" payload={payload} />);
beforeEach(() => {
  state.owner = "owner";
  state.prices = {};
  state.scored = {};
  state.queries = [];
  state.retryOwner.mockReset();
  state.refetch.mockReset();
  state.buttonClicks = [];
});
test("one failed phase does not hide the other phase's pending progress", () => {
  state.prices = { isError: true, error: new Error("price failure") };
  state.scored = { isFetching: true };
  const html = render();
  expect(html).toContain("가격·거래량을 불러오는 중");
  expect(html).toContain("0초 경과");
  expect(html).not.toContain('role="alert"');
});
test("prices stay visible while technical points are loading or retryable", () => {
  state.prices = { data: prices };
  state.scored = { isFetching: true };
  let html = render();
  expect(html).toContain('data-chart-points="1"');
  expect(html).toContain("가격·거래량 표시 완료 · 기술점수 준비 중");
  state.scored = { isError: true, error: new Error("score failure") };
  html = render();
  expect(html).toContain('data-chart-points="1"');
  expect(html).toContain("기술점수 다시 시도");
});
test("terminal failures expose retry and unauthenticated requests stay disabled", () => {
  state.prices = { isError: true, error: new Error("price failure") };
  state.scored = { isError: true, error: new Error("score failure") };
  expect(render()).toContain("다시 시도");
  state.owner = null;
  expect(render()).toContain("로그인이 필요합니다.");
  expect(state.queries.slice(-2).every((q) => q["enabled"] === false)).toBe(true);
});
test("both phases use the authenticated owner and immutable payload revision in their query keys", () => {
  render();
  expect(state.queries.map((q) => (q["queryKey"] as unknown[]).slice(0, 5))).toEqual([
    ["instrument-chart", "fixture", "owner", "TEST", 1],
    ["instrument-chart", "fixture", "owner", "TEST", 1],
  ]);
});

test("authentication retry rechecks the owner without forcing disabled chart queries", () => {
  state.owner = null;
  render();
  state.buttonClicks.at(-1)!();
  expect(state.retryOwner).toHaveBeenCalledOnce();
  expect(state.refetch).not.toHaveBeenCalled();
});
