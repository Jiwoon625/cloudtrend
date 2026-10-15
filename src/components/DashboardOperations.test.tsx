import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DashboardSignalCounts,
  DashboardSignalLists,
  DashboardStrategyRules,
  UsDashboardPortfolio,
} from "./DashboardOperations";
import type {
  DashboardMarket,
  DashboardOperations,
  DashboardSignal,
} from "@/lib/dashboardOperations";
import type { DashboardSummary } from "@/lib/screeningCacheContract";

// Select each real component state for server-rendered assertions. Browser QA covers clicks.
const state = vi.hoisted(() => ({ tab: "onsets", market: "ALL" }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) =>
      actual.useState(
        initial === "onsets" ? state.tab : initial === "ALL" ? state.market : initial,
      ),
  };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode;
    to: string;
    params?: { symbol: string };
  }) => <a href={params ? to.replace("$symbol", params.symbol) : to}>{children}</a>,
}));
vi.mock("@/lib/dashboardOperations.functions", () => ({
  dashboardOperationsServer: vi.fn(),
  dashboardEtfHoldingsServer: vi.fn(),
}));
vi.mock("@/lib/cloud", () => ({ supabase: {} }));
const date = "2026-10-02";

describe("concise dashboard strategy rules", () => {
  const markup = () => renderToStaticMarkup(<DashboardStrategyRules />);

  it("describes A0 fixed initial-capital slots without quarterly or funding sales", () => {
    const html = markup();
    expect(html).toContain("계좌별 초기 투자금액 ÷ 고정 목표 20종목");
    expect(html).toContain("당일 후보 수·현재 평가자산으로 다시 나누지 않습니다");
    expect(html).toContain("정기 리밸런싱과 신규 진입 자금 마련용 부분매도는 하지 않으며");
    expect(html).not.toContain("비중조정은 분기별");
  });

  it("keeps KOSPI confirmation, market guards, exits and sector limit", () => {
    const html = markup();
    expect(html).toContain(">KOSPI</h3>");
    expect(html).toContain("ETF PL 84 우선 / Stock PL 80 대체");
    expect(html).toContain("8.0 신규 돌파 후 다음 거래일 종가에 8점 이상·RSAccel");
    expect(html).toContain("&gt; 0·9.5 상향돌파 없음 확인, 그다음 거래 가능 시가 진입");
    expect(html).toContain("돌파일·체결 직전 완료 거래일 모두 Risk-On 또는 Neutral 필수");
    expect(html).toContain("하락장·시장자료 미확인 시 제외, 새 돌파 필요");
    expect(html).toContain("9.5 상향돌파 또는 60거래일 만기 청산");
    expect(html).toContain("점수 하락 청산 없음 · 섹터 한도 10%");
  });

  it("keeps adopted KOSDAQ 9/3 exits, timing and held-signal priority", () => {
    const html = markup();
    expect(html).toContain(">KOSDAQ</h3>");
    expect(html).toContain("Stock PL 80 · 8.0 신규 돌파 진입");
    expect(html).toContain("9.0 상향 재돌파·3.0 하향 이탈·60거래일 만기 청산");
    expect(html).toContain("진입은 다음 거래일 시가 · 미보유 종목의 동시 돌파는 진입 우선");
    expect(html).toContain("섹터 한도 20%");
    expect(html).toContain("점수 청산은 다음 거래일 시가, 만기는 당일 종가");
    expect(html).toContain("보유 종목·청산한 동일 신호는 진입 제외, 보유 중 청산 우선");
  });

  it("removes repeated implementation history while preserving ETF and US copy", () => {
    const html = markup();
    const domesticText = html.split("ETF · M0")[0]!.replace(/<[^>]+>/g, "");
    expect(domesticText.length).toBeLessThan(500);
    expect(html).not.toContain("2026-10-02");
    expect(html).not.toContain("기존 운영 전략 유지");
    expect(html).not.toContain("되살리지 않으며");
    expect(html).toContain(
      "M0 80점 돌파 진입 · 기초지수 MA60 하회 또는 보유 후 최고 기준가격 대비 −10% E4 종가 신호 → 다음 거래 가능 시가 청산.",
    );
    expect(html).toContain(
      "Core 상위 30% 밖 또는 산정 불가 시 청산. Beta 상위 40% 밖 3거래일 연속도 청산합니다.",
    );
  });
});

const signal = (market: DashboardMarket, number: number, kind = "pending"): DashboardSignal => ({
  symbol: `${market}${number}`,
  name: `${market} ${kind} ${number}`,
  market,
  date,
  sector: "검증",
  price: 10000,
  score: market === "ETF" ? 81 : 8.5,
  priority: 1,
  reason: kind === "pending" ? "다음 거래일 종가 확인 대기" : "확인 완료",
});
const data = (kospi: number | null, etf: number | null): DashboardOperations => ({
  markets: (["KOSPI", "KOSDAQ", "ETF", "US"] as const).map((market) => {
    const pendingCount = market === "KOSPI" ? kospi : market === "ETF" ? etf : 0;
    return {
      market,
      date,
      holdingsKnown: true,
      conditionCount: 1,
      conditions: [signal(market, 99, "condition")],
      onsetCount: 1,
      exitCount: 0,
      pendingCount,
      pending: Array.from({ length: pendingCount ?? 0 }, (_, n) => signal(market, n)),
      onsets: [signal(market, 99, "ready")],
      exits: [],
    };
  }),
  usPortfolio: null,
  etfHoldings: null,
  warnings: [],
});
const query = (value: DashboardOperations | undefined, extra = {}) =>
  ({
    data: value,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
    ...extra,
  }) as unknown as Parameters<typeof DashboardSignalLists>[0]["query"];
const counts = { incomplete: 0 } as DashboardSummary["counts"];
const renderCounts = (value: DashboardOperations | undefined, extra = {}) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <DashboardSignalCounts query={query(value, extra)} counts={counts} />
    </QueryClientProvider>,
  );
const renderList = (value: DashboardOperations | undefined, extra = {}) =>
  renderToStaticMarkup(<DashboardSignalLists query={query(value, extra)} />);

beforeEach(() => {
  state.tab = "onsets";
  state.market = "ALL";
});
describe("combined dashboard confirmation counts", () => {
  it("keeps missing-input judgment separate from confirmation waiting and score completeness", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <DashboardSignalCounts
          query={query(data(3, 1))}
          counts={{ ...counts, pending: 7, incomplete: 2 }}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("주식 판단 보류");
    expect(html).toContain(">7</span>");
    expect(html).toContain("점수 산정 불가");
    expect(html).toContain(">2</span>");
    expect(html).toContain(">3/1</span>");
  });
  it.each([
    [3, 1],
    [0, 1],
    [3, 0],
    [0, 0],
  ])("renders KOSPI/ETF %i/%i without swapping or hiding zeros", (kospi, etf) => {
    const html = renderCounts(data(kospi!, etf!));
    expect(html).toContain("확인대기(KOSPI/ETF)");
    expect(html).toContain(`>${kospi}/${etf}</span>`);
    expect(html).toContain(`aria-label="KOSPI ${kospi}종목, ETF ${etf}종목"`);
    expect(html).not.toContain("KOSPI 하루 확인 대기");
  });
  it("keeps unknown signal counts separate from zero", () => {
    expect(renderCounts(data(null, 1))).toContain(">—/1</span>");
    expect(renderCounts(data(3, null))).toContain(">3/—</span>");
    expect(renderCounts(undefined, { isPending: true })).toContain(">—/—</span>");
    expect(renderCounts(undefined, { isError: true })).toContain("신호 조회 실패");
  });
});
describe("held K4/E4 execution-pending alerts", () => {
  it("shows one real holding alert per security, without inventing brokerage fills", () => {
    const value = data(0, 0);
    const k = value.markets.find((m) => m.market === "KOSPI")!;
    const etf = value.markets.find((m) => m.market === "ETF")!;
    const alert = {
      ...signal("KOSPI", 1),
      held: true,
      date: "2026-10-15",
      reason: "K4 · 2026-10-15 확정 종가 신호 · 다음 거래 가능 시가 청산 대기",
    };
    k.exits = [alert, structuredClone(alert)];
    k.exitCount = 1;
    etf.exits = [{
      ...signal("ETF", 2), held: true, date: "2026-10-15",
      reason: "E4 · 2026-10-15 확정 종가 신호 · 다음 거래 가능 시가 청산 대기",
    }];
    etf.exitCount = 1;
    const html = renderCounts(value);
    expect(html).toContain("K4/E4 청산신호 · 실제 매도 체결 확인 필요 (2종목)");
    expect(html).toContain("실제 포트폴리오에 기록해 주세요");
    expect(html).toContain("미체결 신호는 가격이 회복해도 유지됩니다");
    expect(html).toContain('href="/portfolio"');
  });
  it("never raises a real-account stop from a model-only or unheld exit", () => {
    const value = data(0, 0);
    value.markets[0]!.exits = [{
      ...signal("KOSPI", 1), held: false,
      reason: "K4 · model-only synthetic exit",
    }];
    expect(renderCounts(value)).not.toContain("K4/E4 청산신호 · 실제 매도 체결 확인 필요");
  });
});

describe("combined dashboard confirmation list", () => {
  beforeEach(() => {
    state.tab = "pending";
  });
  it("keeps KRX-delayed confirmation compact with its original signal date and no invented score", () => {
    const value = data(0, 1);
    const etf = value.markets.find((m) => m.market === "ETF")!;
    etf.pending![0] = {
      ...etf.pending![0]!,
      date: "2027-06-28",
      score: null,
      signalOriginDate: "2027-06-25",
      reason: "KRX 자료 대기 · 기존 확인대기 유지",
    };
    const html = renderList(value);
    expect(html).toContain("확인대기 (1)");
    expect(html).toContain("KRX 자료 대기 · 기존 확인대기 유지");
    expect(html).toContain("원신호 2027-06-25");
    expect(html).toContain("2027-06-28");
    expect(html).not.toContain("81.0 / 100");
    expect(html).not.toContain("자료 미수신·확인 탈락은 포함하지 않습니다");
    expect(html).not.toContain("실제 예산 · 예상 수량</th>");
    expect(html.match(/<th /g)).toHaveLength(6);
    expect(renderCounts(value)).toContain('aria-label="KOSPI 0종목, ETF 1종목"');
  });
  it("merges KOSPI and ETF once, labels each market and score scale, and links each symbol", () => {
    const html = renderList(data(3, 1));
    expect(html).toContain("확인대기 (4)");
    expect(html).toContain("조건달성종목 · KOSPI / ETF");
    for (const market of ["KOSPI", "ETF"] as const) {
      expect(html).toContain(`>${market}</td>`);
      expect(html).toContain(`href="/instrument/${market}0"`);
      expect(html.match(new RegExp(`${market} pending 0`, "g"))).toHaveLength(1);
    }
    expect(html).toContain("8.5 / 10");
    expect(html).toContain("81.0 / 100");
    expect(html).not.toContain("ready 99");
    expect(html).not.toContain("KOSPI 확인 대기");
    expect(html).toContain("flex flex-wrap gap-2");
    expect(html).toContain("overflow-x-auto");
  });
  it.each(["KOSPI", "ETF"])("filters confirmation rows to %s", (market) => {
    state.market = market;
    const html = renderList(data(3, 1));
    expect(html).toContain(`${market} pending 0`);
    expect(html).not.toContain(`${market === "KOSPI" ? "ETF" : "KOSPI"} pending 0`);
    expect(html).toContain('option value="ETF"');
    expect(html).not.toContain('option value="KOSDAQ"');
  });
  it.each([
    [0, 1],
    [3, 0],
    [0, 0],
  ])("handles confirmation list %i/%i", (kospi, etf) => {
    const html = renderList(data(kospi!, etf!));
    expect(html).toContain(`확인대기 (${kospi! + etf!})`);
    expect(html.includes("KOSPI pending 0")).toBe(kospi! > 0);
    expect(html.includes("ETF pending 0")).toBe(etf! > 0);
    if (kospi === 0 && etf === 0) expect(html).toContain("해당 확인대기 종목이 없습니다.");
  });
  it("does not count unknown markets as confirmed empty", () => {
    const partial = renderList(data(null, 1));
    expect(partial).toContain("일부 시장은 신호 또는 보유정보가 미확인입니다.");
    expect(partial).toContain("ETF pending 0");
    const missing = data(0, 0);
    missing.markets = missing.markets.filter((m) => m.market !== "ETF");
    expect(renderList(missing)).toContain(
      "확인된 신호가 없습니다. 미확인 시장의 데이터를 확인해 주세요.",
    );
    expect(renderList(undefined, { isPending: true })).toContain("저장된 신호를 불러오는 중입니다");
    expect(renderList(undefined, { isError: true })).toContain("신호를 불러오지 못했습니다.");
  });
  it("paginates the merged list rather than truncating market counts", () => {
    const html = renderList(data(24, 3));
    expect(html).toContain("확인대기 (27)");
    expect(html).toContain("ETF pending 0");
    expect(html).not.toContain("ETF pending 1");
    expect(html).toContain("27종목 · 1 / 2");
  });
  it("includes ETF actual candidates while keeping confirmation-only rows out of action lists", () => {
    for (const tab of ["onsets", "exits"]) {
      state.tab = tab;
      const html = renderList(data(3, 1));
      expect(html).not.toContain("pending 0");
      expect(html.includes("ETF ready 99")).toBe(tab === "onsets");
      expect(html).toContain('option value="ETF"');
    }
  });
});

describe("Korean sector-limit badges", () => {
  const withLimits = () => {
    const value = data(1, 1);
    for (const market of value.markets) {
      for (const row of [...market.onsets, ...(market.pending ?? [])]) {
        if (row.market !== "KOSPI" && row.market !== "KOSDAQ") continue;
        row.sectorLimit = {
          status: "blocked",
          count: 6,
          limit: row.market === "KOSPI" ? 3 : 6,
          cap: row.market === "KOSPI" ? 0.1 : 0.2,
          maxPositions: 30,
          asOfDate: date,
          issue: null,
        };
      }
    }
    return value;
  };
  it("keeps entry signals and scores visible with count/limit and explicit block text", () => {
    const html = renderList(withLimits());
    expect(html).toContain("섹터 제한 · 6/3종목");
    expect(html).toContain("섹터 제한 · 6/6종목");
    expect(html).toContain("추가 진입 제한");
    expect(html).toContain(`실제 배분 기준 ${date}`);
    expect(html).toContain("KOSPI 한도 10% · 국내 30슬롯");
    expect(html).toContain("KOSDAQ 한도 20% · 국내 30슬롯");
    expect(html).toContain("KOSPI ready 99");
    expect(html).toContain("KOSDAQ ready 99");
    expect(html).toContain("8.5 / 10");
    expect(html).toContain("실제 미보유 후보 (4)");
    expect(html).toContain("실제 S06 배분은 한국/ETF/미국 40/20/40입니다");
    expect(html).toContain("진입 조건 충족은 계속 표시합니다");
    expect(html).toContain("실제 주문 전에 체결가와 주문가능 현금을 다시 확인하세요");
  });
  it("labels pending KOSPI without implying confirmation completion or restricting ETFs", () => {
    state.tab = "pending";
    const html = renderList(withLimits());
    expect(html).toContain("섹터 제한 · 6/3종목");
    expect(html.match(/data-sector-status=/g)).toHaveLength(1);
    expect(html).toContain("다음 거래일 종가 확인 대기");
    expect(html).toContain("ETF pending 0");
  });
  it("uses neutral snapshot room and preserves zero", () => {
    const value = withLimits();
    const badge = value.markets[0]!.onsets[0]!.sectorLimit!;
    badge.status = "room";
    badge.count = 0;
    const html = renderList(value);
    expect(html).toContain("섹터 여유 · 0/3종목");
    expect(html).not.toContain("진입 가능");
  });
  it("shows missing or stale data as unknown with the saved date", () => {
    expect(renderList(data(1, 1))).toContain("섹터 미확인 · —/—종목");
    const value = withLimits();
    const badge = value.markets[0]!.onsets[0]!.sectorLimit!;
    badge.status = "unknown";
    badge.asOfDate = "2026-09-30";
    badge.issue = "신호·장부 기준일 불일치";
    const html = renderList(value);
    expect(html).toContain("섹터 미확인 · 6/3종목");
    expect(html).toContain("신호·장부 기준일 불일치");
    expect(html).toContain("실제 배분 기준 2026-09-30");
  });
  it("keeps labels and Korean-sector notes off US-only and EXIT views", () => {
    state.market = "US";
    let html = renderList(withLimits());
    expect(html).not.toContain("data-sector-status");
    expect(html).not.toContain("섹터 보유 수는");
    state.market = "ALL";
    state.tab = "exits";
    const value = withLimits();
    value.markets[0]!.exits = value.markets[0]!.onsets;
    html = renderList(value);
    expect(html).not.toContain("data-sector-status");
    expect(html).not.toContain("섹터 보유 수는");
  });
});

it("ignores old US holdings and displays only new-series actual counts and funding", () => {
  const value = data(0, 0);
  value.usPortfolio = {
    capital: 12000,
    unpricedPositions: 0,
    summary: {
      cash: 11000,
      marketValue: 2000,
      equity: 13000,
      realizedPnl: 87654,
      unrealizedPnl: 98765,
      totalPnl: 186419,
      totalReturn: 1553,
      openPositions: 1,
      slotTargetAmount: 600,
      latestDate: "2026-10-09",
    },
  };
  value.newActualPools = {
    KRW: {
      currency: "KRW",
      fundingStatus: "PENDING",
      netContributions: null,
      cash: null,
      openPositions: 0,
      assetPositions: { KR: 0, US: 0, ETF: 0 },
    },
    USD: {
      currency: "USD",
      fundingStatus: "CONFIRMED",
      netContributions: "20000",
      cash: "15000",
      openPositions: 2,
      assetPositions: { KR: 0, US: 2, ETF: 0 },
    },
  };
  const before = structuredClone(value);
  const html = renderToStaticMarkup(<UsDashboardPortfolio query={query(value)} />);
  expect(html).toContain("2종목");
  expect(html).toContain("$20,000.00");
  expect(html).toContain("$15,000.00");
  expect(html).not.toContain("$12,000.00");
  expect(html).not.toContain("1종목");
  expect(html).not.toContain("10월 12일 신규 운용 구간");
  for (const text of ["실현손익", "평가손익", "87,654", "98,765", "186,419"])
    expect(html).not.toContain(text);
  expect(value).toEqual(before);
});

describe("dashboard restart-only controls and missing funding", () => {
  it("does not offer manual ETF membership as a new holding source", () => {
    const html = renderCounts(data(0, 0));
    expect(html).not.toContain("ETF 보유종목 등록·수정");
    expect(html).not.toContain("ETF 실제 보유종목 코드");
    expect(html).not.toContain("신규 운용은 2026-10-12 신호부터");
  });
  it("shows an unfunded empty new pool explicitly without inventing old capital", () => {
    const value = data(0, 0);
    value.newActualPools = {
      KRW: {
        currency: "KRW",
        fundingStatus: "PENDING",
        netContributions: null,
        cash: null,
        openPositions: 0,
        assetPositions: { KR: 0, US: 0, ETF: 0 },
      },
      USD: {
        currency: "USD",
        fundingStatus: "PENDING",
        netContributions: null,
        cash: null,
        openPositions: 0,
        assetPositions: { KR: 0, US: 0, ETF: 0 },
      },
    };
    const html = renderToStaticMarkup(<UsDashboardPortfolio query={query(value)} />);
    expect(html).toContain("0종목");
    expect(html).toContain("자금 확인 대기");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("기존 원장 가격");
  });
});

it("does not fall back to legacy US counts when a cached response lacks new-series metadata", () => {
  const value = data(0, 0);
  value.usPortfolio = {
    capital: 12345,
    unpricedPositions: 0,
    summary: { openPositions: 19 },
  } as DashboardOperations["usPortfolio"];
  const html = renderToStaticMarkup(<UsDashboardPortfolio query={query(value)} />);
  expect(html).toContain("미확인");
  expect(html).not.toContain("19종목");
  expect(html).not.toContain("$12,345.00");
});

describe("actual action context remains separate from entry evidence", () => {
  it("shows held, consumed and unknown conditions without claiming executable orders", () => {
    state.tab = "conditions";
    const value = data(0, 0);
    const kr = value.markets[0]!;
    kr.conditions = [
      {
        ...signal("KOSPI", 1, "held-condition"),
        actualState: "HELD",
        reason: "실제 보유 중",
        actualQuantity: 0.00001,
        actualEntryDate: "2026-10-12",
        signalOriginDate: "2026-10-13",
      },
      {
        ...signal("KOSPI", 2, "consumed-condition"),
        actualState: "CONSUMED",
        reason: "새 원신호 대기",
      },
      {
        ...signal("KOSPI", 3, "unknown-condition"),
        actualState: "UNKNOWN",
        reason: "실제 보유정보 미확인",
      },
    ];
    kr.conditionCount = 3;
    kr.onsets = [];
    kr.onsetCount = 0;
    const html = renderList(value);
    expect(html).toContain("held-condition");
    expect(html).toContain("consumed-condition");
    expect(html).toContain("unknown-condition");
    expect(html).toContain("0.00001");
    expect(html).toContain("2026-10-12");
    expect(html).toContain("원신호 2026-10-13");
    state.tab = "onsets";
    const actual = renderList(value);
    expect(actual).not.toContain("held-condition");
    expect(actual).not.toContain("consumed-condition");
    expect(actual).not.toContain("unknown-condition");
  });
});

it("uses one actual-account dashboard vocabulary without changing source records", () => {
  const value = data(0, 0);
  value.warnings = ["신규 운용은 2026-10-12 신호부터 시작합니다."];
  const before = structuredClone(value);
  const html =
    renderCounts(value) + renderToStaticMarkup(<UsDashboardPortfolio query={query(value)} />);
  expect(html).not.toContain("신규");
  expect(html).toContain("운용은 2026-10-12 신호부터 시작합니다.");
  expect(html).toContain("순입금");
  expect(html).toContain("현금");
  expect(value).toEqual(before);
});

describe("ETF current-data count display", () => {
  it("shows 17 data-unconfirmed separately from one confirmation wait", () => {
    const value = data(0, 1);
    value.markets.find((m) => m.market === "ETF")!.dataUnconfirmedCount = 17;
    const html = renderCounts(value);
    expect(html).toContain("ETF 자료 확인");
    expect(html).toContain(">17종목</span>");
    expect(html).toContain(">0/1</span>");
  });
  it("shows observed zero but keeps missing optional or owner data unknown", () => {
    const value = data(0, 0);
    expect(renderCounts(value)).toMatch(/ETF 자료 확인<\/span><span[^>]*>미확인/);
    value.markets.find((m) => m.market === "ETF")!.dataUnconfirmedCount = 0;
    expect(renderCounts(value)).toMatch(/ETF 자료 확인<\/span><span[^>]*>0종목/);
    expect(renderCounts(undefined)).toMatch(/ETF 자료 확인<\/span><span[^>]*>미확인/);
  });
});
