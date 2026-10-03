import React from "react";
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KospiShadowContent } from "../src/components/KospiShadowPanel";
import { UsPortfolioView } from "../src/components/UsPortfolioView";
import { ShadowPage } from "../src/routes/shadow";
import { stepKospiShadow } from "../src/lib/engine/kospiShadow";
import type { KospiShadowView } from "../src/lib/kospiShadowStore";
const ids = ["A0_QUARTER_PRIMARY", "A2_QUARTER_SHADOW", "B3_BETA_SHADOW", "SPY_BENCHMARK"];
vi.mock("@/lib/kospiShadowCloud", () => ({ loadKospiShadow: async () => null }));
vi.mock("@/lib/usProspectiveCloud", () => ({
  loadUsPortfolioSnapshots: async () => [],
  loadUsPortfolioTrades: async () => [],
  loadUsStrategyRegistry: async () => [],
}));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/UsOrderPreview", () => ({
  UsOrderPreview: ({ strategyLabel }: { strategyLabel: string }) => (
    <div>{strategyLabel} 모델 계획</div>
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    isLoading: false,
    isPending: false,
    isError: false,
    error: null,
    data:
      queryKey[0] === "us-strategy-registry"
        ? ids.map((id) => ({ strategy_id: id, role: id.includes("SHADOW") ? "SHADOW" : "PRIMARY" }))
        : queryKey[0] === "us-portfolio-snapshots"
          ? ids.flatMap((id) =>
              ["2026-10-02", "2026-10-01"].map((date) => ({
                strategy_id: id,
                date,
                nav_usd: 100000,
                cash_usd: 50000,
                turnover: 0,
                fees_usd: 0,
                positions_count: 1,
                state: {
                  positions: {
                    TEST: {
                      symbol: id,
                      name: "USsaved",
                      shares: 10,
                      lastPrice: 100,
                      entryDate: "2026-10-01",
                      sector: "IT",
                    },
                  },
                },
              })),
            )
          : queryKey[0] === "us-portfolio-trades"
            ? ids.flatMap((id) =>
                ["2026-10-02", "2026-10-01"].map((date) => ({
                  strategy_id: id,
                  trade_key: `${id}${date}`,
                  signal_date: date,
                  execution_date: date,
                  symbol: `${id}-${date}`,
                  side: "BUY",
                  status: "EXECUTED",
                  model_price: 100,
                  model_shares: 10,
                  fee_usd: 1,
                  reason: "SAVED_MODEL_TRADE",
                })),
              )
            : null,
  }),
}));
function view(): KospiShadowView {
  const latest = stepKospiShadow(
    {
      date: "2026-10-02",
      previousSessionDate: "2026-10-01",
      sourceHash: "hash",
      configHash: "cfg",
      codeVersion: "sha",
      sourceCollectedAt: "2026-10-02T08:00:00Z",
      confirmedClose: true,
      benchmarkClose: 2500,
      gate: { date: "2026-10-02", status: "NEUTRAL", issues: [] },
      rows: [],
    },
    null,
  );
  return {
    schemaVersion: 1,
    registry: {
      strategyId: latest.policy.id,
      ruleVersion: latest.policy.version,
      initializedDate: "2026-10-02",
      configHash: "cfg",
      config: {},
      initialSourceHash: "hash",
      initialCodeVersion: "sha",
    },
    latest,
    history: [latest.daily],
    recentTrades: [],
    tradeHistoryTruncated: false,
  };
}
describe("unified Shadow UI", () => {
  it("uses descriptive KOSPI terminology, distinct currencies and all four historical models", () => {
    const html = renderToStaticMarkup(<ShadowPage />);
    expect(html).toContain("KOSPI 하루확인·불황 시 RSAccel 필터");
    expect(html).toContain("미국 A0 모델 기록 · USD");
    expect(html).toContain("미국 A2 모델 기록 · USD");
    expect(html).toContain("미국 B3 Beta · USD");
    expect(html).toContain("KRW와 USD 금액을 합산하지 않습니다");
    expect(html).not.toContain("223");
  });
  it("shows a truthful uninitialized state with research/actual separation", () => {
    const html = renderToStaticMarkup(
      <KospiShadowContent
        view={null}
        loading={false}
        error={null}
        fromDate=""
        toDate=""
        refresh={() => {}}
      />,
    );
    expect(html).toContain("아직 확정된 KOSPI Shadow 기록이 없습니다");
    expect(html).toContain("실제 매수 가능 신호·실거래·실제 투자금과 분리");
    expect(html).toContain("과거 연구 수익률을 여기에 채우지 않습니다");
  });
  it("shows frozen start, KRW NAV, metrics and missing-error state without invented success", () => {
    const html = renderToStaticMarkup(
      <KospiShadowContent
        view={view()}
        loading={false}
        error={null}
        fromDate="2026-10-02"
        toDate="2026-10-02"
        refresh={() => {}}
      />,
    );
    expect(html).toContain("100,000,000원");
    expect(html).toContain("최대낙폭 MDD");
    expect(html).toContain("평균 노출도");
    expect(html).toContain("2026-10-02");
    expect(html).not.toContain("$100");
    const error = renderToStaticMarkup(
      <KospiShadowContent
        view={null}
        loading={false}
        error="권한 오류"
        fromDate=""
        toDate=""
        refresh={() => {}}
      />,
    );
    expect(error).toContain('role="alert"');
    expect(error).not.toContain("아직 확정된");
  });
  it("keeps A0 primary view separate and links to consolidated Shadows", () => {
    const html = renderToStaticMarkup(<UsPortfolioView />);
    expect(html).toContain("US 포트폴리오 · A0 Primary");
    expect(html).toContain('href="/shadow"');
    expect(html).not.toContain("A2_QUARTER_SHADOW-2026");
    expect(html).not.toContain("B3_BETA_SHADOW-2026");
    expect(html).toContain("A0_QUARTER_PRIMARY-2026-10-02");
  });
  it("shows existing A2/B3 saved positions and only selected model/date trades", () => {
    for (const id of ["A2_QUARTER_SHADOW", "B3_BETA_SHADOW"] as const) {
      const html = renderToStaticMarkup(
        <UsPortfolioView shadowStrategyId={id} fromDate="2026-10-02" toDate="2026-10-02" />,
      );
      expect(html).toContain("USD Shadow");
      expect(html).toContain("$100,000");
      expect(html).toContain(`${id}-2026-10-02`);
      expect(html).not.toContain(`${id}-2026-10-01`);
      expect(html).not.toContain("A0_QUARTER_PRIMARY-2026");
      expect(html).toContain("USsaved");
      expect(html).toContain("상단 요약·보유는 최신 스냅샷");
    }
  });
});
