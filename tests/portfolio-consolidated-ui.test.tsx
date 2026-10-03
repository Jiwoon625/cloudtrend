import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PortfolioAssetHub } from "../src/components/PortfolioAssetHub";
import { UsPortfolioLedgers } from "../src/components/UsPortfolioLedgers";
const gate = vi.hoisted(() => ({ ready: false, checking: false, error: null as string | null }));
vi.mock("@/lib/usePortfolioModelConsolidation", () => ({
  usePortfolioModelConsolidation: () => ({ ...gate, refresh: vi.fn(), refreshing: false }),
}));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/UsModelExecutionJournal", () => ({
  UsModelExecutionJournal: () => <section aria-label="A0 모델 체결 원장">A0 실행 참조</section>,
}));
vi.mock("@/components/UsModelTaxEstimatePanel", () => ({
  UsModelTaxEstimatePanel: ({ title }: { title: string }) => <section>{title}</section>,
}));
vi.mock("@/components/UsTaxEstimatePanel", () => ({
  UsTaxEstimatePanel: ({ title }: { title: string }) => <section>{title}</section>,
}));
vi.mock("@/lib/usTaxOverlay", () => ({ actualUsTaxOverlay: () => ({}) }));
vi.mock("@/lib/cloud", () => ({ supabase: {} }));
vi.mock("@/lib/portfolioLedgers.functions", () => ({ portfolioLedgersServer: vi.fn() }));
vi.mock("@/lib/usActualLedger.functions", () => ({ usActualLedgerServer: vi.fn() }));
vi.mock("@/lib/usProspectiveCloud", () => ({ loadUsPortfolioSnapshots: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data:
      queryKey[0] === "us-actual-ledger"
        ? actual
        : queryKey[0] === "us-portfolio-snapshots"
          ? []
          : undefined,
    isError: false,
    error: null,
    isPending: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
const actual = {
  revision: 1,
  document: { capital: 10000, executions: [], excluded: {}, migratedAt: "2026-10-01" },
  actual: {
    positions: [],
    executions: [],
    summary: {
      cash: 10000,
      marketValue: 0,
      equity: 10000,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      totalReturn: 0,
      openPositions: 0,
      slotTargetAmount: 333.33,
      latestDate: "2026-10-02",
    },
  },
  candidates: [],
  quotes: {},
};
beforeEach(() => {
  gate.ready = false;
  gate.checking = false;
  gate.error = null;
});
const render = () =>
  renderToStaticMarkup(<PortfolioAssetHub domestic={<p>한국 실제 내용</p>} selectedAsset="US" />);
describe("unified portfolio comparison transition", () => {
  it("keeps old reference cards while replacement coverage is unverified and always keeps the A0 journal", () => {
    const html = render();
    expect(html).toContain("A0 모델 포트폴리오");
    expect(html).toContain("A0 모델 · 양도소득세 추정");
    expect(html).toContain("실제 투자 · 양도소득세 추정");
    expect(html).toContain("A0 실행 참조");
    expect(html).toContain("기존 모델 카드를 유지합니다");
  });
  it("removes only model-comparison cards after readiness, preserving actual tax, holdings, controls and A0 journal", () => {
    gate.ready = true;
    const html = render();
    expect(html).not.toContain("A0 모델 포트폴리오");
    expect(html).not.toContain("A0 모델 · 양도소득세 추정");
    expect(html).not.toContain("A0 전략 보유");
    for (const text of [
      "실제 투자 · 양도소득세 추정",
      "실제 보유 종목",
      "실제 운용자금 설정",
      "A0 실행 참조",
      "A0 신호 · 미매수",
    ])
      expect(html).toContain(text);
    expect(html.indexOf("A0 실행 참조")).toBeLessThan(html.indexOf("실제 투자 · 양도소득세 추정"));
    expect(html).toContain('href="/shadow"');
    expect(html).not.toContain('href="/us/portfolio"');
  });
  it("fails closed on readiness loading/error without hiding the actual investment surface", () => {
    gate.checking = true;
    expect(render()).toContain("준비 상태를 확인하고 있습니다");
    gate.checking = false;
    gate.error = "fixture read failure";
    const html = render();
    expect(html).toContain("확인하지 못해 기존 모델 카드를 유지합니다");
    expect(html).toContain("실제 원장 새로고침");
    expect(html).toContain("A0 실행 참조");
  });
  it("resolves an old model-tab selection to actual controls once comparison content moves", () => {
    const html = renderToStaticMarkup(
      <UsPortfolioLedgers
        model={undefined}
        initialTab="model"
        modelComparisonMoved
        modelJournal={<p>A0 참조</p>}
      >
        <p>old model child</p>
      </UsPortfolioLedgers>,
    );
    expect(html).not.toContain("old model child");
    expect(html).toContain("실제 보유 종목");
    expect(html).toContain("A0 참조");
  });
});
