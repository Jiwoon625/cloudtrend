import React, { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route as SectorsRoute } from "../src/routes/sectors";
import { ScreenerView } from "../src/components/ScreenerView";
import { ScreenerTable } from "../src/components/ScreenerTable";
import { UsScreenerPage } from "../src/components/UsScreenerPage";
import { syncSessionViewOwner } from "../src/lib/useSessionViewState";
import type { AnalysisResult, ScreeningRow } from "../src/lib/engine/pipeline";
import type { SectorRotationRow, FlowStatus } from "../src/lib/engine/sectorRotation";
import type { UsProspectiveCacheRow } from "../src/lib/usProspectiveCloud";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  dirty: false,
  search: {} as { sector?: string },
  analysis: null as unknown,
  usRows: [] as unknown[],
  held: [] as string[],
  heldKnown: true,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (build: () => unknown) => build(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.values[index],
      (next: unknown) => {
        const value = typeof next === "function" ? next(hooks.values[index]) : next;
        if (!Object.is(value, hooks.values[index])) hooks.dirty = true;
        hooks.values[index] = value;
      },
    ];
  },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useSearch: () => hooks.search }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "domestic-position-context")
      return {
        isSuccess: hooks.heldKnown,
        isError: !hooks.heldKnown,
        data: hooks.heldKnown ? { heldSymbols: hooks.held, lastSellDateBySymbol: {} } : undefined,
        refetch: vi.fn(),
      };
    if (queryKey[0] === "us-latest-reference-cache")
      return {
        data: {
          analysis: { rows: hooks.usRows, date: "2026-10-13", summary: {} },
          source: { metadata: {} },
        },
        isPending: false,
        isError: false,
      };
    return { data: { analysis: hooks.analysis }, isPending: false };
  },
}));
vi.mock("@/lib/analysisQuery", () => ({
  analysisQueryOptions: { queryKey: ["analysis"] },
  isAnalysisPayload: () => true,
}));
vi.mock("@/lib/portfolioPositionContext", () => ({ loadDomesticPositionContext: vi.fn() }));
vi.mock("@/lib/usProspectiveCloud", () => ({
  loadUsProspectiveCache: vi.fn(),
  loadUsLatestReferenceCache: vi.fn(),
}));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/PdfExportButton", () => ({ PdfExportButton: () => null }));
vi.mock("@/components/UsRecoveryNotice", () => ({ UsRecoveryNotice: () => null }));
vi.mock("@/components/ui/switch", () => ({ Switch: () => null }));
vi.mock("recharts", () =>
  Object.fromEntries(
    ["CartesianGrid", "Line", "LineChart", "ResponsiveContainer", "Tooltip", "XAxis", "YAxis"].map(
      (key) => [key, () => null],
    ),
  ),
);

const storage = new Map<string, string>();
beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.dirty = false;
  hooks.search = {};
  hooks.held = [];
  hooks.heldKnown = true;
  hooks.usRows = [];
  storage.clear();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
    },
  });
  syncSessionViewOwner("owner-a");
});
afterEach(() => vi.unstubAllGlobals());
function remount() {
  hooks.values = [];
  hooks.cursor = 0;
}
interface Props {
  children?: ReactNode;
  title?: string;
  value?: unknown;
  id?: string;
  "aria-label"?: string;
  "aria-sort"?: string;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  sortKey?: string;
  sort?: { key: string; direction: string } | null;
  rows?: ScreeningRow[];
  row?: UsProspectiveCacheRow;
  paginationKey?: string;
  viewStateKey?: string;
  onClick?: (event: { stopPropagation: () => void }) => void;
  onChange?: (event: { target: { value: string } }) => void;
  onSort?: (key: string) => void;
}
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return React.isValidElement<Props>(node) ? [node, ...nodes(node.props.children)] : [];
}
function render(build: () => ReactNode) {
  let tree: ReactNode;
  for (let count = 0; count < 10; count++) {
    hooks.cursor = 0;
    hooks.dirty = false;
    tree = build();
    if (!hooks.dirty) return { tree, nodes: nodes(tree), html: renderToStaticMarkup(tree) };
  }
  throw new Error("Render did not settle");
}
function click(node: ReactElement<Props> | undefined) {
  expect(node?.props.onClick).toBeTypeOf("function");
  node!.props.onClick!({ stopPropagation: vi.fn() });
}
function change(node: ReactElement<Props> | undefined, value: string) {
  expect(node?.props.onChange).toBeTypeOf("function");
  node!.props.onChange!({ target: { value } });
}
function text(node: ReactNode): string {
  return renderToStaticMarkup(<>{node}</>).replace(/<[^>]*>/g, "");
}
function sector(code: string, status: FlowStatus, score: number, rank = 1): SectorRotationRow {
  return {
    sectorCode: code,
    sectorName: `${code} 섹터`,
    status,
    rank,
    prevRank: rank,
    rotationScore: score,
    rotationMomentum: 50,
    memberCount: 10,
    priceLeadership: { score: 50, completeness: 100, components: [], missing: [] },
    moneyFlow: { score, completeness: 100, components: [], missing: [] },
    reliability: 80,
    reliabilityTag: "HIGH",
    dataCompleteness: 100,
    turnoverShare5d: 20,
    turnoverShareChange5d: 1,
    relativeTurnover: null,
    rs20: null,
    rs60: null,
    rs120: null,
    breadth: {},
    anomalies: [],
    prevMoneyFlow: null,
    prevPriceLeadership: null,
    priceLeadershipChange5d: null,
    foreignNet5dPerTurnover: null,
    quadrant: "LEADING",
    quadrantMove: "유지",
    statusReason: "분류 근거",
  } as SectorRotationRow;
}
function setSectors(rows: SectorRotationRow[]) {
  hooks.analysis = {
    asOfDate: "2026-10-13",
    calculatedAt: "2026-10-13T01:00:00Z",
    sectors: [],
    sectorRotation: {
      asOfDate: "2026-10-13",
      sectors: rows,
      market: { label: "중립", reasons: [], inflowSectorCount: 0, outflowSectorCount: 0 },
      weights: { priceLeadership: 0.4, moneyFlow: 0.45, rotationMomentum: 0.15 },
      overallCompleteness: 100,
      commentary: [],
      excludedItems: [],
      links: [],
      timeline: [],
    },
  };
}
function sectorsView() {
  return render(() => {
    const route = SectorsRoute as unknown as {
      options: {
        component: () => ReactElement<{ analysis: AnalysisResult; initialSector: string }>;
      };
    };
    const page = route.options.component();
    return (page.type as (props: typeof page.props) => ReactNode)(page.props);
  });
}
function stock(symbol: string, score = 8): ScreeningRow {
  return {
    instrument: {
      symbol,
      name: `종목 ${symbol}`,
      market: "KOSPI",
      instrumentType: "STOCK",
      sectorName: "반도체",
      indexMemberships: [],
    },
    snapshot: {
      tradeDate: "2026-10-13",
      close: 10000,
      volumeRatio20: 160,
      distanceFrom52wHigh: -2,
    },
    technical: { points: score, maxPoints: 10, availableMaxPoints: 10 },
    vf: null,
    priority: { points: 4, maxPoints: 5, availableMaxPoints: 4 },
    operatingScore10: score,
    scoreDelta1d: 10,
    grade: "A",
    rs20: 4,
    rs60: 2,
    marketCap: null,
    warnings: [],
    hardFilterPassed: false,
    hardFilterStatus: "PENDING",
    pendingRules: [],
    failedRules: [],
    dataCompletenessRatio: 1,
    exitSignal: null,
  } as unknown as ScreeningRow;
}
function usStock(index: number): UsProspectiveCacheRow {
  return {
    date: "2026-10-13",
    symbol: `T${String(index).padStart(3, "0")}`,
    name: `Fixture ${index}`,
    market: "NASDAQ",
    sector: "Technology",
    close: index + 1,
    ret120: 0.2,
    ret252: 0.3,
    ret120Rank: 0.95,
    ret252Rank: 0.95,
    coreRank: 0.95,
    betaRank: 0.95,
    tkRank: 0.95,
    relvolRank: 0.95,
    liquidityRank: 0.95,
    amihudRank: 0.95,
    adv20Usd: 1000000,
    onset80: true,
    a0Entry: true,
    a2Entry: true,
    b3Entry: true,
    a0Exit: false,
    a2Exit: false,
    b3Exit: false,
    betaWeakStreak: 0,
  } as UsProspectiveCacheRow;
}

describe("sector status summaries and keyboard controls", () => {
  it.each([
    ["STRONG_INFLOW", "최강 유입 섹터"],
    ["EARLY_INFLOW", "최강 유입 섹터"],
    ["SUSTAINED_INFLOW", "최강 유입 섹터"],
    ["OVERHEATED", "최강 유입 섹터"],
    ["EARLY_OUTFLOW", "최대 유출 섹터"],
    ["SUSTAINED_OUTFLOW", "최대 유출 섹터"],
    ["CAPITULATION", "최대 유출 섹터"],
  ] as const)(
    "includes the complete %s classification in its matching summary",
    (status, title) => {
      setSectors([sector("ONLY", status, 50)]);
      const view = sectorsView();
      expect(view.nodes.find((n) => n.props.title === title)?.props.value).toBe("ONLY 섹터");
      const other = title === "최강 유입 섹터" ? "최대 유출 섹터" : "최강 유입 섹터";
      expect(view.nodes.find((n) => n.props.title === other)?.props.value).toBe("없음");
    },
  );
  it("chooses only actual classified flow sets and never relabels a neutral extreme", () => {
    const rows = [
      sector("NEUTRAL_HIGH", "NEUTRAL", 99),
      sector("IN", "EARLY_INFLOW", 60),
      sector("OUT", "SUSTAINED_OUTFLOW", 30),
      sector("UNKNOWN_LOW", "INSUFFICIENT_DATA", 0),
    ];
    const before = structuredClone(rows);
    setSectors(rows);
    const view = sectorsView();
    expect(view.nodes.find((n) => n.props.title === "최강 유입 섹터")?.props.value).toBe("IN 섹터");
    expect(view.nodes.find((n) => n.props.title === "최대 유출 섹터")?.props.value).toBe(
      "OUT 섹터",
    );
    expect(rows).toEqual(before);
  });
  it.each(["NEUTRAL", "INSUFFICIENT_DATA"] as const)(
    "shows 없음 when %s has no classified inflow/outflow",
    (status) => {
      setSectors([sector("ONLY", status, 50)]);
      const view = sectorsView();
      for (const title of ["최강 유입 섹터", "최대 유출 섹터"])
        expect(view.nodes.find((n) => n.props.title === title)?.props.value).toBe("없음");
    },
  );
  it("uses native keyboard-operable sort buttons, toggles aria-sort and expands/collapses details", () => {
    setSectors([sector("FIRST", "EARLY_INFLOW", 70), sector("SECOND", "EARLY_OUTFLOW", 20, 2)]);
    let view = sectorsView();
    expect(
      view.nodes.find((n) => n.type === "th" && text(n).startsWith("순위"))?.props["aria-sort"],
    ).toBe("ascending");
    click(view.nodes.find((n) => n.type === "button" && text(n).startsWith("순위")));
    view = sectorsView();
    expect(
      view.nodes.find((n) => n.type === "th" && text(n).startsWith("순위"))?.props["aria-sort"],
    ).toBe("descending");
    expect(
      view.nodes
        .filter((n) => n.props["aria-expanded"] !== undefined)
        .map((n) => n.props["aria-label"]),
    ).toEqual(["SECOND 섹터 상세 펼치기", "FIRST 섹터 상세 펼치기"]);
    click(view.nodes.find((n) => n.props["aria-label"] === "SECOND 섹터 상세 펼치기"));
    view = sectorsView();
    const expanded = view.nodes.find((n) => n.props["aria-label"] === "SECOND 섹터 상세 접기")!;
    expect(expanded.props["aria-expanded"]).toBe(true);
    expect(view.nodes.some((n) => n.props.id === expanded.props["aria-controls"])).toBe(true);
    click(expanded);
    view = sectorsView();
    expect(view.nodes.some((n) => n.props.id === "sector-detail-SECOND")).toBe(false);
  });
  it("validates deep links, filters the selected sector and opens its details", () => {
    const validate = SectorsRoute.options.validateSearch as (input: Record<string, unknown>) => {
      sector?: string;
    };
    expect(validate({ sector: ["IN"] })).toEqual({});
    expect(validate({ sector: "x".repeat(101) })).toEqual({});
    hooks.search = validate({ sector: " in " });
    setSectors([sector("IN", "EARLY_INFLOW", 60), sector("OUT", "EARLY_OUTFLOW", 20)]);
    const view = sectorsView();
    expect(view.nodes.find((n) => n.props["aria-label"] === "섹터 검색")?.props.value).toBe("in");
    expect(view.nodes.filter((n) => n.props["aria-expanded"] !== undefined)).toHaveLength(1);
    expect(view.html).toContain('id="sector-detail-IN"');
  });
  it("explains zero results and clamps reliability to 0..100", () => {
    setSectors([sector("IN", "EARLY_INFLOW", 60)]);
    let view = sectorsView();
    change(
      view.nodes.find((n) => n.props["aria-label"] === "섹터 검색"),
      "missing",
    );
    view = sectorsView();
    expect(view.html).toContain("조건에 맞는 섹터가 없습니다.");
    const reliability = () => view.nodes.find((n) => n.props.min === 0 && n.props.max === 100);
    change(reliability(), "150");
    view = sectorsView();
    expect(reliability()?.props.value).toBe(100);
    change(reliability(), "-2");
    view = sectorsView();
    expect(reliability()?.props.value).toBe(0);
  });
});

describe("owner-scoped KR and US screener restoration", () => {
  it("does not carry KR filters into another mode without remounting the parent", () => {
    const analysis = {
      asOfDate: "2026-10-13",
      rows: [stock("001")],
      tradeDates: ["2026-10-13"],
      marketGate: { status: "RISK_OFF", metCount: 0 },
    } as AnalysisResult;
    let mode: "STOCK" | "ETF" = "STOCK";
    const build = () => ScreenerView({ mode, analysis });
    let view = render(build);
    change(
      view.nodes.find((n) => n.props["aria-label"] === "종목명 또는 코드"),
      "stock-query",
    );
    mode = "ETF";
    view = render(build);
    expect(view.nodes.find((n) => n.props["aria-label"] === "종목명 또는 코드")?.props.value).toBe(
      "",
    );
    expect(view.nodes.find((n) => n.type === ScreenerTable)?.key).toBe("ETF");
    change(
      view.nodes.find((n) => n.props["aria-label"] === "종목명 또는 코드"),
      "etf-query",
    );
    mode = "STOCK";
    view = render(build);
    expect(view.nodes.find((n) => n.props["aria-label"] === "종목명 또는 코드")?.props.value).toBe(
      "stock-query",
    );
    expect(view.nodes.find((n) => n.type === ScreenerTable)?.key).toBe("STOCK");
    expect(storage.get("cloudtrend-view-v1:legacy-etf-screener:query")).toBe('"etf-query"');
  });
  it("restores KR search/sector/preset and clamps technical/volume filters without touching scores", () => {
    const rows = [stock("001", 8.75), stock("002", 7)];
    const before = structuredClone(rows);
    const analysis = {
      asOfDate: "2026-10-13",
      rows,
      tradeDates: ["2026-10-12", "2026-10-13"],
      marketGate: { status: "RISK_OFF", metCount: 0 },
    } as AnalysisResult;
    const build = () => ScreenerView({ mode: "STOCK", analysis });
    let view = render(build);
    const field = (label: string) => view.nodes.find((n) => n.props["aria-label"] === label);
    expect(field("기술점수 최소")?.props.min).toBe(0);
    expect(field("기술점수 최소")?.props.max).toBe(10);
    expect(view.html).toContain("0~10점 기준");
    change(field("기술점수 최소"), "11");
    view = render(build);
    expect(field("기술점수 최소")?.props.value).toBe(10);
    change(field("기술점수 최소"), "-1");
    view = render(build);
    expect(field("기술점수 최소")?.props.value).toBe(0);
    change(field("거래량 비율 최소(%)"), "-9");
    view = render(build);
    expect(field("거래량 비율 최소(%)")?.props.value).toBe(0);
    change(field("종목명 또는 코드"), "001");
    change(field("섹터"), "반도체");
    click(view.nodes.find((n) => n.type === "button" && text(n).startsWith("자료 판단 보류")));
    remount();
    view = render(build);
    expect(field("종목명 또는 코드")?.props.value).toBe("001");
    expect(field("섹터")?.props.value).toBe("반도체");
    expect(
      view.nodes.find((n) => n.type === ScreenerTable)?.props.rows?.map((r) => r.instrument.symbol),
    ).toEqual(["001"]);
    expect(storage.get("cloudtrend-view-v1:kr-screener:preset")).toBe('"JUDGMENT_PENDING"');
    expect(rows).toEqual(before);
    syncSessionViewOwner("owner-b");
    remount();
    view = render(build);
    expect(field("종목명 또는 코드")?.props.value).toBe("");
  });
  it("restores KR table sorting/page, resets page after filter changes, and keeps other tables local", () => {
    const rows = Array.from({ length: 205 }, (_, i) => stock(String(i).padStart(3, "0"), i / 25));
    let paginationKey = "filter-a";
    const build = () =>
      ScreenerTable({
        rows,
        signalDate: "2026-10-13",
        compactStock: true,
        viewStateKey: "kr-screener",
        paginationKey,
      });
    let view = render(build);
    click(view.nodes.find((n) => n.type === "button" && text(n).startsWith("기술점수")));
    view = render(build);
    click(view.nodes.find((n) => text(n.props.children) === "다음" && n.props.onClick));
    remount();
    view = render(build);
    expect(view.html).toContain("2/3페이지");
    expect(view.html).toContain('aria-sort="descending"');
    expect(storage.get("cloudtrend-view-v1:kr-screener:sort")).toBe('"technical"');
    paginationKey = "filter-b";
    view = render(build);
    expect(view.html).toContain("1/3페이지");
    expect(storage.get("cloudtrend-view-v1:kr-screener:page")).toBe("0");
    const saved = new Map(storage);
    remount();
    view = render(() => ScreenerTable({ rows, signalDate: "2026-10-13", compactStock: true }));
    click(view.nodes.find((n) => text(n.props.children) === "다음" && n.props.onClick));
    expect(storage).toEqual(saved);
    syncSessionViewOwner(null);
    remount();
    view = render(build);
    expect(view.html).toContain("1/3페이지");
    expect(storage.has("cloudtrend-view-v1:kr-screener:sort")).toBe(false);
  });
  it("restores US filter/search/sector/sort/page through remount and resets page on new search", () => {
    hooks.usRows = Array.from({ length: 205 }, (_, i) => usStock(i));
    const before = structuredClone(hooks.usRows);
    let view = render(UsScreenerPage);
    change(
      view.nodes.find((n) => n.props["aria-label"] === "티커 또는 종목명"),
      "Fixture",
    );
    change(
      view.nodes.find((n) => n.props["aria-label"] === "섹터"),
      "Technology",
    );
    click(view.nodes.find((n) => text(n.props.children) === "산정 가능 전체" && n.props.onClick));
    view = render(UsScreenerPage);
    view.nodes.find((n) => n.props.sortKey === "close")!.props.onSort!("close");
    view = render(UsScreenerPage);
    click(view.nodes.find((n) => text(n.props.children) === "다음" && n.props.onClick));
    remount();
    view = render(UsScreenerPage);
    expect(view.html).toContain("2 / 3페이지");
    expect(view.nodes.find((n) => n.props["aria-label"] === "티커 또는 종목명")?.props.value).toBe(
      "Fixture",
    );
    expect(view.nodes.find((n) => n.props["aria-label"] === "섹터")?.props.value).toBe(
      "Technology",
    );
    expect(view.nodes.find((n) => n.props.sortKey === "close")?.props.sort).toEqual({
      key: "close",
      direction: "asc",
    });
    expect(storage.get("cloudtrend-view-v1:us-screener:actual-filter")).toBe('"ALL"');
    expect(hooks.usRows).toEqual(before);
    change(
      view.nodes.find((n) => n.props["aria-label"] === "티커 또는 종목명"),
      "T204",
    );
    view = render(UsScreenerPage);
    expect(view.html).toContain("1 / 1페이지");
    expect(storage.get("cloudtrend-view-v1:us-screener:page")).toBe("0");
    syncSessionViewOwner("owner-b");
    remount();
    view = render(UsScreenerPage);
    expect(view.nodes.find((n) => n.props["aria-label"] === "티커 또는 종목명")?.props.value).toBe(
      "",
    );
    expect(view.nodes.find((n) => n.props.sortKey === "close")?.props.sort).toBe(null);
  });
  it("retains the operational-date and held-only exit restrictions after US filter restoration", () => {
    hooks.usRows = [
      { ...usStock(0), date: "2026-10-09", a0Exit: true, a0Entry: false },
      { ...usStock(1), a0Exit: true, a0Entry: false },
      { ...usStock(2), a0Exit: true, a0Entry: false },
    ];
    hooks.held = ["T000", "T001"];
    storage.set("cloudtrend-view-v1:us-screener:actual-filter", '"PRIMARY_EXIT"');
    const view = render(UsScreenerPage);
    expect(view.nodes.flatMap((n) => (n.props.row ? [n.props.row.symbol] : []))).toEqual(["T001"]);
    hooks.heldKnown = false;
    const unavailable = render(UsScreenerPage);
    expect(unavailable.nodes.some((n) => n.props.row)).toBe(false);
    expect(unavailable.html).toContain("보유 자료 미확인 · 청산 목록 산정 대기");
  });
});
