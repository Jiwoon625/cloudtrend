import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { KospiMarketGateEvidence } from "@/lib/engine/kospiMarketGate";
import {
  kospiMarketGateDisplay,
  kospiMarketGateLabel,
  kospiVolatilitySourceLabel,
} from "./kospiEntryPresentation";
import { StrategyDescription } from "./StrategyDescription";
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
const gate = (
  date: string,
  changes: Partial<KospiMarketGateEvidence> = {},
): KospiMarketGateEvidence => ({
  date,
  status: "NEUTRAL",
  issues: [],
  benchmarkAboveMa60: true,
  benchmarkAboveCloud: true,
  vkospiBelow30: false,
  foreignNet5dPositive: false,
  metCount: 2,
  evaluatedCount: 4,
  incomplete: false,
  benchmarkDate: date,
  vkospi: 31,
  volatilitySource: "VKOSPI",
  marketForeignNet5d: -100,
  marketForeignDates: [],
  ...changes,
});
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
  marketGate: { origin: gate("2026-10-01"), confirmation: gate(date) },
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
    snapshot: { tradeDate: date, close: 70000, volumeRatio20: null, distanceFrom52wHigh: null },
    operatingScore10: 8.5,
    scoreDelta1d: entry?.state === "pending" ? 15 : 5,
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
    expect(html).not.toContain("진입 준비");
  });
  it.each([false, true])("shows dated market evidence in compact=%s mode", (compact) => {
    const html = renderToStaticMarkup(
      <KospiEntryDetails entry={confirmation()} compact={compact} />,
    );
    expect(html).toContain("원신호일 시장 2026-10-01");
    expect(html).toContain("확인일 시장 2026-10-02");
    expect(html).toContain("Neutral");
    expect(html).not.toContain("신규 진입 제외");
  });
  it.each([false, true])("keeps bear-blocked raw onset excluded in compact=%s mode", (compact) => {
    const entry = confirmation({
      originDate: date,
      confirmationDate: null,
      state: "rejected",
      eligible: false,
      marketGate: { origin: gate(date, { status: "RISK_OFF", metCount: 1 }), confirmation: null },
      issues: ["발생일 불황(RISK_OFF) · 신규매수 제한 · 새 원신호 필요"],
    });
    const html = renderToStaticMarkup(
      <KospiEntryDetails entry={entry} compact={compact} showState />,
    );
    expect(html).toContain("확인 탈락 · 진입 제외 · 새 원신호 필요");
    expect(html).toContain("원신호일 시장 2026-10-02 · Risk-Off(하락장) · 신규 진입 제외");
    expect(html).toContain("발생일 불황");
    expect(html).not.toContain("하루 확인 대기");
    expect(table(entry)).not.toContain("확인일 RS 통과");
  });
  it.each([
    null,
    gate("2026-09-30"),
    gate("2026-10-01", { status: "UNKNOWN", issues: ["STALE_VOLATILITY_INPUT"], incomplete: true }),
  ])("shows missing, stale or unknown origin evidence as excluded", (origin) => {
    const entry = confirmation({ marketGate: { origin, confirmation: gate(date) } });
    const html = renderToStaticMarkup(<KospiEntryDetails entry={entry} showState />);
    expect(html).toContain("진입 제외");
    expect(html).not.toContain("진입 준비");
    expect(table(entry)).not.toContain("확인일 RS 통과");
  });
  it("keeps older policy confirmation informational", () => {
    const entry = confirmation({ version: "kospi-e8-confirm1-rsaccel-v2" });
    const html = renderToStaticMarkup(<KospiEntryDetails entry={entry} showState />);
    expect(html).toContain("과거 확인 참고 · 운영 진입 제외");
    expect(html).not.toContain("진입 준비");
    expect(table(entry)).not.toContain("확인일 RS 통과");
  });
  it("shows raw onset pending, with RS labeled as pre-confirmation reference", () => {
    const entry = confirmation({
      state: "pending",
      originDate: date,
      confirmationDate: null,
      eligible: false,
      marketGate: { origin: gate(date), confirmation: null },
    });
    const html = renderToStaticMarkup(<KospiEntryDetails entry={entry} showState />);
    expect(html).toContain("하루 확인 대기");
    expect(html).toContain("원신호 2026-10-02");
    expect(html).toContain("다음 KOSPI 거래일 종가");
    expect(html).toContain("판정일 RSAccel · 확인 전 참고");
    expect(table(entry)).not.toContain("확인일 RS 통과");
  });
  it("shows confirmation dates and positive RS for current ready entry", () => {
    const html = renderToStaticMarkup(<KospiEntryDetails entry={confirmation()} showState />);
    expect(html).toContain("진입 준비");
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
    const blocked = row(
      confirmation({
        originDate: date,
        confirmationDate: null,
        state: "rejected",
        eligible: false,
        marketGate: { origin: gate(date, { status: "RISK_OFF", metCount: 1 }), confirmation: null },
        issues: ["발생일 불황(RISK_OFF) · 신규매수 제한 · 새 원신호 필요"],
      }),
    );
    blocked.instrument = { ...blocked.instrument, symbol: "005380", name: "하락장 제외 종목" };
    blocked.kospi80Onset = true;
    blocked.scoreDelta1d = 15;
    const analysis = {
      asOfDate: date,
      rows: [pending, ready, blocked],
      marketGate: { status: "NEUTRAL", metCount: 2 },
    } as unknown as AnalysisResult;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ScreenerView mode="STOCK" analysis={analysis} />
      </QueryClientProvider>,
    );
    expect(html).toContain("원신호 (2)");
    expect(html).toContain("확인 대기 (1)");
    expect(html).toContain("진입 준비 (1)");
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
      reason: "진입 준비 · 다음 거래일 시가 진입",
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
    expect(html).toContain("확인대기(KOSPI/ETF)");
    expect(html).toContain("2/—");
    expect(html).toContain("진입 준비 (1)");
    expect(html).toContain("확인대기 (2)");
    expect(html).toContain("확인 준비 종목");
    expect(html).not.toContain("원시 대기 종목");
  });
});

describe("KOSPI market gate presentation", () => {
  it.each([undefined, null, gate("2026-10-01")])(
    "does not present undated or stale evidence as a known regime",
    (evidence) => {
      const display = kospiMarketGateDisplay(evidence, date);
      expect(display.status).toBe("UNKNOWN");
      expect(display.date).toBe(date);
      expect(display.vkospi).toBeNull();
      expect(display.marketForeignNet5d).toBeNull();
      expect(display.issues.length).toBeGreaterThan(0);
      expect(kospiMarketGateLabel(display.status)).toBe("Unknown(미확인)");
    },
  );
  it("distinguishes incomplete evidence from Risk-Off", () => {
    expect(kospiMarketGateDisplay(gate(date, { incomplete: true }), date).status).toBe("UNKNOWN");
    expect(kospiMarketGateDisplay(gate(date, { status: "RISK_OFF" }), date).status).toBe(
      "RISK_OFF",
    );
    expect(kospiMarketGateDisplay(gate(date), date).status).toBe("NEUTRAL");
  });
  it("renders UNKNOWN explicitly in the stock screener when dated evidence is missing", () => {
    const client = new QueryClient();
    client.setQueryData(["domestic-position-context"], emptyContext);
    const analysis = {
      asOfDate: date,
      rows: [],
      marketGate: { status: "RISK_ON", metCount: 4 },
    } as unknown as AnalysisResult;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ScreenerView mode="STOCK" analysis={analysis} />
      </QueryClientProvider>,
    );
    expect(html).toContain("Unknown(미확인)");
    expect(html).toContain("KOSPI 신규 진입 제외");
  });
  it("names realized volatility as a proxy instead of VKOSPI", () => {
    expect(kospiVolatilitySourceLabel("REALIZED_VOLATILITY_KOSPI")).toBe("KOSPI 실현변동성 대용치");
    expect(kospiVolatilitySourceLabel("REALIZED_VOLATILITY_KOSPI_KOSDAQ_70_30")).toContain(
      "70:30 실현변동성 대용치",
    );
    expect(kospiVolatilitySourceLabel(null)).toBe("출처 미확인");
  });
  it("explains prospective bear exclusion without changing held exits or KOSDAQ rules", () => {
    const html = renderToStaticMarkup(<StrategyDescription />);
    expect(html).toContain("체결 직전 마지막 완료 KOSPI");
    expect(html).toContain("2026-10-02");
    expect(html).toContain("새 원신호이 필요");
    expect(html).toContain("U9.5·H60 청산은 유지");
    expect(html).toContain(
      "KOSDAQ: Stock PL 80 · 8.0 원신호 진입 · U9.0 상향 재돌파 / D3.0 하향 이탈",
    );
  });

  it("shows only concise KOSPI rules on a KOSPI instrument", () => {
    const html = renderToStaticMarkup(<StrategyDescription market="KOSPI" />);
    expect(html).toContain(">KOSPI</h3>");
    expect(html).not.toContain("KOSDAQ");
    expect(html).toContain("다음 거래일 종가에 8점 이상·RSAccel");
    expect(html).toContain("&gt; 0·9.5 상향돌파 없음 확인, 그다음 거래 가능 시가 진입");
    expect(html).toContain("돌파일·체결 직전 완료 거래일 모두 Risk-On 또는 Neutral 필수");
    expect(html).toContain("하락장·시장자료 미확인 시 제외, 새 돌파 필요");
    expect(html).toContain("9.5 상향돌파 또는 60거래일 만기 청산");
    expect(html).toContain("점수 하락 청산 없음 · 섹터 한도 10%");
    expect(html).toContain("점수 청산은 다음 거래일 시가, 만기는 당일 종가");
    expect(html.replace(/<[^>]+>/g, "").length).toBeLessThan(340);
  });

  it("shows only concise KOSDAQ rules on a KOSDAQ instrument", () => {
    const html = renderToStaticMarkup(<StrategyDescription market="KOSDAQ" />);
    expect(html).toContain(">KOSDAQ</h3>");
    expect(html).not.toContain("KOSPI");
    expect(html).not.toContain("RSAccel");
    expect(html).toContain("Stock PL 80 · 8.0 신규 돌파 진입");
    expect(html).toContain("9.0 상향 재돌파·3.0 하향 이탈·60거래일 만기 청산");
    expect(html).toContain("미보유 종목의 동시 돌파는 진입 우선");
    expect(html).toContain("섹터 한도 20%");
    expect(html).toContain("보유 종목·청산한 동일 신호는 진입 제외, 보유 중 청산 우선");
    expect(html.replace(/<[^>]+>/g, "").length).toBeLessThan(220);
  });

  it("keeps the existing full reference for other consumers and non-stock detail", () => {
    expect(renderToStaticMarkup(<StrategyDescription market="ETF" />)).toBe(
      renderToStaticMarkup(<StrategyDescription />),
    );
  });
});

describe("holding-aware KOSPI candidate reference", () => {
  it.each(["pending", "confirmed", "rejected"] as const)(
    "keeps a held %s candidate under a closed reference disclosure",
    (state) => {
      const entry = confirmation({ state });
      const original = structuredClone(entry);
      const html = renderToStaticMarkup(
        <KospiEntryDetails entry={entry} showState entrySuppression="held" />,
      );
      expect(html).toContain("보유 중 · 추가 진입 제외");
      expect(html).toContain("청산 여부는 보유종목 청산 규칙으로 판단합니다.");
      expect(html).toContain("<details>");
      expect(html).not.toContain("<details open");
      expect(html).toContain("종목 공통 확인 기록 (참고)");
      expect(html).toContain("종목 공통 저장 상태:");
      expect(entry).toEqual(original);
    },
  );

  it("keeps an unheld confirmation visible without a holding claim", () => {
    const html = renderToStaticMarkup(<KospiEntryDetails entry={confirmation()} showState />);
    expect(html).toContain("진입 준비");
    expect(html).not.toContain("보유 중");
    expect(html).not.toContain("<details>");
  });

  it("uses actual holdings in the screener to subordinate rejected candidate evidence", () => {
    const html = table(confirmation({ state: "rejected", issues: ["새 원신호 필요"] }), {
      heldSymbols: ["005930"],
      lastSellDateBySymbol: {},
    });
    expect(html).toContain("보유 중 · 추가 진입 제외");
    expect(html).toContain("<details>");
    expect(html).toContain("종목 공통 확인 기록 (참고)");
    expect(html).not.toContain("확인일 RS 통과");
  });

  it("labels a consumed signal after a sale without hiding the stored evidence", () => {
    const html = table(confirmation(), {
      heldSymbols: [],
      lastSellDateBySymbol: { "005930": date },
    });
    expect(html).toContain("매도한 신호 · 재진입 제외");
    expect(html).toContain("종목 공통 확인 기록 (참고)");
    expect(html).not.toContain("보유 중");
    expect(html).not.toContain("확인일 RS 통과");
  });
});

it("shows an unheld confirmation-UP95 condition without an actual sell label in the screener", () => {
  const candidate = {
    ...row(confirmation({ state: "rejected", eligible: false, issues: ["확인일 U9.5 청산신호"] })),
    operatingScore10: 9.5,
    scoreDelta1d: 10,
    exitSignal: "UP95" as const,
  };
  const html = renderToStaticMarkup(
    <ScreenerTable rows={[candidate]} positionContext={emptyContext} signalDate={date} />,
  );
  expect(html).not.toContain("미보유 · KOSPI 9.5점 상향돌파 조건 충족");
  expect(html).toContain("확인일 U9.5 청산신호");
  expect(html).not.toContain("KOSPI 청산 ·");
  expect(html).not.toContain("청산 대기");
  expect(html).not.toContain("확인일 RS 통과");
});
