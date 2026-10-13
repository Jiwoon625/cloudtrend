import React, { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { AnalysisPayload } from "../src/lib/marketPayload";
import type { ScreeningRow } from "../src/lib/engine/pipeline";
import type { EtfInstrumentChartBundle } from "../src/lib/engine/etfInstrumentChart";
import { ETF_POLICY } from "../src/lib/engine/etfStrategy";

const state = vi.hoisted(() => ({
  owner: "owner" as string | null,
  authError: null as string | null,
  prices: {} as Record<string, unknown>,
  bundle: {} as Record<string, unknown>,
  queries: [] as Array<Record<string, unknown>>,
  charts: [] as unknown[][],
  lines: [] as Array<Record<string, unknown>>,
  axes: [] as Array<Record<string, unknown>>,
  range: "120" as "120" | "all",
  showM0: true,
  elapsed: 0,
  retryOwner: vi.fn(),
  priceRetry: vi.fn(),
  bundleRetry: vi.fn(),
  pricesCall: vi.fn(),
  bundleCall: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: vi.fn(),
    useState: (initial: unknown) => {
      if (initial === "120")
        return [
          state.range,
          (value: "120" | "all") => {
            state.range = value;
          },
        ];
      if (initial === true)
        return [
          state.showM0,
          (value: (old: boolean) => boolean) => {
            state.showM0 = value(state.showM0);
          },
        ];
      if (initial === 0) return [state.elapsed, vi.fn()];
      return actual.useState(initial);
    },
  };
});
vi.mock("@/lib/instrumentChartCache", () => ({
  instrumentChartQueryRevision: (payload: AnalysisPayload) =>
    payload.analysis.calculatedAt === "new" ? 18 : 17,
  useInstrumentChartOwner: () => ({
    owner: state.owner,
    authError: state.authError,
    retryOwner: state.retryOwner,
  }),
}));
vi.mock("@/lib/scoringConfigStore", () => ({ useScoringConfig: () => [{ version: "fixture" }] }));
vi.mock("@/lib/screeningCache", () => ({
  INSTRUMENT_CHART_VERSION: "price-fixture",
  ETF_INSTRUMENT_CHART_VERSION: "etf-fixture",
  getCachedEtfInstrumentPrices: state.pricesCall,
  getCachedEtfInstrumentChart: state.bundleCall,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: Record<string, unknown>) => {
    state.queries.push(options);
    const prices = (options["queryKey"] as string[]).at(-1) === "prices";
    return {
      isFetching: false,
      isError: false,
      data: undefined,
      refetch: prices ? state.priceRetry : state.bundleRetry,
      ...(prices ? state.prices : state.bundle),
    };
  },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ children, data }: { children: ReactNode; data: unknown[] }) => {
    state.charts.push(data);
    return <div data-chart-points={data.length}>{children}</div>;
  },
  Line: (props: Record<string, unknown>) => {
    state.lines.push(props);
    return null;
  },
  YAxis: (props: Record<string, unknown>) => {
    state.axes.push(props);
    return null;
  },
  Bar: () => null,
  Brush: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  Tooltip: () => null,
  XAxis: () => null,
}));

import EtfInstrumentCharts, {
  EtfChartLoadingStatus,
  EtfUnderlyingTooltip,
} from "../src/components/EtfInstrumentCharts";
import { EtfM0Summary } from "../src/components/EtfInstrumentDetail";

const row = {
  instrument: { symbol: "360750", name: "검증 ETF", instrumentType: "ETF" },
  snapshot: { tradeDate: "2026-10-13", close: 10000 },
  etfStrategy: {
    version: ETF_POLICY.version,
    date: "2026-10-13",
    previousDate: "2026-10-12",
    dataStatus: "krx_batch_pending",
    technical: 90,
    priority: 50,
    health: null,
    environment: 80,
    environmentSource: "own_index_lag1",
    score: null,
    previousScore: 99,
    entryState: "data_pending",
    region: "US",
    issues: [],
    confirmationIssues: [],
  },
} as unknown as ScreeningRow;
const payload = {
  analysis: { calculatedAt: "same", asOfDate: "2026-10-13", rows: [row] },
} as AnalysisPayload;
const prices = { chart: [{ tradeDate: "2026-10-13", close: 10000, volume: 120 }] };
const bundle: EtfInstrumentChartBundle = {
  version: ETF_POLICY.version,
  symbol: "360750",
  asOfDate: "2026-10-13",
  chart: [
    { tradeDate: "2026-10-12", close: 9900, volume: 110, m0Score: 82.5 },
    { tradeDate: "2026-10-13", close: 10000, volume: 120, m0Score: null },
  ],
  underlying: [
    {
      tradeDate: "2026-10-08",
      close: 100,
      ma60: 98,
      name: "실제 S&P 500 지수",
      identityBreak: false,
    },
    { tradeDate: "2026-10-09", close: null, ma60: null, name: null, identityBreak: false },
    {
      tradeDate: "2026-10-12",
      close: 101,
      ma60: 98.5,
      name: "실제 S&P 500 지수",
      identityBreak: false,
    },
  ],
  underlyingName: "실제 S&P 500 지수",
  underlyingSource: "KRX_ETF",
  underlyingFirstDate: "2025-01-02",
  underlyingAsOfDate: "2026-10-12",
  previousM0: { date: "2026-10-12", score: 82.5 },
  previousTradingDate: "2026-10-12",
  issues: [],
};
function render() {
  return renderToStaticMarkup(<EtfInstrumentCharts symbol="360750" payload={payload} />);
}
function summary(data = bundle) {
  return renderToStaticMarkup(
    <EtfM0Summary row={row} signalDate="2026-10-13" held={false} bundle={data} />,
  );
}
function clickLabel(node: ReactNode, label: string): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((child) => clickLabel(child, label));
  const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (element.props?.children === label && element.props.onClick) {
    element.props.onClick();
    return true;
  }
  return clickLabel(element.props?.children, label);
}
beforeEach(() => {
  state.owner = "owner";
  state.authError = null;
  state.prices = {};
  state.bundle = {};
  state.queries = [];
  state.charts = [];
  state.lines = [];
  state.axes = [];
  state.range = "120";
  state.showM0 = true;
  state.elapsed = 0;
  state.retryOwner.mockReset();
  state.priceRetry.mockReset();
  state.bundleRetry.mockReset();
  state.pricesCall.mockReset();
  state.bundleCall.mockReset();
});

test("price and M0 requests start independently with owner/revision/config-isolated reusable keys", async () => {
  state.prices = { data: prices };
  state.bundle = { isFetching: true };
  const html = render();
  expect(html).toContain('data-chart-points="1"');
  expect(html).toContain("가격·거래량 표시 완료 · M0·기초지수 준비 중");
  expect(html).not.toContain("기술점수");
  expect(state.queries.map((q) => q["queryKey"])).toEqual([
    [
      "etf-instrument-chart",
      "etf-fixture",
      "owner",
      "360750",
      17,
      { version: "fixture" },
      "120",
      "prices",
    ],
    [
      "etf-instrument-chart",
      "etf-fixture",
      "owner",
      "360750",
      17,
      { version: "fixture" },
      "120",
      "m0",
    ],
  ]);
  for (const q of state.queries) {
    expect(q["enabled"]).toBe(true);
    expect(q["staleTime"]).toBe(Infinity);
    expect(q["gcTime"]).toBe(30 * 60 * 1000);
    expect(q["retry"]).toBe(false);
    await (q["queryFn"] as () => Promise<unknown>)();
  }
  expect(state.pricesCall).toHaveBeenCalledWith("360750", "120", payload);
  expect(state.bundleCall).toHaveBeenCalledWith("360750", "120", payload);
});
test("shared range loads full history only after explicit selection and supports returning to recent", () => {
  const tree = EtfInstrumentCharts({ symbol: "360750", payload });
  expect(state.queries.every((q) => (q["queryKey"] as string[]).at(-2) === "120")).toBe(true);
  expect(clickLabel(tree, "전체 기간")).toBe(true);
  state.bundle = { data: bundle };
  state.queries = [];
  expect(render()).toContain("전체 관측 기간 2025-01-02 ~ 2026-10-12");
  expect(state.queries.every((q) => (q["queryKey"] as string[]).at(-2) === "all")).toBe(true);
  expect(clickLabel(EtfInstrumentCharts({ symbol: "360750", payload }), "최근 120거래일")).toBe(
    true,
  );
  state.queries = [];
  render();
  expect(state.queries.every((q) => (q["queryKey"] as string[]).at(-2) === "120")).toBe(true);
});
test("M0 is the 100-point total, underlying provenance/lag are explicit, and every line leaves gaps", () => {
  state.bundle = { data: bundle };
  const html = render();
  expect(html).toContain("기초지수 (최근 관측: 실제 S&amp;P 500 지수) · 출처 KRX 관측");
  expect(html).toContain("ETF 기준일 2026-10-13 · 기초지수 최종 관측 2026-10-12 (ETF보다 이전)");
  expect(state.charts).toEqual([
    bundle.chart,
    bundle.underlying.map((point) => ({ ...point, plotClose: point.close })),
  ]);
  expect(state.lines.map((line) => line["dataKey"])).toEqual([
    "close",
    "m0Score",
    "plotClose",
    "ma60",
  ]);
  expect(
    state.lines.every(
      (line) => line["connectNulls"] === false && line["isAnimationActive"] === false,
    ),
  ).toBe(true);
  expect(state.axes.find((axis) => axis["yAxisId"] === "m0")?.["domain"]).toEqual([0, 100]);
  expect(clickLabel(EtfInstrumentCharts({ symbol: "360750", payload }), "M0 총점 (100점)")).toBe(
    true,
  );
  state.lines = [];
  render();
  expect(state.lines.some((line) => line["dataKey"] === "m0Score")).toBe(false);
});
test("pending main M0 stays missing with an exact dated previous-day recomputed reference only", () => {
  const original = structuredClone(row);
  const html = summary();
  expect(html).toContain("미관측");
  expect(html).toContain("전 거래일 M0 82.5 / 100 · 2026-10-12 · 참고");
  expect(html).toContain("신호 판단 보류");
  expect(html).not.toContain("진입 준비 · 다음 시가 진입");
  expect(html).not.toContain("99 / 100");
  expect(row).toEqual(original);
});
test.each([
  { previousM0: { date: "2026-10-09", score: 90 } },
  { previousM0: null },
  { previousTradingDate: null },
  { asOfDate: "2026-10-12" },
  { symbol: "OTHER" },
  { version: "old" },
  { previousM0: { date: "2026-10-12", score: Number.NaN } },
  { previousM0: { date: "2026-10-12", score: 101 } },
])("does not turn stale or unmatched history into a prior-trading-day reference: %j", (change) => {
  expect(summary({ ...bundle, ...change })).not.toContain("해당 날짜 자료로 재계산한 M0");
});
test("price success survives bundle failure and retry only repeats the failed bundle", () => {
  state.prices = { data: prices };
  state.bundle = { isError: true, error: new Error("자료 응답 실패") };
  expect(render()).toContain('data-chart-points="1"');
  expect(
    clickLabel(EtfInstrumentCharts({ symbol: "360750", payload }), "M0·기초지수 다시 시도"),
  ).toBe(true);
  expect(state.bundleRetry).toHaveBeenCalledOnce();
  expect(state.priceRetry).not.toHaveBeenCalled();
});
test("initial phase failure does not hide progress and all terminal errors are explicitly retryable", () => {
  state.prices = { isError: true, error: new Error("가격 실패") };
  state.bundle = { isFetching: true };
  expect(render()).toContain("ETF 가격·거래량을 불러오는 중");
  state.bundle = { isError: true, error: new Error("M0 실패") };
  const html = render();
  expect(html).toContain("M0 실패");
  expect(html).toContain("다시 시도");
  expect(clickLabel(EtfInstrumentCharts({ symbol: "360750", payload }), "다시 시도")).toBe(true);
  expect(state.priceRetry).toHaveBeenCalledOnce();
  expect(state.bundleRetry).toHaveBeenCalledOnce();
});
test("logout never renders cached charts or a prior-owner summary and authentication retry does not start disabled queries", () => {
  state.owner = null;
  state.authError = "로그인이 필요합니다.";
  state.bundle = { data: bundle };
  state.prices = { data: prices };
  const observed: Array<EtfInstrumentChartBundle | undefined> = [];
  const tree = EtfInstrumentCharts({
    symbol: "360750",
    payload,
    renderSummary: (data) => {
      observed.push(data);
      return null;
    },
  });
  const html = renderToStaticMarkup(tree);
  expect(observed).toEqual([undefined]);
  expect(html).not.toContain("data-chart-points");
  expect(state.queries.every((q) => q["enabled"] === false)).toBe(true);
  expect(clickLabel(tree, "다시 시도")).toBe(true);
  expect(state.retryOwner).toHaveBeenCalledOnce();
  expect(state.priceRetry).not.toHaveBeenCalled();
  expect(state.bundleRetry).not.toHaveBeenCalled();
});
test("new payload revisions and owner changes get new query identities", () => {
  render();
  state.owner = "second-owner";
  EtfInstrumentCharts({
    symbol: "360750",
    payload: { ...payload, analysis: { ...payload.analysis, calculatedAt: "new" } },
  });
  expect(
    state.queries.slice(-2).every((q) => {
      const key = q["queryKey"] as unknown[];
      return key[2] === "second-owner" && key[4] === 18;
    }),
  ).toBe(true);
});
test("missing actual underlying data has a neutral empty state instead of a proxy chart", () => {
  state.bundle = { data: { ...bundle, underlying: [], underlyingAsOfDate: null } };
  expect(render()).toContain("실제 기초지수 시계열이 없어 차트를 표시할 수 없습니다.");
  expect(state.charts).toHaveLength(1);
});
test("delayed requests disclose elapsed time instead of a blank spinner", () => {
  state.elapsed = 16;
  const html = renderToStaticMarkup(<EtfChartLoadingStatus phase="m0" range="all" />);
  expect(html).toContain("16초 경과");
  expect(html).toContain("응답이 지연되고 있습니다");
});
test("index identity changes break the price line without losing the dated raw close in the tooltip", () => {
  const changed = {
    tradeDate: "2026-10-12",
    close: 205,
    ma60: null,
    name: "새 지수",
    identityBreak: true,
  };
  const trailing = {
    tradeDate: "2026-10-13",
    close: null,
    ma60: null,
    name: null,
    identityBreak: false,
  };
  state.bundle = {
    data: {
      ...bundle,
      underlying: [bundle.underlying[0], changed, trailing],
      underlyingName: "새 지수",
    },
  };
  render();
  expect(state.charts[1]).toEqual([
    { ...bundle.underlying[0], plotClose: 100 },
    { ...changed, plotClose: null },
  ]);
  const tooltip = renderToStaticMarkup(
    <EtfUnderlyingTooltip active payload={[{ payload: changed }]} />,
  );
  expect(tooltip).toContain("2026-10-12 · 새 지수");
  expect(tooltip).toContain("기초지수 종가 205");
  expect(tooltip).toContain("MA60 미관측");
  const oldTooltip = renderToStaticMarkup(
    <EtfUnderlyingTooltip active payload={[{ payload: bundle.underlying[0]! }]} />,
  );
  expect(oldTooltip).toContain("실제 S&amp;P 500 지수");
  expect(oldTooltip).not.toContain("새 지수");
});
test("a missing exact previous-day M0 is labeled only with its known date", () => {
  expect(summary({ ...bundle, previousM0: null })).toContain("직전 거래일 M0 미관측 · 2026-10-12");
  expect(summary({ ...bundle, previousM0: null, previousTradingDate: null })).not.toContain(
    "직전 거래일 M0 미관측",
  );
});
