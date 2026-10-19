import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsScreenerPage } from "../src/components/UsScreenerPage";
import { Route } from "../src/routes/us.instrument.$symbol";
import type { UsProspectiveCache } from "../src/lib/usProspectiveCloud";
import { canonicalCache, referenceCache, row } from "./fixtures/us-same-session-reference";

const state = vi.hoisted(() => ({
  data: null as UsProspectiveCache | null,
  filter: "PRIMARY_ENTRY",
  symbol: "TEST",
  held: [] as string[],
  heldKnown: true,
  download: undefined as (() => void) | undefined,
  keys: [] as string[],
}));
vi.mock("@/lib/usProspectiveCloud", () => ({
  loadUsProspectiveCache: vi.fn(),
  loadUsLatestReferenceCache: vi.fn(),
}));
vi.mock("@/lib/portfolioPositionContext", () => ({ loadDomesticPositionContext: vi.fn() }));
vi.mock("@/lib/useSessionViewState", () => ({
  useSessionViewState: (key: string, fallback: unknown) => [
    key === "us-screener:actual-filter" ? state.filter : fallback,
    vi.fn(),
  ],
  viewChoice: vi.fn(),
  viewPage: vi.fn(),
  viewText: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    state.keys.push(queryKey[0]!);
    if (queryKey[0] === "domestic-position-context")
      return {
        isSuccess: state.heldKnown,
        isError: !state.heldKnown,
        refetch: vi.fn(),
        data: state.heldKnown
          ? { heldSymbols: state.held, lastSellDateBySymbol: {}, actualEntryDecisions: [] }
          : undefined,
      };
    return { data: state.data, isPending: false, isError: false, refetch: vi.fn() };
  },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => ({ symbol: state.symbol }),
  }),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/DataError", () => ({ DataError: () => <p>조회 실패</p> }));
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
const Instrument = Route.options.component as React.ComponentType;
const body = (html: string) => html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
beforeEach(() => {
  state.data = referenceCache();
  state.filter = "PRIMARY_ENTRY";
  state.symbol = "TEST";
  state.held = [];
  state.heldKnown = true;
  state.download = undefined;
  state.keys = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("same-session reference-only US screens", () => {
  it.each(["screener", "instrument"])(
    "shows collection/revision provenance and protected operational scope on %s",
    (screen) => {
      const html = renderToStaticMarkup(
        screen === "screener" ? <UsScreenerPage /> : <Instrument />,
      );
      expect(html).toContain("동일 거래일 최신 재수집 · 참고용");
      expect(html).toContain("bbbbbbbbbbbb");
      expect(html).toContain("2026-10-17");
      expect(html).toContain("KST");
      expect(html).toContain("원본과 실제 매매 계획·Shadow·체결은 변경되지");
      expect(state.keys).toContain("us-latest-reference-cache");
      expect(state.keys).not.toContain("us-prospective-cache");
    },
  );
  it("shows reference entry conditions even for held symbols without suggesting executable entry", () => {
    state.held = ["TEST"];
    const html = renderToStaticMarkup(<UsScreenerPage />);
    expect(body(html)).toContain("참고 진입 조건 통과");
    expect(body(html)).not.toContain("진입 준비");
    expect(body(html)).not.toContain("실제 보유");
    expect(html).toContain("참고 정렬");
    expect(html).not.toContain("배정 우선순위");
  });
  it("does not depend on holdings availability to show reference exits", () => {
    state.heldKnown = false;
    state.filter = "PRIMARY_EXIT";
    state.data!.analysis.rows = [
      row({
        a0Entry: false,
        a0Exit: true,
        a0BetaExit: true,
        betaWeakStreak: 3,
        primarySignal: "EXIT",
      }),
    ];
    const html = renderToStaticMarkup(<UsScreenerPage />);
    expect(body(html)).toContain("참고 청산 조건 충족");
    expect(html).not.toContain("청산 대기");
    expect(html).not.toContain("보유 자료 조회 실패");
    expect(html).toContain("전체 1종목");
  });
  it("does not turn a reference instrument signal into a real entry or exit instruction", () => {
    state.held = ["TEST"];
    state.data!.analysis.rows = [
      row({ a0Entry: true, a0Exit: true, a0BetaExit: true, betaWeakStreak: 3 }),
    ];
    const html = renderToStaticMarkup(<Instrument />);
    expect(body(html)).toContain("실제 진입 계획 미반영");
    expect(body(html)).toContain("실제 청산 계획 미반영");
    expect(body(html)).not.toMatch(/진입 준비|청산 준비|보유 유지/);
    expect(html).toContain("&quot;operationalSignalEligible&quot;: false");
    expect(html).toContain("&quot;referenceOnly&quot;: true");
  });
  it.each(["screener", "instrument"])(
    "shows original fallback without claiming verified latest on %s",
    (screen) => {
      state.data = canonicalCache();
      state.data.source.metadata["sameSessionRevisionStatus"] = "unavailable";
      const html = renderToStaticMarkup(
        screen === "screener" ? <UsScreenerPage /> : <Instrument />,
      );
      expect(html).toContain("재수집 자료를 검증하지 못해 저장된 원본을 표시합니다.");
      expect(html).not.toContain("동일 거래일 최신 재수집 · 참고용");
      expect(html).not.toContain("리비전");
      expect(body(html)).toContain("진입 준비");
    },
  );
  it("leaves the canonical holding and entry gating unchanged", () => {
    state.data = canonicalCache();
    state.held = ["TEST"];
    const html = renderToStaticMarkup(<UsScreenerPage />);
    expect(html).toContain("전체 0종목");
    expect(html).toContain("A0 진입 준비");
    expect(html).not.toContain("참고용");
  });
  it("exports explicit reference provenance and disables operational eligibility in CSV", async () => {
    let blob: Blob | undefined;
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor });
    vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
      blob = value as Blob;
      return "blob:synthetic";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    renderToStaticMarkup(<UsScreenerPage />);
    state.download!();
    const csv = await blob!.text();
    expect(csv).toContain("referenceOnly,collectedAt,revisionDataHash,originalDataHash");
    expect(csv).toContain('"false","재수집 참고용 · 실제 계획 미반영","true"');
    expect(csv).toContain(`"${state.data!.dataHash}"`);
    expect(csv).toContain('"2026-10-16T23:00:00Z"');
    expect(anchor.download).toBe("cloudtrend-us-2026-10-16-reference.csv");
  });
});
