import { readFileSync } from "node:fs";
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { NewActualPortfolioResponse } from "@/lib/newActualPortfolio.functions";

type ButtonProps = {
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  role?: string;
  "aria-selected"?: boolean;
};
const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateCursor: 0,
  refCursor: 0,
  buttons: [] as ButtonProps[],
  submit: undefined as undefined | ((event: { preventDefault: () => void }) => void),
  dialogChange: undefined as undefined | ((open: boolean) => void),
  client: null as unknown as QueryClient,
  queryOptions: null as unknown as Record<string, unknown>,
  refetch: null as unknown as () => Promise<{ isError: boolean }>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = harness.stateCursor++;
    if (!(i in harness.states))
      harness.states[i] = typeof initial === "function" ? initial() : initial;
    return [
      harness.states[i],
      (value: unknown) => {
        harness.states[i] = typeof value === "function" ? value(harness.states[i]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = harness.refCursor++;
    return harness.refs[i] ?? (harness.refs[i] = { current: initial });
  },
  useEffect: () => undefined,
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => harness.client,
  useQuery: (options: { queryKey: string[] }) => {
    harness.queryOptions = options;
    return {
      data: harness.client.getQueryData(options.queryKey),
      isPending: false,
      isFetching: false,
      error: null,
      refetch: harness.refetch,
    };
  },
}));
vi.mock("@/lib/cloud", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "synthetic-test-token", user: { id: "test-owner" } } },
        error: null,
      })),
    },
  },
}));
vi.mock("@/lib/newActualPortfolio.functions", () => ({ newActualPortfolioServer: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("./AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("./OperatingCapitalPlan", () => ({
  OperatingCapitalPlan: ({ editable }: { editable: boolean }) => (
    <section>운용계획 {editable ? "편집 가능" : "읽기 전용"}</section>
  ),
}));
vi.mock("./ui/button", () => ({
  Button: (props: ButtonProps) => {
    harness.buttons.push(props);
    return (
      <button disabled={props.disabled} role={props.role} aria-selected={props["aria-selected"]}>
        {props.children}
      </button>
    );
  },
}));
vi.mock("./ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    harness.dialogChange = onOpenChange;
    return open ? <aside>{children}</aside> : null;
  },
  DialogContent: ({ children }: { children: ReactNode }) => {
    for (const child of React.Children.toArray(children))
      if (
        React.isValidElement<{ onSubmit?: typeof harness.submit }>(child) &&
        child.type === "form"
      )
        harness.submit = child.props.onSubmit;
    return <div>{children}</div>;
  },
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

import {
  NewActualPortfolioContent,
  NewActualPortfolio,
  newActualMarketDay,
} from "./NewActualPortfolio";
import { PortfolioAssetHub } from "./PortfolioAssetHub";
import { newActualPortfolioServer } from "@/lib/newActualPortfolio.functions";

function pending(): NewActualPortfolioResponse {
  const pool = (currency: "KRW" | "USD") => ({
    currency,
    fundingStatus: "PENDING" as const,
    netContributions: null,
    cash: null,
    marketValue: null,
    nav: null,
    realizedPnl: "0",
    unrealizedPnl: null,
    totalPnl: null,
    returnPercent: null,
    issues: ["funding_pending"],
    positions: [],
    trades: [],
    cashEvents: [],
  });
  return {
    domesticRevision: 7,
    usRevision: 11,
    pools: { KRW: pool("KRW"), USD: pool("USD") },
    warnings: [],
  };
}
function confirmed(): NewActualPortfolioResponse {
  const data = pending();
  data.pools.KRW = {
    currency: "KRW",
    fundingStatus: "CONFIRMED",
    netContributions: "1000",
    cash: "800",
    marketValue: "240",
    nav: "1040",
    realizedPnl: "0",
    unrealizedPnl: "40",
    totalPnl: "40",
    returnPercent: "4",
    issues: [],
    positions: [
      {
        symbol: "000001",
        name: "신규 한국 합성 종목",
        market: "KOSPI",
        asset: "KR",
        quantity: "1",
        cost: "100",
        averagePrice: "100",
        currentPrice: "120",
        priceDate: "2026-10-12",
        marketValue: "120",
        unrealizedPnl: "20",
      },
      {
        symbol: "000002",
        name: "신규 ETF 합성 종목",
        market: "ETF",
        asset: "ETF",
        quantity: "1",
        cost: "100",
        averagePrice: "100",
        currentPrice: "120",
        priceDate: "2026-10-12",
        marketValue: "120",
        unrealizedPnl: "20",
      },
    ],
    trades: [
      {
        execution: {
          id: "trade-1",
          symbol: "000001",
          name: "신규 한국 합성 종목",
          market: "KOSPI",
          side: "BUY",
          date: "2026-10-12",
          price: 100,
          shares: 2,
          fee: 0,
          note: "",
          order: 1,
          signalKey: null,
        },
        allocation: {
          executionId: "trade-1",
          quantity: 1,
          gross: 100,
          fee: 0,
          brokerReference: "synthetic-broker-fill",
        },
        realizedPnl: null,
      },
    ],
    cashEvents: [
      {
        id: "cash-1",
        date: "2026-10-12",
        kind: "DEPOSIT",
        amount: 1000,
        reference: "synthetic-capital-allocation",
      },
    ],
  };
  return data;
}
function render(element: ReactNode) {
  harness.stateCursor = 0;
  harness.refCursor = 0;
  harness.buttons = [];
  harness.submit = undefined;
  return renderToStaticMarkup(element);
}
function button(text: string) {
  const found = harness.buttons.find((item) => item.children === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
const key = ["new-actual-portfolio", "test-owner"];
const server = vi.mocked(newActualPortfolioServer);
const tick = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function openExecution() {
  render(<NewActualPortfolio />);
  button("실제 체결 입력").onClick!();
  render(<NewActualPortfolio />);
}
function draft() {
  return harness.states[3] as Record<string, unknown>;
}
function completeExecution(overrides: Record<string, unknown> = {}) {
  harness.states[3] = {
    ...draft(),
    symbol: "000003",
    name: "합성 신규 종목",
    date: "2026-10-12",
    price: "0.1",
    shares: "3",
    fee: "0",
    brokerReference: "synthetic-fill-new",
    confirmed: true,
    ...overrides,
  };
  render(<NewActualPortfolio />);
}
function submit() {
  harness.submit!({ preventDefault: () => undefined });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T01:00:00Z"));
  harness.states = ["test-owner", true, "KR", null, false, null];
  harness.refs = [{ current: "test-owner" }];
  harness.client = new QueryClient();
  harness.client.setQueryData(key, pending());
  harness.refetch = vi.fn(async () => ({ isError: false }));
  server.mockReset();
  server.mockResolvedValue(pending());
});
afterEach(() => {
  harness.client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("new-only portfolio presentation", () => {
  it("shows pending/null values without fabricated capital or zero return", () => {
    const html = render(
      <NewActualPortfolioContent data={pending()} asset="KR" onAssetChange={() => undefined} />,
    );
    expect(html).toContain("실제 포트폴리오 · 2026-10-12 신규 운용분");
    expect(html).toContain("준비 중 · 실제 배정 현금 확정 대기");
    expect(html).toContain("등록된 신규 기록이 없습니다");
    expect(html).toContain("미확정");
    expect(html).toContain("USD 환율·배정 기준 미확정");
    expect(html).toContain("기록상 현금은 주문 가능 금액이 아님");
    expect(html).not.toMatch(/0(?:\.00)?%|30,000,000|30000000/);
  });
  it("hides cached data during loading/error, distinct from an empty confirmed load", () => {
    for (const props of [{ loading: true }, { error: "합성 조회 오류" }]) {
      const html = render(
        <NewActualPortfolioContent
          data={confirmed()}
          asset="KR"
          onAssetChange={() => undefined}
          {...props}
        />,
      );
      expect(html).not.toContain("신규 한국 합성 종목");
      expect(html).not.toContain("1,040 KRW");
      expect(html).not.toContain("등록된 신규 기록이 없습니다");
    }
  });
  it("renders confirmed native-currency figures, price dates and explicit allocated slices", () => {
    const html = render(
      <NewActualPortfolioContent data={confirmed()} asset="KR" onAssetChange={() => undefined} />,
    );
    expect(html).toContain("1,040 KRW");
    expect(html).toContain("4%");
    expect(html).toContain("가격 기준일 2026-10-12");
    expect(html).toContain("1 / 2");
    expect(html).toContain("synthetic-broker-fill");
    expect(html).toContain("synthetic-capital-allocation");
    expect(html).not.toContain("신규 ETF 합성 종목");
  });
  it("switches the new asset view while sharing KRW cash once", () => {
    const data = confirmed();
    const kr = render(
      <NewActualPortfolioContent data={data} asset="KR" onAssetChange={() => undefined} />,
    );
    const etf = render(
      <NewActualPortfolioContent data={data} asset="ETF" onAssetChange={() => undefined} />,
    );
    const us = render(
      <NewActualPortfolioContent data={data} asset="US" onAssetChange={() => undefined} />,
    );
    expect(kr).toContain('aria-labelledby="new-asset-KR"');
    expect(etf).toContain('aria-labelledby="new-asset-ETF"');
    expect(us).toContain('aria-labelledby="new-asset-US"');
    expect(etf).toContain("신규 ETF 합성 종목");
    expect(etf).not.toContain("신규 한국 합성 종목");
    expect(us).not.toContain("신규 한국 합성 종목");
    expect(etf.match(/synthetic-capital-allocation/g)).toHaveLength(1);
    expect(etf).toContain("한국·ETF 공동 원화 현금, 한 번만 입력");
  });
  it("excludes domestic legacy content and keeps the editable plan and Shadow link", () => {
    const html = render(<PortfolioAssetHub domestic={<p>LEGACY_DOMESTIC_SENTINEL</p>} />);
    expect(html).not.toContain("LEGACY_DOMESTIC_SENTINEL");
    expect(html).toContain("운용계획 편집 가능");
    expect(html).toContain('href="/shadow"');
    const source = readFileSync(new URL("./PortfolioAssetHub.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /UsPortfolioLedgers|ActualPerformanceReview|DomesticAssessmentPanel|ActualPerformancePanel|portfolioLedgersServer|signalRows/,
    );
  });
  it("aligns the displayed Shadow/actual start without old-ledger links or fabricated timing", () => {
    const html = render(<PortfolioAssetHub domestic={<p>OLD_START_2026_10_05</p>} />);
    expect(html).toContain("같은 2026-10-12를 비교 시작일");
    expect(html).toContain("실제 배정자금·체결일·가격·비용은 확인된 사실대로");
    expect(html).not.toContain("OLD_START_2026_10_05");
    expect(html).not.toContain("2026-10-05");
    expect(html).not.toContain('href="/us/portfolio"');
    expect(html).not.toContain("실제 성과 자료 대조·확정");
    expect(html).not.toContain("기존 원장 누적손익");
    const shadowSource = readFileSync(new URL("./ShadowPage.tsx", import.meta.url), "utf8");
    expect(shadowSource).toContain("2026-10-12 이후");
    expect(shadowSource).not.toContain("KospiShadowPanel");
    expect(shadowSource).not.toContain("UsPortfolioView");
  });
  it("keeps readable holdings when the write revision is unavailable", () => {
    const data = confirmed();
    data.domesticRevision = null;
    const html = render(
      <NewActualPortfolioContent
        data={data}
        asset="KR"
        onAssetChange={() => undefined}
        onExecution={() => undefined}
      />,
    );
    expect(html).toContain("신규 한국 합성 종목");
    expect(button("실제 체결 입력").disabled).toBe(true);
  });
  it("renders missing/stale evaluations and cash cancellations without invented totals", () => {
    const data = confirmed();
    data.pools.KRW.fundingStatus = "INCOMPLETE";
    data.pools.KRW.nav = null;
    data.pools.KRW.totalPnl = null;
    data.pools.KRW.returnPercent = null;
    data.pools.KRW.issues = ["stale_price:000001"];
    data.pools.KRW.cashEvents[0]!.voided = true;
    const html = render(
      <NewActualPortfolioContent data={data} asset="KR" onAssetChange={() => undefined} />,
    );
    expect(html).toContain("평가가격이 오래되어 평가 미확정 (000001)");
    expect(html).toContain("취소됨");
    expect(html).not.toContain("4%");
  });
  it("shows recorded realized profit while funding and aggregate returns remain unresolved", () => {
    const data = pending();
    data.pools.KRW.realizedPnl = "25";
    const html = render(
      <NewActualPortfolioContent data={data} asset="KR" onAssetChange={() => undefined} />,
    );
    expect(html).toContain("25 KRW");
    expect(html).toContain("준비 중 · 실제 배정 현금 확정 대기");
    expect(html).not.toMatch(/0(?:\.00)?%/);
  });
  it("formats arbitrary precision money without converting to binary numbers", () => {
    const data = confirmed();
    data.pools.KRW.nav = "999999999999999999.12345678";
    expect(
      render(<NewActualPortfolioContent data={data} asset="KR" onAssetChange={() => undefined} />),
    ).toContain("999,999,999,999,999,999.12345678 KRW");
  });
});

describe("new portfolio editor safety", () => {
  it("sends one write on same-tick double submit with opened revision and stable requestId", async () => {
    let resolve!: (value: NewActualPortfolioResponse) => void;
    server.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    openExecution();
    const opened = { ...draft() };
    completeExecution();
    const newer = pending();
    newer.domesticRevision = 20;
    harness.client.setQueryData(key, newer);
    submit();
    submit();
    await tick();
    expect(server).toHaveBeenCalledTimes(1);
    expect(server.mock.calls[0]![0]!.data).toMatchObject({
      action: "execution",
      expectedRevision: 7,
      requestId: opened["requestId"],
      execution: { id: "", price: 0.1, shares: 3 },
      allocation: { quantity: 3, gross: 0.3, fee: 0 },
      confirmed: true,
    });
    harness.dialogChange!(false);
    expect(harness.states[3]).not.toBeNull();
    resolve(pending());
    await tick();
    expect(harness.states[3]).toBeNull();
  });
  it("requires explicit reload AND reopening after a lost response, never replaying automatically", async () => {
    server.mockRejectedValueOnce(new Error("synthetic lost response"));
    openExecution();
    completeExecution();
    const firstId = draft()["requestId"];
    submit();
    await tick();
    render(<NewActualPortfolio />);
    expect(draft()["needsReview"]).toBe(true);
    expect(button("확인한 내용 저장").disabled).toBe(true);
    submit();
    await tick();
    expect(server).toHaveBeenCalledTimes(1);
    button("최신 기록 새로고침").onClick!();
    await tick();
    render(<NewActualPortfolio />);
    expect(button("확인한 내용 저장").disabled).toBe(true);
    expect(draft()["requestId"]).toBe(firstId);
    button("닫기").onClick!();
    render(<NewActualPortfolio />);
    button("실제 체결 입력").onClick!();
    expect(draft()["needsReview"]).toBe(false);
    expect(draft()["requestId"]).not.toBe(firstId);
  });
  it("does not permit a new draft after an unsuccessful reload", async () => {
    server.mockRejectedValueOnce(new Error("uncertain"));
    openExecution();
    completeExecution();
    submit();
    await tick();
    render(<NewActualPortfolio />);
    harness.refetch = vi.fn(async () => ({ isError: true }));
    render(<NewActualPortfolio />);
    button("최신 기록 새로고침").onClick!();
    await tick();
    button("닫기").onClick!();
    render(<NewActualPortfolio />);
    expect(button("실제 체결 입력").disabled).toBe(true);
  });
  it("requires explicit actual-fill confirmation and rejects past/future dates", async () => {
    openExecution();
    completeExecution({ confirmed: false });
    submit();
    await tick();
    expect(server).not.toHaveBeenCalled();
    for (const date of ["2026-10-09", "2026-10-14"]) {
      completeExecution({ date });
      submit();
      await tick();
    }
    expect(server).not.toHaveBeenCalled();
  });
  it("requires a source reference and rejects blank or overallocated mixed portions", async () => {
    openExecution();
    for (const overrides of [
      { brokerReference: "" },
      { mixed: true, quantity: "", gross: "", allocatedFee: "" },
      { mixed: true, quantity: "4", gross: "0.4", allocatedFee: "0" },
    ]) {
      completeExecution(overrides);
      submit();
      await tick();
    }
    expect(server).not.toHaveBeenCalled();
  });
  it("stores explicit mixed allocation while keeping the entire canonical fill", async () => {
    openExecution();
    completeExecution({ mixed: true, quantity: "1", gross: "0.1", allocatedFee: "0" });
    submit();
    await tick();
    expect(server.mock.calls[0]![0]!.data).toMatchObject({
      execution: { shares: 3, price: 0.1 },
      allocation: { quantity: 1, gross: 0.1, fee: 0 },
    });
  });
  it("preserves identity when editing an existing original fill", async () => {
    harness.client.setQueryData(key, confirmed());
    render(<NewActualPortfolio />);
    button("정정").onClick!();
    const html = render(<NewActualPortfolio />);
    expect(draft()).toMatchObject({
      id: "trade-1",
      symbol: "000001",
      market: "KOSPI",
      mixed: true,
    });
    expect(html).toMatch(/disabled=""[^>]*value="000001"|value="000001"[^>]*disabled=""/);
    completeExecution({
      symbol: "000001",
      shares: "2",
      price: "100",
      quantity: "1",
      gross: "100",
      allocatedFee: "0",
    });
    submit();
    await tick();
    expect(server.mock.calls[0]![0]!.data).toMatchObject({
      execution: { id: "trade-1", symbol: "000001", market: "KOSPI" },
    });
  });
  it("protects original mixed-fill economic fields while allowing explicit allocation correction", () => {
    harness.client.setQueryData(key, confirmed());
    render(<NewActualPortfolio />);
    button("정정").onClick!();
    const html = render(<NewActualPortfolio />);
    expect(draft()).toMatchObject({ originalMixed: true, mixed: true });
    expect(html).toContain("혼합 체결 원본은 보호됩니다");
    for (const label of [
      "체결 구분",
      "실제 체결일",
      "원체결 단가",
      "원체결 전체 수량",
      "원체결 전체 비용",
    ]) {
      const start = html.indexOf(label);
      const field = html.slice(start, html.indexOf("</label>", start));
      expect(field).toContain('disabled=""');
    }
    const start = html.indexOf("신규 배정 수량</span>");
    expect(html.slice(start, html.indexOf("</label>", start))).not.toContain('disabled=""');
    expect(html).toContain("당일 평가가격이 없는 휴장일·장 시작 전에는 평가 대기");
  });
  it("starts cash input empty and sends one real shared-KRW event after confirmation", async () => {
    render(<NewActualPortfolio />);
    const cash = harness.buttons.find((b) => Array.isArray(b.children) && b.children[0] === "KRW");
    cash!.onClick!();
    render(<NewActualPortfolio />);
    expect(draft()).toMatchObject({
      kind: "cash",
      currency: "KRW",
      amount: "",
      confirmed: false,
      expectedRevision: 7,
    });
    harness.states[3] = {
      ...draft(),
      date: "2026-10-12",
      amount: "1250",
      reference: "synthetic-real-cash",
      confirmed: true,
    };
    render(<NewActualPortfolio />);
    submit();
    submit();
    await tick();
    expect(server).toHaveBeenCalledTimes(1);
    expect(server.mock.calls[0]![0]!.data).toMatchObject({
      action: "cash",
      currency: "KRW",
      event: { id: "", amount: 1250, kind: "DEPOSIT" },
      confirmed: true,
    });
  });
  it("requires native confirmation before cancel and never creates a simulated sale", async () => {
    harness.client.setQueryData(key, confirmed());
    render(<NewActualPortfolio />);
    button("기록 취소").onClick!();
    harness.states[3] = { ...draft(), reason: "synthetic correction" };
    render(<NewActualPortfolio />);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    submit();
    await tick();
    expect(server).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    submit();
    await tick();
    expect(server.mock.calls[0]![0]!.data).toMatchObject({
      action: "cancelExecution",
      executionId: "trade-1",
      reason: "synthetic correction",
    });
    expect(server.mock.calls[0]![0]!.data).not.toHaveProperty("execution");
  });
  it("confirms a same-tick repeated cancellation only once", async () => {
    harness.client.setQueryData(key, confirmed());
    render(<NewActualPortfolio />);
    button("기록 취소").onClick!();
    harness.states[3] = { ...draft(), reason: "synthetic cancellation" };
    render(<NewActualPortfolio />);
    const confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm });
    submit();
    submit();
    await tick();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(server).toHaveBeenCalledTimes(1);
  });
  it("keeps USD cash correction currency and id, then cancels without a withdrawal", async () => {
    const data = pending();
    data.pools.USD.cashEvents = [
      {
        id: "usd-cash",
        date: "2026-10-12",
        kind: "DEPOSIT",
        amount: 25,
        reference: "synthetic-usd",
      },
    ];
    harness.client.setQueryData(key, data);
    render(<NewActualPortfolio />);
    button("정정").onClick!();
    render(<NewActualPortfolio />);
    expect(draft()).toMatchObject({
      kind: "cash",
      currency: "USD",
      id: "usd-cash",
      amount: "25",
      expectedRevision: 11,
    });
    harness.states[3] = { ...draft(), amount: "20", confirmed: true };
    render(<NewActualPortfolio />);
    server.mockResolvedValue(data);
    submit();
    await tick();
    expect(server.mock.calls[0]![0]!.data).toMatchObject({
      action: "cash",
      currency: "USD",
      event: { id: "usd-cash", amount: 20 },
    });
    render(<NewActualPortfolio />);
    button("기록 취소").onClick!();
    harness.states[3] = { ...draft(), reason: "synthetic cash correction" };
    render(<NewActualPortfolio />);
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });
    submit();
    await tick();
    expect(server.mock.calls[1]![0]!.data).toMatchObject({
      action: "cancelCash",
      currency: "USD",
      eventId: "usd-cash",
    });
    expect(server.mock.calls[1]![0]!.data).not.toHaveProperty("event");
  });
  it("does not save from navigation, close or explicit read refresh", async () => {
    render(<NewActualPortfolio />);
    button("미국주식").onClick!();
    render(<NewActualPortfolio />);
    button("실제 체결 입력").onClick!();
    render(<NewActualPortfolio />);
    expect(draft()).toMatchObject({ asset: "US", market: "US" });
    button("닫기").onClick!();
    render(<NewActualPortfolio />);
    button("새로고침").onClick!();
    await tick();
    expect(harness.refetch).toHaveBeenCalledTimes(1);
    expect(server).not.toHaveBeenCalled();
  });
  it("rejects unconfirmed and future cash without inventing starting funds", async () => {
    render(<NewActualPortfolio />);
    harness.buttons.find((b) => Array.isArray(b.children) && b.children[0] === "KRW")!.onClick!();
    harness.states[3] = {
      ...draft(),
      amount: "1000",
      reference: "synthetic-real-cash",
      confirmed: false,
    };
    render(<NewActualPortfolio />);
    submit();
    await tick();
    harness.states[3] = { ...draft(), date: "2026-10-14", confirmed: true };
    render(<NewActualPortfolio />);
    submit();
    await tick();
    expect(server).not.toHaveBeenCalled();
  });
  it("retains a declined cancellation form for review", async () => {
    harness.client.setQueryData(key, confirmed());
    render(<NewActualPortfolio />);
    button("기록 취소").onClick!();
    harness.states[3] = { ...draft(), reason: "synthetic cancellation" };
    const original = { ...draft() };
    render(<NewActualPortfolio />);
    vi.stubGlobal("window", { confirm: vi.fn(() => false) });
    submit();
    await tick();
    expect(draft()).toEqual(original);
    expect(server).not.toHaveBeenCalled();
  });
  it("ignores a completed write after owner change without replacing the new draft", async () => {
    let resolve!: (value: NewActualPortfolioResponse) => void;
    server.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    openExecution();
    completeExecution();
    submit();
    await tick();
    harness.refs[0]!.current = "different-owner";
    harness.states[0] = "different-owner";
    const otherDraft = { owner: "different-owner", requestId: "another-draft" };
    harness.states[3] = otherDraft;
    resolve(confirmed());
    await tick();
    expect(harness.states[3]).toBe(otherDraft);
    expect(
      harness.client.getQueryData<NewActualPortfolioResponse>(key)?.pools.KRW.fundingStatus,
    ).toBe("PENDING");
  });
  it("uses market-local date boundaries and disables automatic reads/retries", () => {
    const instant = new Date("2026-10-12T00:30:00Z");
    expect(newActualMarketDay("KRW", instant)).toBe("2026-10-12");
    expect(newActualMarketDay("USD", instant)).toBe("2026-10-11");
    render(<NewActualPortfolio />);
    expect(harness.queryOptions).toMatchObject({
      queryKey: key,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      gcTime: 0,
    });
  });
});
