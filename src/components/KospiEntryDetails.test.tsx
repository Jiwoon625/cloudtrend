import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KospiEntryDetails } from "./KospiEntryDetails";
import { ScreenerTable } from "./ScreenerTable";
import { ScreenerView } from "./ScreenerView";
import { DashboardSignalCounts, DashboardSignalLists } from "./DashboardOperations";
import { KOSPI_ENTRY_POLICY, type KospiEntrySnapshot } from "@/lib/engine/kospiEntryConfirmation";
import { OPERATIONAL_SIGNAL_VERSION } from "@/lib/engine/operationalStrategy";
import type { AnalysisResult, ScreeningRow } from "@/lib/engine/pipeline";
import type { DomesticPositionContext } from "@/lib/positionSignalContext";
import type { DashboardOperations } from "@/lib/dashboardOperations";
import type { DashboardSummary } from "@/lib/screeningCacheContract";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/portfolioPositionContext", () => ({ loadDomesticPositionContext: vi.fn() }));
vi.mock("@/lib/dashboardOperations.functions", () => ({
  dashboardOperationsServer: vi.fn(),
  dashboardEtfHoldingsServer: vi.fn(),
}));
vi.mock("@/lib/cloud", () => ({ supabase: {} }));

const date = "2026-10-02";
const confirmation = (changes: Partial<KospiEntrySnapshot> = {}): KospiEntrySnapshot => ({
  version: KOSPI_ENTRY_POLICY.version,
  date,
  originDate: "2026-10-01",
  confirmationDate: date,
  state: "confirmed",
  issues: [],
  rsAccel: 1.25,
  score: 8.5,
  originScore: 8,
  eligible: true,
  ...changes,
});
const row = (entry?: KospiEntrySnapshot): ScreeningRow =>
  ({
    instrument: {
      symbol: "005930",
      name: "검증 종목",
      market: "KOSPI",
      instrumentType: "STOCK",
      sectorName: "반도체",
      indexMemberships: [],
    },
    snapshot: { close: 70000, volumeRatio20: null, distanceFrom52wHigh: null },
    operatingScore10: 8.5,
    scoreDelta1d: 5,
    priority: { points: 3, maxPoints: 5, availableMaxPoints: 5 },
    technical: { points: 8.5, maxPoints: 10, availableMaxPoints: 10 },
    grade: "A",
    rs20: 3,
    rs60: 1.75,
    marketCap: null,
    sectorPriceLeadership: null,
    hardFilterPassed: true,
    dataCompletenessRatio: 1,
    warnings: [],
    failedRules: [],
    exitSignal: null,
    kospi80Onset: entry?.state === "pending",
    kosdaq80Onset: false,
    operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
    ...(entry ? { kospiEntry: entry } : {}),
  }) as unknown as ScreeningRow;
const emptyContext: DomesticPositionContext = { heldSymbols: [], lastSellDateBySymbol: {} };
const table = (entry: KospiEntrySnapshot | undefined, context = emptyContext, signalDate = date) =>
  renderToStaticMarkup(
    <ScreenerTable rows={[row(entry)]} positionContext={context} signalDate={signalDate} />,
  );

describe("KOSPI confirmation UI", () => {
  it("does not infer confirmation for an old record without a snapshot", () => {
    const html = renderToStaticMarkup(<KospiEntryDetails entry={undefined} showState />);
    expect(html).toContain("확인 기록 없음 · 진입 판정 제외");
    expect(html).not.toContain("하루 확인 완료");
  });
  it("shows raw onset pending, with RS labeled as pre-confirmation reference", () => {
    const entry = confirmation({
      state: "pending",
      originDate: date,
      confirmationDate: null,
      eligible: false,
    });
    const html = renderToStaticMarkup(<KospiEntryDetails entry={entry} showState />);
    expect(html).toContain("하루 확인 대기");
    expect(html).toContain("Onset 2026-10-02");
    expect(html).toContain("다음 KOSPI 거래일 종가");
    expect(html).toContain("판정일 RSAccel · 확인 전 참고");
    expect(table(entry)).not.toContain("확인일 RS 통과");
  });
  it("shows confirmation dates and positive RS for current ready entry", () => {
    const html = renderToStaticMarkup(<KospiEntryDetails entry={confirmation()} showState />);
    expect(html).toContain("하루 확인 완료");
    expect(html).toContain("판정일 2026-10-02");
    expect(html).toContain("확인 2026-10-02");
    expect(html).toContain("확인일 RSAccel: +1.25%p");
    expect(table(confirmation())).toContain("확인일 RS 통과");
  });
  it.each(["rejected", "unobservable"] as const)(
    "shows stored %s reasons without a ready RS badge",
    (state) => {
      const entry = confirmation({
        state,
        eligible: false,
        rsAccel: null,
        issues: ["확인일 RS 자료 미확인"],
      });
      const html = renderToStaticMarkup(<KospiEntryDetails entry={entry} showState />);
      expect(html).toContain(state === "rejected" ? "확인 탈락" : "확인 불가");
      expect(html).toContain("확인일 RS 자료 미확인");
      expect(html).toContain("확인일 RSAccel: 미확인");
      expect(table(entry)).not.toContain("확인일 RS 통과");
    },
  );
  it("labels pre-effective-date confirmation as reference-only", () => {
    const entry = confirmation({
      eligible: false,
      date: "2026-10-01",
      confirmationDate: "2026-10-01",
      originDate: "2026-09-30",
    });
    const html = renderToStaticMarkup(<KospiEntryDetails entry={entry} showState />);
    expect(html).toContain("과거 확인 참고 · 운영 진입 제외");
    expect(table(entry)).not.toContain("확인일 RS 통과");
  });
  it("suppresses ready badges for actual holdings and origin-day sales", () => {
    expect(
      table(confirmation(), { heldSymbols: ["005930"], lastSellDateBySymbol: {} }),
    ).not.toContain("확인일 RS 통과");
    expect(
      table(confirmation(), { heldSymbols: [], lastSellDateBySymbol: { "005930": "2026-10-01" } }),
    ).toContain("재진입 제외");
    expect(
      table(confirmation(), { heldSymbols: [], lastSellDateBySymbol: { "005930": "2026-10-01" } }),
    ).not.toContain("확인일 RS 통과");
  });
  it("does not promote stale confirmation to a current ready badge", () => {
    const html = table(confirmation(), emptyContext, "2026-10-05");
    expect(html).toContain("기한 지난 확인 · 진입 제외");
    expect(html).not.toContain("확인일 RS 통과");
  });

  it("counts raw onset, pending and confirmed readiness as separate screener presets", () => {
    const client = new QueryClient();
    client.setQueryData(["domestic-position-context"], emptyContext);
    const pending = row(
      confirmation({ state: "pending", originDate: date, confirmationDate: null, eligible: false }),
    );
    const ready = row(confirmation());
    ready.instrument = { ...ready.instrument, symbol: "000660", name: "확인 종목" };
    const analysis = {
      asOfDate: date,
      rows: [pending, ready],
      marketGate: { status: "NEUTRAL", metCount: 2 },
    } as unknown as AnalysisResult;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ScreenerView mode="STOCK" analysis={analysis} />
      </QueryClientProvider>,
    );
    expect(html).toContain("KOSPI 원시 Onset (1)");
    expect(html).toContain("KOSPI 하루 확인 대기 (1)");
    expect(html).toContain("KOSPI 확인 완료 · 진입 준비 (1)");
    expect(html).toContain(">진입 준비 (1)<");
  });

  it("keeps pending dashboard records out of the ready list and count", () => {
    const signal = {
      symbol: "005930",
      name: "확인 준비 종목",
      market: "KOSPI" as const,
      sector: "반도체",
      date,
      price: 70000,
      score: 8.5,
      priority: 3,
      reason: "하루 확인 완료 · 다음 거래일 시가 진입",
    };
    const data: DashboardOperations = {
      markets: [
        {
          market: "KOSPI",
          date,
          holdingsKnown: true,
          onsetCount: 1,
          pendingCount: 2,
          exitCount: 0,
          onsets: [signal],
          pending: [
            { ...signal, symbol: "000660", name: "원시 대기 종목", reason: "하루 확인 대기" },
            { ...signal, symbol: "005380", name: "둘째 대기 종목", reason: "하루 확인 대기" },
          ],
          exits: [],
        },
      ],
      usPortfolio: null,
      etfHoldings: null,
      warnings: [],
    };
    const query = { data, isPending: false, isError: false } as Parameters<
      typeof DashboardSignalLists
    >[0]["query"];
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <DashboardSignalCounts
          query={query}
          counts={{ incomplete: 0 } as DashboardSummary["counts"]}
        />
        <DashboardSignalLists query={query} />
      </QueryClientProvider>,
    );
    expect(html).toContain("KOSPI 하루 확인 대기");
    expect(html).toContain("2종목");
    expect(html).toContain("진입 준비 (1)");
    expect(html).toContain("KOSPI 확인 대기 (2)");
    expect(html).toContain("확인 준비 종목");
    expect(html).not.toContain("원시 대기 종목");
  });
});
