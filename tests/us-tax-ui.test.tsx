import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsTaxEstimatePanel } from "../src/components/UsTaxEstimatePanel";
import { UsPortfolioLedgers } from "../src/components/UsPortfolioLedgers";
import { UsPortfolioView } from "../src/components/UsPortfolioView";
import {
  estimateUsTaxOverlay,
  US_TAX_SOURCES,
  type UsTaxOverlayResult,
} from "../src/lib/engine/usCapitalGainsTax";
import * as taxOverlay from "../src/lib/usTaxOverlay";
import type { UsActualState } from "../src/lib/usActualLedger";
import type { UsPortfolioSnapshotRecord } from "../src/lib/usProspectiveCloud";

const state = vi.hoisted(() => ({
  snapshots: [] as UsPortfolioSnapshotRecord[],
  actual: undefined as UsActualState | undefined,
  pending: false,
  error: null as Error | null,
}));
vi.mock("@/lib/cloud", () => ({ supabase: {} }));
vi.mock("@/lib/usActualLedger.functions", () => ({ usActualLedgerServer: vi.fn() }));
vi.mock("@/lib/usProspectiveCloud", () => ({
  loadUsPortfolioSnapshots: async () => [],
  loadUsPortfolioTrades: async () => [],
  loadUsStrategyRegistry: async () => [],
}));
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/UsOrderPreview", () => ({ UsOrderPreview: () => null }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    isLoading: state.pending,
    isPending: state.pending,
    isFetching: false,
    isError: !!state.error,
    error: state.error,
    refetch: vi.fn(),
    data:
      queryKey[0] === "us-actual-ledger"
        ? state.actual
        : queryKey[0] === "us-portfolio-snapshots"
          ? state.snapshots
          : [],
  }),
}));

function unavailable(): UsTaxOverlayResult {
  return estimateUsTaxOverlay({
    asOf: "2026-10-02",
    preTaxNavUsd: 110000,
    initialCapitalUsd: 100000,
    kind: "ACTUAL_OWNER",
    poolId: "ACTUAL_OWNER",
    strategyId: null,
    evidence: null,
  });
}
function panel(estimate: UsTaxOverlayResult) {
  return renderToStaticMarkup(
    <UsTaxEstimatePanel estimate={estimate} title="실제 투자 · 양도소득세 추정" />,
  );
}
function snapshot(strategyId: string, date = "2026-10-02"): UsPortfolioSnapshotRecord {
  return {
    strategy_id: strategyId,
    date,
    rule_version: "test-v1",
    nav_usd: 110000,
    cash_usd: 10000,
    benchmark_nav: 102000,
    daily_return: 0,
    cumulative_return: 0.1,
    turnover: 0,
    fees_usd: 0,
    positions_count: 0,
    state: { positions: {} },
  };
}
function actual(): UsActualState {
  return {
    revision: 3,
    document: { capital: 100000, executions: [], excluded: {}, migratedAt: "2026-01-01" },
    actual: {
      positions: [],
      executions: [],
      summary: {
        cash: 10000,
        marketValue: 100000,
        equity: 110000,
        realizedPnl: 1000,
        unrealizedPnl: 9000,
        totalPnl: 10000,
        totalReturn: 10,
        openPositions: 0,
        slotTargetAmount: 5000,
        latestDate: "2026-01-15",
      },
    },
    candidates: [],
    quotes: {
      OLDER: { price: 100, date: "2026-10-01", exitSignal: null },
      NEWER: { price: 200, date: "2026-10-02", exitSignal: null },
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T06:00:00Z"));
  state.snapshots = [];
  state.actual = undefined;
  state.pending = false;
  state.error = null;
});
afterEach(() => vi.useRealTimers());

describe("US tax estimate panel", () => {
  it("keeps six unknown tax/after-tax metrics unknown while preserving known pre-tax NAV/P&L", () => {
    const html = panel(unavailable());
    expect(html).toContain("산출 불가 · 자료 미확인");
    expect(html).toContain("$110,000.00");
    expect(html).toContain("$10,000.00");
    expect(html.match(/<dd[^>]*>미확인<\/dd>/g)).toHaveLength(6);
    expect(html).not.toContain(">$0.00<");
    expect(html).not.toContain(">0원<");
    expect(html).toContain("취득원가·결제일·매수/매도 결제환율");
    expect(html).toContain("미확인은 0원이나 비과세를 뜻하지 않습니다");
  });

  it("distinguishes current tax from prior unpaid and reserve totals for partial estimates", () => {
    const html = panel({
      ...unavailable(),
      status: "PARTIAL",
      currentYearRealizedKrw: 7000000,
      currentYearTaxKrw: 990000,
      priorYearUnpaidKrw: 200000,
      unpaidReserveKrw: 1190000,
      afterTaxNavUsd: 109150,
      afterTaxPnlUsd: 9150,
      missingFields: [],
    });
    for (const text of [
      "등록 거래 기준의 일부 추정치",
      "당해 연도 예상 세액",
      "이전 연도 미납 추정액",
      "미납세금 유보액 합계",
      "7,000,000원",
      "990,000원",
      "200,000원",
      "1,190,000원",
      "$109,150.00",
      "$9,150.00",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("실제 총 납세액 확정에는 다른 계좌");
    expect(html).toContain("원장 밖에서 이미 납부한 세금");
  });

  it("renders verified zero differently from unavailable and preserves negative P&L", () => {
    const html = panel({
      ...unavailable(),
      status: "ESTIMATE",
      currentYearRealizedKrw: -1000000,
      currentYearTaxKrw: 0,
      priorYearUnpaidKrw: 0,
      unpaidReserveKrw: 0,
      preTaxPnlUsd: -1000,
      afterTaxNavUsd: 99000,
      afterTaxPnlUsd: -1000,
      missingFields: [],
    });
    expect(html.match(/<dd[^>]*>0원<\/dd>/g)).toHaveLength(3);
    expect(html).toContain("-1,000,000원");
    expect(html).toContain("-$1,000.00");
    expect(html).not.toContain("등록 거래 기준의 일부 추정치");
  });

  it("keeps methodology compact, accessible, source-linked and explicit about excluded items", () => {
    const html = panel(unavailable());
    expect(html).toContain('role="status"');
    expect(html).toContain("aria-labelledby=");
    expect(html).toContain("<summary");
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
    expect(html).toContain("250만원 초과분 통상 22%");
    expect(html.indexOf("250만원 초과분 통상 22%")).toBeLessThan(html.indexOf("<details"));
    expect(html).toContain("RIA·환헤지 등 특례/세액공제 미반영");
    expect(html).toContain("미실현손익·배당 제외");
    expect(html).toContain("귀속 연도는 결제일 기준");
    expect(html).toContain("매수·매도 각각의 결제일 환율");
    expect(html).toContain("실제 현금 차감·세후 재투자 성과가 아닙니다");
    expect(html).toContain("각각 독립된 연간 세금 계산");
    expect(html).toContain("각각 0.25%");
    expect(html).toContain("세법 확인일");
    for (const source of US_TAX_SOURCES) {
      expect(html).toContain(source.label);
      expect(html).toContain(`href="${source.url.replaceAll("&", "&amp;")}"`);
    }
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("discloses valuation-FX date/source and preserves rate precision only for reserve conversion", () => {
    const html = panel({
      ...unavailable(),
      valuationFx: { date: "2026-10-02", krwPerUsd: 1400.1234, source: "검증된 평가환율" },
    });
    expect(html).toContain("2026-10-02 · 1 USD = 1,400.1234 KRW · 출처 검증된 평가환율");
    expect(html).toContain("유보액 환산에만 쓰며 매매별 세금 계산용 환율을 대신하지 않습니다");
  });

  it("deduplicates missing reasons and does not print non-finite financial amounts", () => {
    const html = panel({
      ...unavailable(),
      preTaxNavUsd: Number.NaN,
      afterTaxNavUsd: Number.POSITIVE_INFINITY,
      currentYearTaxKrw: Number.NaN,
      missingFields: ["원가 확인 필요", "원가 확인 필요"],
    });
    expect(html.match(/원가 확인 필요/g)).toHaveLength(1);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });
});

describe("US tax panel integration", () => {
  it("uses only the selected A0/A2/B3 latest snapshot, independently of date filters", () => {
    const ids = ["A0_QUARTER_PRIMARY", "A2_QUARTER_SHADOW", "B3_BETA_SHADOW"] as const;
    state.snapshots = ids.flatMap((id) => [snapshot(id), snapshot(id, "2026-10-01")]);
    const spy = vi.spyOn(taxOverlay, "modelUsTaxOverlay");
    const before = JSON.stringify(state.snapshots);
    for (const id of ids) {
      const props = id === "A0_QUARTER_PRIMARY" ? {} : { shadowStrategyId: id };
      renderToStaticMarkup(<UsPortfolioView {...props} />);
      const latestEstimate = spy.mock.results.at(-1)?.value as UsTaxOverlayResult;
      const filtered = renderToStaticMarkup(
        <UsPortfolioView {...props} fromDate="2026-10-01" toDate="2026-10-01" />,
      );
      expect(spy).toHaveBeenLastCalledWith(
        expect.objectContaining({ strategy_id: id, date: "2026-10-02" }),
      );
      expect(spy.mock.results.at(-1)?.value).toEqual(latestEstimate);
      expect(filtered).toContain("양도소득세 추정");
      expect(filtered).toContain("화면 날짜 필터는 연간");
      expect(filtered).toContain("산출 불가 · 자료 미확인");
    }
    expect(JSON.stringify(state.snapshots)).toBe(before);
  });

  it("pairs actual/model panels without mutating the ledger and uses the Korean observation date", () => {
    state.actual = actual();
    const before = JSON.stringify(state.actual);
    const spy = vi.spyOn(taxOverlay, "actualUsTaxOverlay");
    const html = renderToStaticMarkup(
      <UsPortfolioLedgers model={snapshot("A0_QUARTER_PRIMARY")} initialTab="actual">
        <p>모델 원장</p>
      </UsPortfolioLedgers>,
    );
    expect(spy).toHaveBeenLastCalledWith({
      document: state.actual.document,
      revision: 3,
      navUsd: 110000,
      capitalUsd: 100000,
      asOf: "2026-10-02",
    });
    expect(html).toContain("A0 모델 · 양도소득세 추정");
    expect(html).toContain("실제 투자 · A0 목표 20종목");
    expect(html).toContain("기록 한도 30종목");
    expect(html).toContain("설정 운용자금 기준 종목당 참고 매입예산: $5,000.00");
    expect(html).not.toContain("실제 투자 · 최대 30종목");
    expect(html).toContain("실제 투자 · 양도소득세 추정");
    expect(html.match(/산출 불가 · 자료 미확인/g)).toHaveLength(2);
    expect(JSON.stringify(state.actual)).toBe(before);
  });

  it("keeps the current observation date even when quotes are absent and the ledger date is old", () => {
    state.actual = { ...actual(), quotes: {} };
    const spy = vi.spyOn(taxOverlay, "actualUsTaxOverlay");
    renderToStaticMarkup(<UsPortfolioLedgers model={undefined}>{null}</UsPortfolioLedgers>);
    expect(spy.mock.calls.at(-1)?.[0].asOf).toBe("2026-10-02");
  });

  it("does not let stale prior-year quotes hide a new-year execution or roll back the tax year", () => {
    vi.setSystemTime(new Date("2027-01-01T14:00:00Z"));
    state.actual = actual();
    state.actual.document.executions.push({
      id: "new-year-buy",
      symbol: "NEWER",
      name: "New year execution",
      market: "US",
      signalKey: null,
      side: "BUY",
      date: "2027-01-01",
      price: 200,
      shares: 1,
      fee: 1,
      note: "",
      order: 0,
    });
    state.actual.actual.summary.latestDate = "2027-01-01";
    const spy = vi.spyOn(taxOverlay, "actualUsTaxOverlay");
    const html = renderToStaticMarkup(
      <UsPortfolioLedgers model={undefined}>{null}</UsPortfolioLedgers>,
    );
    expect(spy.mock.calls.at(-1)?.[0].asOf).toBe("2027-01-01");
    expect(spy.mock.results.at(-1)?.value).toMatchObject({
      taxYear: 2027,
      status: "UNAVAILABLE",
      currentYearTaxKrw: null,
      afterTaxNavUsd: null,
    });
    expect(html).toContain("2027년");
  });

  it("starts the tax observation year at Seoul midnight rather than UTC or New York midnight", () => {
    vi.setSystemTime(new Date("2026-12-31T15:30:00Z"));
    state.actual = actual();
    const spy = vi.spyOn(taxOverlay, "actualUsTaxOverlay");
    renderToStaticMarkup(<UsPortfolioLedgers model={undefined}>{null}</UsPortfolioLedgers>);
    expect(spy.mock.calls.at(-1)?.[0].asOf).toBe("2027-01-01");
    expect(spy.mock.results.at(-1)?.value.taxYear).toBe(2027);
  });

  it("leaves all panel values unknown during loading and after a failed query", () => {
    state.pending = true;
    let html = renderToStaticMarkup(
      <UsPortfolioLedgers model={undefined}>{null}</UsPortfolioLedgers>,
    );
    expect(html).toContain("실제 원장을 불러오는 중입니다");
    expect(html.match(/<dd[^>]*>미확인<\/dd>/g)).toHaveLength(16);
    state.pending = false;
    state.error = new Error("세션 만료");
    html = renderToStaticMarkup(<UsPortfolioLedgers model={undefined}>{null}</UsPortfolioLedgers>);
    expect(html).toContain("세션 만료");
    expect(html).toContain('role="alert"');
    expect(html.match(/<dd[^>]*>미확인<\/dd>/g)).toHaveLength(16);
  });
});
