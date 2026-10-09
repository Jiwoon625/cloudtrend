import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KoreaPortfolioContent } from "@/routes/portfolio";
import { calculateActual, type DualPortfolioState } from "@/lib/portfolioLedgers";
import { portfolioLedgersServer } from "@/lib/portfolioLedgers.functions";
import { PORTFOLIO_SYNC_TIMEOUT_MS } from "@/lib/portfolioSyncRequest";
import { toast } from "sonner";

type ButtonProps = { children?: ReactNode; disabled?: boolean; onClick?: () => unknown };
const harness = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateCursor: 0,
  refCursor: 0,
  buttons: [] as ButtonProps[],
  client: null as unknown as QueryClient,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = harness.stateCursor++;
    if (!(i in harness.states)) harness.states[i] = initial;
    return [
      harness.states[i],
      (value: unknown) => {
        harness.states[i] = value;
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
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: harness.client.getQueryData(queryKey),
    error: null,
    isFetching: false,
    isPending: false,
    refetch: vi.fn(async () => ({ isError: false })),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/cloud", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "synthetic-token" } },
        error: null,
      }),
    },
  },
}));
vi.mock("@/lib/portfolioLedgers.functions", () => ({
  portfolioLedgersServer: vi.fn(),
  portfolioPositionContextServer: vi.fn(),
}));
vi.mock("@/components/PortfolioAssetHub", () => ({ PortfolioAssetHub: () => null }));
vi.mock("@/components/StrategyDescription", () => ({ StrategyDescription: () => null }));
vi.mock("@/components/ui/button", () => ({
  Button: (props: ButtonProps) => {
    harness.buttons.push(props);
    return <button disabled={props.disabled}>{props.children}</button>;
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function fixture(): DualPortfolioState {
  const actual = calculateActual(100000, [], {}, null);
  return {
    revision: 2,
    actual,
    document: {
      version: 3,
      settings: {
        initialCapital: 100000,
        maxPositions: 30,
        sectorCap: 0.3,
        roundTripCostRate: 0.003,
      },
      actualCapital: 100000,
      executions: [],
      excluded: {},
      migratedAt: "2026-10-06T00:00:00Z",
      strategy: {
        candidates: [
          {
            key: "SYNTH_A|2026-10-06",
            symbol: "SYNTH_A",
            name: "검증 종목 A",
            market: "KOSDAQ",
            sectorCode: "TEST",
            sectorName: "검증 섹터",
            signalDate: "2026-10-06",
            entryDate: null,
            price: null,
            technical: 8,
            priority: 5,
            decision: "다음 거래일 대기",
          },
        ],
        trades: [],
        summary: actual.summary,
        quotes: {},
        firstSignalDate: "2026-10-06",
        calculatedAt: "2026-10-07T00:00:00Z",
        fingerprint: "synthetic-fixture",
      },
    },
  };
}
function render() {
  harness.stateCursor = 0;
  harness.refCursor = 0;
  harness.buttons = [];
  return renderToStaticMarkup(<KoreaPortfolioContent />);
}
function button(label: string) {
  const found = harness.buttons.find((props) =>
    React.Children.toArray(props.children).includes(label),
  );
  expect(found).toBeTruthy();
  return found!;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T00:30:00Z"));
  harness.states = [];
  harness.refs = [];
  harness.client = new QueryClient();
  harness.client.setQueryData(["portfolio-ledgers"], fixture());
  vi.mocked(portfolioLedgersServer).mockResolvedValue(fixture());
});
afterEach(() => {
  harness.client.clear();
  vi.useRealTimers();
});

describe("KR portfolio pending-entry and sync presentation", () => {
  it("shows today's scheduled entry above the actual holdings without manufacturing a holding", () => {
    const html = render();
    expect(html).toContain("전략 진입 예정 · 1건 (오늘 1건)");
    expect(html).toContain("오늘 진입 예정 · 시가 미확인");
    expect(html).toContain("2026-10-07");
    expect(html).toContain("이 신호의 실제 체결 미기록");
    expect(html).toContain("실제 보유 종목 · 0 / 30");
    expect(html).toContain("전략 보유·현금과 실제 체결에는 반영하지 않습니다");
    expect(portfolioLedgersServer).not.toHaveBeenCalled();
  });

  it("does not label an uncovered date as today's scheduled entry", () => {
    const state = fixture();
    state.document.strategy!.candidates[0]!.signalDate = "2027-01-04";
    harness.client.setQueryData(["portfolio-ledgers"], state);
    const html = render();
    expect(html).toContain("미확인 · 거래일 자료 없음");
    expect(html).toContain("거래일 확인 필요");
    expect(html).toContain("오늘 0건");
    expect(html).not.toContain("오늘 진입 예정 · 시가 미확인");
  });

  it("labels a linked actual fill separately while the model entry remains pending", () => {
    const state = fixture();
    state.document.executions = [
      {
        id: "synthetic-buy",
        symbol: "SYNTH_A",
        name: "검증 종목 A",
        market: "KOSDAQ",
        signalKey: "SYNTH_A|2026-10-06",
        side: "BUY",
        date: "2026-10-07",
        price: 100,
        shares: 3,
        fee: 0,
        note: "",
        order: 0,
      },
    ];
    state.actual = calculateActual(100000, state.document.executions, {}, null);
    harness.client.setQueryData(["portfolio-ledgers"], state);
    const html = render();
    expect(html).toContain("실제 체결 기록 있음");
    expect(html).toContain("오늘 진입 예정 · 시가 미확인");
    expect(html).toContain("실제 보유 종목 · 1 / 30");
    expect(html).not.toContain(">전략 원장<");
    expect(html).toContain("Shadow");
  });

  it("shows the explicit sync busy state and blocks same-tick repeat clicks", async () => {
    let finish!: (state: DualPortfolioState) => void;
    vi.mocked(portfolioLedgersServer).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render();
    const sync = button("전략·시세 동기화");
    sync.onClick!();
    sync.onClick!();
    await vi.advanceTimersByTimeAsync(0);
    expect(portfolioLedgersServer).toHaveBeenCalledTimes(1);
    const busy = render();
    expect(busy).toContain('role="status"');
    expect(busy).toContain("입력이 바뀐 경우 첫 갱신은 시간이 걸릴 수 있습니다");
    expect(busy).toContain("animate-spin");
    expect(button("전략·시세 동기화 중…").disabled).toBe(true);
    const completed = fixture();
    completed.document.strategy!.summary.latestDate = "2026-10-06";
    completed.document.strategy!.calculatedAt = "2026-10-07T00:30:00Z";
    finish(completed);
    await vi.advanceTimersByTimeAsync(0);
    const done = render();
    expect(done).not.toContain('role="status"');
    expect(done).toContain("전략 계산");
    expect(done).toContain("09:30:00 KST");
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("데이터 기준 2026-10-06"));
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("09:30:00 KST"));
    expect(button("전략·시세 동기화").disabled).toBe(false);
  });

  it("ends the sync spinner with an uncertain-result reload message and never retries the request", async () => {
    vi.mocked(portfolioLedgersServer).mockImplementation(() => new Promise(() => undefined));
    render();
    button("전략·시세 동기화").onClick!();
    await vi.advanceTimersByTimeAsync(PORTFOLIO_SYNC_TIMEOUT_MS + 1);
    const html = render();
    expect(html).not.toContain('role="status"');
    expect(html).toContain("서버 작업은 계속될 수 있으므로");
    expect(html).toContain("원장을 새로고침해 결과를 확인해 주세요");
    expect(button("전략·시세 동기화").disabled).toBe(true);
    button("전략·시세 동기화").onClick!();
    await vi.advanceTimersByTimeAsync(0);
    expect(portfolioLedgersServer).toHaveBeenCalledTimes(1);
    expect(html).toContain("실제 보유 종목 · 0 / 30");
  });
});
