import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsScreenerPage } from "../src/components/UsScreenerPage";
import { Route as UsInstrumentRoute } from "../src/routes/us.instrument.$symbol";
import { Route as HistoryInstrumentRoute } from "../src/routes/history-instrument.$symbol";
import type { UsProspectiveCache, UsProspectiveCacheRow } from "../src/lib/usProspectiveCloud";
import { OPERATIONAL_START_NOTICE } from "../src/lib/operationalSignalStart";

const state = vi.hoisted(() => ({
  filter: "PRIMARY_ENTRY",
  funnelStrategy: "A0",
  symbol: "ENTRY",
  heldKnown: true,
  download: undefined as (() => void) | undefined,
  cache: null as UsProspectiveCache | null,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) =>
      actual.useState(
        initial === "PRIMARY_ENTRY"
          ? state.filter
          : initial === "A0"
            ? state.funnelStrategy
            : initial,
      ),
  };
});
vi.mock("@/lib/portfolioPositionContext", () => ({ loadDomesticPositionContext: vi.fn() }));
vi.mock("@/lib/usProspectiveCloud", () => ({ loadUsProspectiveCache: vi.fn() }));
vi.mock("@/lib/screeningArchiveQuery", () => ({
  screeningArchiveQueryOptions: (search: Record<string, string>) => ({
    queryKey: ["history", search],
  }),
}));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => {
    if (
      React.Children.toArray(children).some(
        (child) => typeof child === "string" && child.trim() === "CSV",
      )
    )
      state.download = onClick;
    return <button onClick={onClick}>{children}</button>;
  },
}));
vi.mock("@/components/DataError", () => ({ DataError: () => <p>조회 실패</p> }));
vi.mock("@/components/KospiEntryDetails", () => ({ KospiEntryDetails: () => null }));
vi.mock("@/components/OnsetProfileDetails", () => ({ OnsetProfileDetails: () => null }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => ({ symbol: state.symbol }),
    useSearch: () => ({
      date: "2026-10-09",
      runId: "historical-run",
      savedAt: "2026-10-10T02:00:00Z",
      market: "US",
      strategyVersion: "historical-rule",
      dataHash: "historical-hash",
    }),
  }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === "domestic-position-context")
      return {
        isSuccess: state.heldKnown,
        isError: !state.heldKnown,
        data: state.heldKnown ? { heldSymbols: ["EXIT"] } : undefined,
        refetch: vi.fn(),
      };
    if (queryKey[0] === "history")
      return {
        data: {
          asOfDate: "2026-10-09",
          runId: "historical-run",
          strategyVersion: "historical-rule",
          savedAt: "2026-10-10T02:00:00Z",
          entries: [
            {
              symbol: "ENTRY",
              name: "Historical entry",
              market: "US",
              status: "A0 진입 준비",
              evidence: { a0Entry: true, a0Exit: false, coreRank: 0.95, eligibleBase: true },
            },
          ],
        },
        isPending: false,
        refetch: vi.fn(),
      };
    return { data: state.cache, isPending: false, isError: false };
  },
}));

function row(date: string, overrides: Partial<UsProspectiveCacheRow> = {}): UsProspectiveCacheRow {
  return {
    date,
    symbol: "ENTRY",
    name: "Synthetic entry",
    market: "NASDAQ",
    sector: "Technology",
    status: "ACTIVE",
    open: 100,
    close: 102,
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
    marketCap: 10000000,
    onset80: true,
    a0Entry: true,
    a0Exit: false,
    a0BetaExit: false,
    a2Entry: true,
    a2Exit: false,
    b3Entry: true,
    b3Exit: false,
    b3BetaExit: false,
    betaWeakStreak: 0,
    primarySignal: "ENTRY",
    ...overrides,
  };
}
function setDate(date: string) {
  state.cache = {
    generatedAt: "2026-10-13T02:00:00Z",
    dataHash: "synthetic-source-hash",
    source: { provider: "Synthetic", collectedAt: date, schemaVersion: "fixture", metadata: {} },
    analysis: {
      date,
      ruleVersion: "synthetic-rule",
      summary: {},
      rows: [
        row(date),
        row(date, {
          symbol: "EXIT",
          name: "Synthetic exit",
          onset80: false,
          a0Entry: false,
          a2Entry: false,
          b3Entry: false,
          a0Exit: true,
          a2Exit: true,
          b3Exit: true,
          a0BetaExit: true,
          b3BetaExit: true,
          betaWeakStreak: 3,
          primarySignal: "EXIT",
        }),
      ],
    },
  };
}
const UsInstrumentPage = UsInstrumentRoute.options.component as React.ComponentType;
const HistoricalInstrument = HistoryInstrumentRoute.options.component as React.ComponentType;
const renderScreener = () => renderToStaticMarkup(<UsScreenerPage />);
const tableBody = (html: string) => html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
function funnelCounts(html: string) {
  return [...html.matchAll(/class="mt-2 text-lg font-bold tabular-nums">(\d+)<\/div>/g)].map(
    (match) => Number(match[1]),
  );
}
beforeEach(() => {
  state.filter = "PRIMARY_ENTRY";
  state.funnelStrategy = "A0";
  state.symbol = "ENTRY";
  state.heldKnown = true;
  state.download = undefined;
  setDate("2026-10-09");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("US operational signal start", () => {
  it.each([
    "FUNNEL_1",
    "FUNNEL_2",
    "FUNNEL_3",
    "PRIMARY_ENTRY",
    "PRIMARY_EXIT",
    "PRIMARY_WATCH",
    "A2_ENTRY",
    "B3_ENTRY",
  ])("excludes October 9 but includes October 12 rows in %s", (filter) => {
    state.filter = filter;
    const before = JSON.stringify(state.cache);
    const oldHtml = renderScreener();
    expect(oldHtml).toContain(OPERATIONAL_START_NOTICE);
    expect(oldHtml).toContain("전체 0종목");
    expect(tableBody(oldHtml)).toBe("");
    expect(funnelCounts(oldHtml)).toEqual([0, 0, 0, 0]);
    expect(oldHtml).toContain("과거 A0 진입 조건 통과 1");
    expect(oldHtml).toContain("과거 A0 청산 조건 충족 1");
    expect(JSON.stringify(state.cache)).toBe(before);

    setDate("2026-10-12");
    const newHtml = renderScreener();
    expect(newHtml).toContain("전체 1종목");
    expect(funnelCounts(newHtml)).toEqual([1, 1, 1, 1]);
    expect(tableBody(newHtml)).toContain(
      filter === "PRIMARY_EXIT" ? "Synthetic exit" : "Synthetic entry",
    );
  });

  it("gates the B3 funnel by row signal date, not the cache or browser date", () => {
    state.funnelStrategy = "B3";
    state.filter = "FUNNEL_3";
    state.cache!.analysis.date = "2026-10-12";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T01:00:00Z"));
    expect(funnelCounts(renderScreener())).toEqual([0, 0, 0, 0]);
    expect(tableBody(renderScreener())).toBe("");

    setDate("2026-10-12");
    state.cache!.analysis.date = "2026-10-09";
    vi.setSystemTime(new Date("2026-10-09T01:00:00Z"));
    expect(funnelCounts(renderScreener())).toEqual([1, 1, 1, 1]);
    expect(tableBody(renderScreener())).toContain("Synthetic entry");
  });

  it("retains pre-start raw entry and exit evidence without actionable badges in All", () => {
    state.filter = "ALL";
    const html = renderScreener();
    const body = tableBody(html);
    expect(html).toContain("전체 2종목");
    expect(body).toContain("2026-10-09 · 시작 전 과거 계산 근거");
    for (const label of [
      "과거 원신호",
      "과거 진입 조건 통과",
      "과거 청산 조건 충족",
      "과거 A2 진입 조건 통과",
      "과거 B3 청산 조건 충족",
    ])
      expect(body).toContain(label);
    expect(body).not.toContain("진입 준비");
    expect(body).not.toContain("EXIT ·");
    expect(html).toContain('href="/history"');
  });

  it("exports raw historical flags alongside explicit non-operational context", async () => {
    state.filter = "ALL";
    renderScreener();
    const source = JSON.stringify(state.cache);
    let csvBlob: Blob | undefined;
    const click = vi.fn();
    vi.stubGlobal("document", { createElement: () => ({ click }) });
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      csvBlob = blob as Blob;
      return "blob:synthetic-csv";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    state.download!();
    const csv = await csvBlob!.text();
    expect(csv).toContain("date,operationalStartDate,operationalSignalEligible,signalContext");
    expect(csv).toContain('"2026-10-09","2026-10-12","false","시작 전 과거 계산 근거"');
    const [header, entry] = csv.split("\n").map((line) => line.split(","));
    expect(entry[header.indexOf("a0Entry")]).toBe('"true"');
    expect(entry[header.indexOf("primarySignal")]).toBe('"ENTRY"');
    expect(JSON.stringify(state.cache)).toBe(source);
    expect(click).toHaveBeenCalledOnce();
  });

  it("never turns pre-start rejection counts into operational funnel counts", () => {
    state.cache!.analysis.rows.push(
      row("2026-10-09", { symbol: "BETA_FAIL", betaRank: 0.1, a0Entry: false }),
      row("2026-10-09", { symbol: "TK_FAIL", tkRank: 0.1, a0Entry: false }),
      row("2026-10-09", { symbol: "BASE_FAIL", a0Entry: false }),
    );
    const html = renderScreener();
    const rejections = html.match(
      /신규 운용 단계별 탈락 집계<\/summary>([\s\S]*?)<\/details>/,
    )?.[1];
    expect(rejections).toContain("Core 원신호 없음 0");
    expect(rejections).toContain("Beta 미충족 0");
    expect(rejections).toContain("TK미충족 0");
    expect(rejections).toContain("공통 적격 미충족 0");
  });

  it("preserves a failed holdings lookup instead of displaying a verified empty exit list", () => {
    state.filter = "PRIMARY_EXIT";
    state.heldKnown = false;
    expect(renderScreener()).toContain("보유 자료 미확인 · 청산 목록 산정 대기");
    expect(renderScreener()).not.toContain("전체 0종목");
  });

  it("suppresses pre-start detail entry actions while preserving the saved boolean and provenance", () => {
    const html = renderToStaticMarkup(<UsInstrumentPage />);
    const body = tableBody(html);
    expect(html).toContain(OPERATIONAL_START_NOTICE);
    expect(html).toContain("과거 종목별 판정 근거 · A0");
    expect(body).toContain("신규 운용 대상 아님");
    expect(body).toContain("저장된 A0 진입 조건</td><td>조건 통과");
    expect(body).not.toContain("<td>진입 준비</td>");
    expect(html).toContain("&quot;a0Entry&quot;: true");
    expect(html).toContain("&quot;operationalSignalEligible&quot;: false");
    expect(html).toContain("synthetic-source-hash");
    expect(html).toContain("synthetic-rule");
  });

  it("suppresses pre-start held exit detail and allows the October 12 exit", () => {
    state.symbol = "EXIT";
    const oldHtml = renderToStaticMarkup(<UsInstrumentPage />);
    expect(tableBody(oldHtml)).not.toContain("청산 준비");
    expect(tableBody(oldHtml)).toContain("과거 청산 조건 충족");
    expect(oldHtml).toContain("&quot;a0Exit&quot;: true");
    setDate("2026-10-12");
    const newHtml = renderToStaticMarkup(<UsInstrumentPage />);
    expect(tableBody(newHtml)).toContain("청산 준비");
    expect(newHtml).toContain("&quot;operationalSignalEligible&quot;: true");
  });

  it("allows October 12 entry detail even with the browser clock on October 9", () => {
    setDate("2026-10-12");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T01:00:00Z"));
    expect(tableBody(renderToStaticMarkup(<UsInstrumentPage />))).toContain("<td>진입 준비</td>");
  });

  it("leaves explicit dated/version/run historical US evidence intact", () => {
    const html = renderToStaticMarkup(<HistoricalInstrument />);
    expect(html).toContain("과거 신호 근거");
    expect(html).toContain("2026-10-09");
    expect(html).toContain("historical-rule");
    expect(html).toContain("historical-run");
    expect(html).toContain("당시 저장된 판정");
    expect(html).toContain("&quot;a0Entry&quot;: true");
    expect(html).not.toContain("신규 운용 대상 아님");
  });
});
